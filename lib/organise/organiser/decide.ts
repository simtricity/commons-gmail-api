/**
 * The local stages: decide, score, explain, find and runs. They read the run's
 * stored files only, so they are free to re-run after any change.
 *
 * @module
 */

import { resolve } from "@std/path";
import { score as scoreCases, type ScoreResult } from "../golden.ts";
import type { OrganiseMessage } from "../message.ts";
import { parsePolicy } from "../policy.ts";
import type { StoredAnswers } from "../questions.ts";
import { Relationships } from "../relationships.ts";
import type { SchemeDecision } from "../scheme.ts";
import { factsOf, mergeThresholds } from "../triage/decide.ts";
import type { Corpus } from "../types.ts";
import { isoNow, nowOf, say, schemeOf, schemesOf, type StageContext } from "./context.ts";
import { type MessagesFile, updateManifest } from "./fetch.ts";
import { readJson, readJsonOr, safeName, writeJson } from "./store.ts";
import type { DecideSummary, DecisionsFile, Explanation, Manifest } from "./types.ts";

async function relationshipsOf(ctx: StageContext): Promise<Relationships> {
  const path = resolve(ctx.dataDir, ctx.profile.corpus);
  // fallback: without a corpus nobody is known yet; decisions still run, protecting no one.
  const corpus = await readJsonOr<Corpus | null>(path, null);
  if (!corpus) say(ctx, `no corpus at ${ctx.profile.corpus}: no sender is treated as known`);
  return new Relationships(corpus ?? { correspondents: [] }, ctx.profile.relationships);
}

async function stored(ctx: StageContext, run: string) {
  const files = ctx.files.run(run);
  const { messages } = await readJson<MessagesFile>(files.messages);
  const answers = new Map(
    (await readJsonOr<StoredAnswers[]>(files.answers, [])).map((a) => [a.id, a]),
  );
  return { messages, answers };
}

/**
 * Decide every fetched message under each chosen scheme (default: all), at
 * `now` (default: the injected clock). Writes `decisions.<scheme>.json` and
 * reports what moved since the last decide of that scheme.
 */
export async function decide(
  ctx: StageContext,
  o: { run: string; schemes?: string[]; now?: number },
): Promise<Record<string, DecideSummary>> {
  const run = safeName("run", o.run);
  const now = o.now ?? nowOf(ctx);
  if (!Number.isFinite(now)) throw new TypeError("now must be ms since epoch");
  const relationships = await relationshipsOf(ctx);
  const { messages, answers } = await stored(ctx, run);
  const out: Record<string, DecideSummary> = {};

  for (const scheme of schemesOf(ctx, o.schemes)) {
    const path = ctx.files.run(run).decisions(scheme.id);
    const previous = await readJsonOr<DecisionsFile | null>(path, null);
    const decisions = messages.map((m) =>
      scheme.decide(m, answers.get(m.id)?.answers ?? {}, { now, relationships })
    );

    const counts = Object.fromEntries(scheme.categories.map((c) => [c, 0]));
    const routes: Record<string, Record<string, number>> = {};
    for (const d of decisions) {
      counts[d.category]++;
      routes[d.route] ??= {};
      routes[d.route][d.category] = (routes[d.route][d.category] ?? 0) + 1;
    }
    const before = new Map((previous?.decisions ?? []).map((d) => [d.id, d.category]));
    const moves: Record<string, string[]> = {};
    for (const d of decisions) {
      const was = before.get(d.id);
      if (was !== undefined && was !== d.category) {
        (moves[`${was} → ${d.category}`] ??= []).push(d.id);
      }
    }

    const file: DecisionsFile = {
      scheme: scheme.id,
      decidedAt: isoNow(ctx),
      now: new Date(now).toISOString(),
      decisions,
    };
    await writeJson(path, file);
    await updateManifest(ctx, run, (m): Manifest => ({
      ...m,
      decide: { ...m.decide, [scheme.id]: { at: file.decidedAt, now: file.now, counts } },
    }));
    out[scheme.id] = { scheme: scheme.id, counts, routes, moves, splits: splitsOf(decisions) };
    say(ctx, `decide ${run} ${scheme.id}: ${decisions.length} decided`);
  }
  return out;
}

/** Senders whose messages got more than one category: candidates for a sender ruling. */
function splitsOf(decisions: readonly SchemeDecision[]): DecideSummary["splits"] {
  const by = new Map<string, Record<string, number>>();
  for (const d of decisions) {
    const c = by.get(d.sender) ?? {};
    c[d.category] = (c[d.category] ?? 0) + 1;
    by.set(d.sender, c);
  }
  return [...by]
    .filter(([, c]) => Object.keys(c).length > 1)
    .map(([sender, categories]) => ({
      sender,
      total: Object.values(categories).reduce((a, b) => a + b, 0),
      categories,
    }))
    .sort((a, b) => b.total - a.total || a.sender.localeCompare(b.sender));
}

/** A run's stored decisions for one scheme. */
export async function decisionsOf(
  ctx: StageContext,
  run: string,
  scheme: string,
): Promise<DecisionsFile> {
  schemeOf(ctx, scheme);
  return await readJson<DecisionsFile>(ctx.files.run(safeName("run", run)).decisions(scheme));
}

/** Score one scheme's stored decisions against its golden cases. */
export async function score(
  ctx: StageContext,
  o: { run: string; scheme: string },
): Promise<ScoreResult> {
  const { decisions } = await decisionsOf(ctx, o.run, o.scheme);
  return scoreCases(ctx.golden, decisions, o.scheme);
}

/** The facts, answers and decision behind one message's category. */
export async function explain(
  ctx: StageContext,
  o: { run: string; id: string; scheme: string },
): Promise<Explanation> {
  const file = await decisionsOf(ctx, o.run, o.scheme);
  const decision = file.decisions.find((d) => d.id === o.id);
  const { messages, answers } = await stored(ctx, o.run);
  const msg = messages.find((m) => m.id === o.id);
  if (!decision || !msg) throw new Error(`message ${o.id} is not decided in run ${o.run}`);
  const a = answers.get(o.id);
  const f = factsOf({
    id: msg.id,
    from: msg.state.from,
    subject: msg.state.subject,
    date: msg.state.date,
    internalDate: msg.internalDate,
    envelope: msg.envelope,
    answers: a?.answers ?? {},
  }, {
    policy: parsePolicy({}),
    relationships: await relationshipsOf(ctx),
    thresholds: mergeThresholds(),
    now: Date.parse(file.now),
  });
  return {
    id: msg.id,
    scheme: o.scheme,
    from: msg.state.from,
    subject: msg.state.subject,
    facts: {
      sender: f.sender,
      domain: f.domain,
      ageYears: f.ageYears,
      protection: f.protection,
      strength: f.strength,
      campaign: f.campaign,
      discussionList: f.discussionList,
    },
    answers: a?.answers ?? {},
    asked: a?.asked ?? {},
    decision,
  };
}

/** Run messages whose subject or From contains `text`, case-insensitively. */
export async function find(
  ctx: StageContext,
  o: { run: string; text: string },
): Promise<OrganiseMessage[]> {
  const needle = o.text.toLowerCase();
  const { messages } = await stored(ctx, safeName("run", o.run));
  return messages.filter((m) =>
    m.state.subject.toLowerCase().includes(needle) || m.state.from.toLowerCase().includes(needle)
  );
}

/** Every run's manifest, newest first. */
export async function runs(ctx: StageContext): Promise<Manifest[]> {
  const out: Manifest[] = [];
  try {
    for await (const e of Deno.readDir(ctx.files.runs)) {
      if (!e.isDirectory) continue;
      const m = await readJsonOr<Manifest | null>(ctx.files.run(e.name).manifest, null);
      if (m) out.push(m);
    }
  } catch (err) {
    // fallback: no runs directory yet means no runs.
    if (!(err instanceof Deno.errors.NotFound)) throw err;
  }
  return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id));
}
