/**
 * The judge stage: put every pending question to the decision model.
 *
 * @module
 */

import { pendingQuestions, questionHash, questionsFor, type StoredAnswers } from "../questions.ts";
import { pool } from "../throttle.ts";
import type { Question } from "../types.ts";
import { isoNow, say, schemesOf, type StageContext } from "./context.ts";
import { type MessagesFile, updateManifest } from "./fetch.ts";
import { readJson, readJsonOr, safeName, writeJson } from "./store.ts";
import type { JudgeSummary, Manifest } from "./types.ts";

/**
 * One model call per message, carrying every question of the chosen schemes
 * (default: all) that is unanswered or was asked under a different wording,
 * context or body cap. Rewording one question re-asks only it. `force` re-asks
 * everything. Resumable; progress is saved every 100 messages.
 *
 * Every pass that asked something is appended to the manifest's `judge.passes`,
 * and the totals are summed over passes. Cost is reported only when the profile
 * gives a price.
 */
export async function judge(
  ctx: StageContext,
  o: { run: string; schemes?: string[]; force?: boolean; concurrency?: number },
): Promise<JudgeSummary> {
  const client = ctx.io.judge;
  if (!client) throw new TypeError("judge needs a decision model: pass io.judge");
  const run = safeName("run", o.run);
  const files = ctx.files.run(run);
  const all = questionsFor(schemesOf(ctx, o.schemes));
  const shape = { context: ctx.profile.context, bodyChars: ctx.profile.bodyChars };
  const hashes: Record<string, string> = {};
  for (const [id, q] of Object.entries(all)) hashes[id] = await questionHash(q, shape);

  const { messages } = await readJson<MessagesFile>(files.messages);
  const byId = new Map(
    (await readJsonOr<StoredAnswers[]>(files.answers, [])).map((a) => [a.id, a]),
  );
  const todo = messages
    .map((m) => ({ m, ask: o.force ? Object.keys(all) : pendingQuestions(byId.get(m.id), hashes) }))
    .filter((t) => t.ask.length);
  say(ctx, `judge ${run}: ${todo.length} of ${messages.length} messages have questions pending`);

  let tokens = 0;
  let failures = 0;
  let answered = 0;
  let model = "";
  const asked = new Set<string>();
  const save = () => writeJson(files.answers, [...byId.values()]);
  await pool(todo, o.concurrency ?? 8, async ({ m, ask }) => {
    const questions: Record<string, Question> = Object.fromEntries(ask.map((q) => [q, all[q]]));
    const res = await client.ask({ ...m.state, context: ctx.profile.context }, questions);
    const prior = byId.get(m.id) ?? { id: m.id, answers: {}, asked: {} };
    const got = ask.filter((q) => res.answers[q]);
    byId.set(m.id, {
      id: m.id,
      answers: { ...prior.answers, ...Object.fromEntries(got.map((q) => [q, res.answers[q]])) },
      asked: { ...prior.asked, ...Object.fromEntries(got.map((q) => [q, hashes[q]])) },
    });
    for (const q of ask) asked.add(q);
    tokens += res.inputTokens;
    model ||= res.model;
    if (++answered % 100 === 0) await save();
  }, { onError: () => failures++ });
  await save();

  const questions = [...asked].sort();
  const manifest = await updateManifest(ctx, run, (mf): Manifest => {
    const prev = mf.judge ?? { passes: [], inputTokens: 0 };
    if (!todo.length) return mf;
    const passes = [...prev.passes, {
      at: isoNow(ctx),
      model,
      questions,
      messages: answered,
      inputTokens: tokens,
      failures,
    }];
    const inputTokens = passes.reduce((a, p) => a + p.inputTokens, 0);
    const price = ctx.profile.pricePerMTok;
    return {
      ...mf,
      judge: {
        passes,
        inputTokens,
        ...(price === undefined
          ? {}
          : { costUsd: Number(((inputTokens / 1e6) * price).toFixed(6)) }),
      },
    };
  });
  return {
    messages: answered,
    questions,
    // fallback: a pass that made no call has no reported model; name the profile's.
    model: model || ctx.profile.model,
    inputTokens: tokens,
    totalInputTokens: manifest.judge?.inputTokens ?? 0,
    failures,
  };
}
