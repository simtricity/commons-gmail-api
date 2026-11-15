/**
 * The apply and reconcile stages: a scheme's decisions as Gmail labels, and
 * Gmail's labels checked against the decisions.
 *
 * @module
 */

import { idsSha256, ScopedRelabelError } from "../../guarded.ts";
import { relabelPlan } from "../relabel.ts";
import type { Scheme, SchemeDecision } from "../scheme.ts";
import { isoNow, listAll, pacing, say, schemeOf, type StageContext } from "./context.ts";
import { decisionsOf } from "./decide.ts";
import { type MessagesFile, updateManifest } from "./fetch.ts";
import { appendLine, readJson, safeName } from "./store.ts";
import type { ApplySummary, Manifest, ReconcileResult } from "./types.ts";

/** Gmail's search spelling of a label name: lower case, `/` and spaces as `-`. */
const searchName = (name: string) => name.toLowerCase().replace(/[\/\s]+/g, "-");

/** What `held` says about a message carrying none of the scheme's labels. */
const UNLABELLED = "unlabelled";

interface Held {
  scheme: Scheme;
  decisions: SchemeDecision[];
  dates: Map<string, string>;
  /** Label names that exist in the mailbox. */
  existing: Set<string>;
  /** Label name → message ids carrying it. */
  members: Map<string, Set<string>>;
  /** The categories whose label (for the message's own year) a message carries, in category order. */
  heldBy(id: string): string[];
}

/**
 * Read a run's decisions for one scheme and who carries each of the scheme's
 * labels for the run's years. Costs list calls only: one listing per label
 * that exists.
 */
async function held(ctx: StageContext, run: string, schemeId: string): Promise<Held> {
  const scheme = schemeOf(ctx, schemeId);
  const { decisions } = await decisionsOf(ctx, run, schemeId);
  const { messages } = await readJson<MessagesFile>(ctx.files.run(run).messages);
  const dates = new Map(messages.map((m) => [m.id, m.internalDate]));

  const names = new Set<string>();
  for (const d of decisions) {
    const date = dates.get(d.id);
    if (date === undefined) throw new Error(`no message ${d.id} for its decision`);
    for (const c of scheme.categories) {
      const l = scheme.label(c, date);
      if (l !== undefined) names.add(l);
    }
  }
  const existing = new Set(
    (await ctx.io.gmail.listLabels()).map((l) => l.name).filter((n) => names.has(n)),
  );
  const pace = pacing(ctx);
  const members = new Map<string, Set<string>>();
  for (const name of [...existing].sort()) {
    const listed = await listAll(
      ctx.io.gmail,
      `label:${searchName(name)}`,
      Number.MAX_SAFE_INTEGER,
      pace,
    );
    members.set(name, new Set(listed.map((m) => m.id)));
  }

  const heldBy = (id: string) => {
    const date = dates.get(id)!;
    return scheme.categories.filter((c) => {
      const l = scheme.label(c, date);
      return l !== undefined && (members.get(l)?.has(id) ?? false);
    });
  };
  return { scheme, decisions, dates, existing, members, heldBy };
}

/** A message already carries exactly its category's label, or none for an unlabelled one. */
function settled(h: Held, d: SchemeDecision): boolean {
  const now = h.heldBy(d.id);
  return h.scheme.label(d.category, h.dates.get(d.id)!) === undefined
    ? now.length === 0
    : now.length === 1 && now[0] === d.category;
}

const heldName = (cats: string[]) => cats.length ? cats.join("+") : UNLABELLED;

/**
 * Label one scheme's decisions in Gmail, inside the scheme's prefix only. A
 * dry run unless `apply`, and a dry run makes no write at all.
 *
 * Only messages whose labels differ from their decision are changed; each
 * change adds the category's label and removes the scheme's other labels for
 * that year in one call. Missing labels are created first.
 *
 * Every applied group appends one line to `runs/<run>/apply.<scheme>.log`:
 * `{ at, scheme, add, remove, ids, idsSha256, calls }`, ids sorted, the hash
 * equal to the one the guard logs for the same change. A group that fails part
 * way appends the same line with `calls` (chunks applied), `partial: true` and
 * `error` (class name and HTTP status), then the guard's
 * {@link ScopedRelabelError} is rethrown.
 */
export async function apply(
  ctx: StageContext,
  o: { run: string; scheme: string; apply?: boolean },
): Promise<ApplySummary> {
  const run = safeName("run", o.run);
  const writer = ctx.io.writer;
  if (o.apply && !writer) throw new TypeError("apply needs a write grant: pass io.writer");
  const h = await held(ctx, run, o.scheme);
  const { scheme } = h;

  let unchanged = 0;
  const moves: Record<string, number> = {};
  const changed: SchemeDecision[] = [];
  for (const d of h.decisions) {
    if (settled(h, d)) {
      unchanged++;
      continue;
    }
    changed.push(d);
    const key = `${heldName(h.heldBy(d.id))} → ${d.category}`;
    moves[key] = (moves[key] ?? 0) + 1;
  }
  const groups = relabelPlan(
    scheme,
    changed,
    [...h.dates].map(([id, internalDate]) => ({ id, internalDate })),
  );
  const toCreate = [
    ...new Set(groups.map((g) => g.add).filter((l): l is string => !!l && !h.existing.has(l))),
  ].sort();
  const summary = { scheme: scheme.id, toCreate, unchanged, moves };
  if (!o.apply || !writer) return { ...summary, dryRun: true, calls: 0 };

  for (const name of toCreate) await writer.createScopedLabel(scheme.labelPrefix, name);
  const log = ctx.files.run(run).applyLog(scheme.id);
  let calls = 0;
  for (const g of groups) {
    const line = {
      at: isoNow(ctx),
      scheme: scheme.id,
      add: g.add ?? null,
      remove: g.remove,
      ids: g.ids,
    };
    try {
      const res = await writer.scopedRelabel({
        prefix: scheme.labelPrefix,
        ...(g.add !== undefined ? { add: g.add } : {}),
        remove: g.remove,
        ids: g.ids,
        apply: true,
      });
      const n = res.calls ?? 0;
      calls += n;
      // A group the guard found nothing to do for wrote nothing, so neither do we.
      if (n) await appendLine(log, { ...line, idsSha256: await idsSha256(g.ids), calls: n });
    } catch (e) {
      if (e instanceof ScopedRelabelError) {
        const cause = e.cause;
        await appendLine(log, {
          ...line,
          idsSha256: e.idsSha256,
          calls: e.callsDone,
          partial: true,
          error: {
            name: cause instanceof Error ? cause.name : typeof cause,
            ...(e.status !== undefined ? { status: e.status } : {}),
          },
        });
      }
      throw e;
    }
  }
  await updateManifest(ctx, run, (m): Manifest => ({
    ...m,
    apply: { ...m.apply, [scheme.id]: { at: isoNow(ctx), calls } },
  }));
  say(ctx, `apply ${run} ${scheme.id}: ${changed.length} changed in ${calls} calls`);
  return { ...summary, dryRun: false, calls };
}

/**
 * Compare Gmail's labels with one scheme's decisions for a run. Lists each of
 * the scheme's labels for the run's years; writes nothing.
 */
export async function reconcile(
  ctx: StageContext,
  o: { run: string; scheme: string },
): Promise<ReconcileResult> {
  const run = safeName("run", o.run);
  const h = await held(ctx, run, o.scheme);
  const counts = Object.fromEntries(h.scheme.categories.map((c) => [c, 0]));
  const wrong: ReconcileResult["wrong"] = [];
  for (const d of h.decisions) {
    const now = h.heldBy(d.id);
    for (const c of now) counts[c]++;
    if (!now.length) {
      for (const c of h.scheme.categories) {
        if (h.scheme.label(c, h.dates.get(d.id)!) === undefined) counts[c]++;
      }
    }
    if (!settled(h, d)) wrong.push({ id: d.id, decided: d.category, labelled: heldName(now) });
  }
  const inRun = new Set(h.decisions.map((d) => d.id));
  const outsideRun = Object.fromEntries(
    [...h.members].map(([name, ids]) => [name, [...ids].filter((id) => !inRun.has(id)).length]),
  );
  wrong.sort((a, b) => a.id.localeCompare(b.id));
  return { scheme: h.scheme.id, ok: !wrong.length, counts, outsideRun, wrong };
}
