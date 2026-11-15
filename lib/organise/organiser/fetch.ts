/**
 * The sample and fetch stages: choosing a run's messages, then reading them.
 *
 * @module
 */

import { type OrganiseMessage, toOrganiseMessage } from "../message.ts";
import { candidatesOf, type Listed, seededShuffle } from "../sample.ts";
import { pool, withRetry } from "../throttle.ts";
import { loadCapture } from "./capture.ts";
import { isoNow, listAll, pacing, say, type StageContext } from "./context.ts";
import { readJson, readJsonOr, safeName, writeJson } from "./store.ts";
import type { FetchSummary, Manifest, SampleOptions } from "./types.ts";

/** Received mail: never sent, chat or draft. */
export const RECEIVED_QUERY = "-in:sent -in:chats -in:draft";

/** `runs/<run>/messages.json`. */
export interface MessagesFile {
  /** Every message read so far. */
  messages: OrganiseMessage[];
  /** Sampled as single-message threads, found to have grown. Never read. */
  rejected: string[];
}

/** Merge `patch` into a run's manifest and write it whole. */
export async function updateManifest(
  ctx: StageContext,
  run: string,
  patch: (m: Manifest) => Manifest,
): Promise<Manifest> {
  const path = ctx.files.run(run).manifest;
  const next = patch(await readJson<Manifest>(path));
  await writeJson(path, next);
  return next;
}

/**
 * Draw a deterministic sample of received mail, never from a thread the sent
 * capture shows you wrote into. Costs list calls only.
 *
 * A redraw (`force`) clears the run's fetched messages, answers and decisions,
 * and is refused once any scheme has been applied from the run: its apply log
 * is the record of what was labelled, and must stay with what it describes.
 */
export async function sample(ctx: StageContext, o: SampleOptions): Promise<Manifest> {
  const run = safeName("run", o.run);
  if ((o.year === undefined) === (o.query === undefined)) {
    throw new TypeError("sample needs exactly one of year and query");
  }
  if (o.year !== undefined && !Number.isInteger(o.year)) {
    throw new TypeError("year must be a whole year");
  }
  const files = ctx.files.run(run);
  const existing = await readJsonOr<unknown>(files.sample, null);
  if (existing && !o.force) throw new Error(`run ${run} already has a sample; force redraws it`);
  if (existing) await clearRun(ctx, run);

  const size = o.size ?? 500;
  const seed = o.seed ?? (o.year !== undefined ? o.year * 10_000 + size : size);
  const query = o.year !== undefined
    ? `${RECEIVED_QUERY} after:${o.year}/01/01 before:${o.year + 1}/01/01`
    : `${RECEIVED_QUERY} ${o.query}`;

  const pace = pacing(ctx);
  const listed = await listAll(ctx.io.gmail, query, 1_000_000, pace);
  const sentThreads = new Set((await loadCapture(ctx, "sent")).map((m) => m.threadId));
  if (!sentThreads.size) say(ctx, "no sent capture: threads you replied into cannot be excluded");
  const singleMessage = Boolean(o.singleMessage);
  const candidates = candidatesOf(listed, sentThreads, singleMessage);
  const drawn = seededShuffle(candidates, seed).slice(0, size);

  await writeJson(files.sample, drawn);
  const manifest: Manifest = {
    id: run,
    ...(o.year !== undefined ? { year: o.year } : {}),
    createdAt: isoNow(ctx),
    sample: {
      query,
      seed,
      size: drawn.length,
      singleMessage,
      listed: listed.length,
      candidates: candidates.length,
    },
  };
  await writeJson(files.manifest, manifest);
  say(
    ctx,
    `sample ${run}: ${listed.length} listed, ${candidates.length} candidates, ${drawn.length} drawn`,
  );
  return manifest;
}

async function clearRun(ctx: StageContext, run: string): Promise<void> {
  const dir = ctx.files.run(run).dir;
  const doomed: string[] = [];
  for await (const e of Deno.readDir(dir)) {
    if (e.name.startsWith("apply.")) {
      throw new Error(
        `run ${run} has been applied (${e.name}); draw a new run instead of redrawing it`,
      );
    }
    if (/^(messages|answers|decisions\..+)\.json$/.test(e.name)) doomed.push(e.name);
  }
  for (const name of doomed) await Deno.remove(`${dir}/${name}`);
}

/** Messages per thread across the whole mailbox, from list calls alone. */
async function threadSizes(ctx: StageContext, pace: ReturnType<typeof pacing>) {
  const size = new Map<string, number>();
  for (
    const m of await listAll(ctx.io.gmail, "-in:chats -in:draft", Number.MAX_SAFE_INTEGER, pace)
  ) {
    size.set(m.threadId, (size.get(m.threadId) ?? 0) + 1);
  }
  return size;
}

/**
 * Read each sampled message in full: what the model sees, and the delivery
 * headers the routes read. Resumable: a message already read is never read
 * again, and progress is saved every 100.
 *
 * Paced by Gmail's per-user quota (default 4 reads a second, 4 in flight); a
 * quota refusal is waited out and counted. A single-message sample is settled by
 * one listing pass over the whole mailbox, so a thread that grew after it was
 * sampled is rejected without a read.
 */
export async function fetchRun(ctx: StageContext, o: { run: string }): Promise<FetchSummary> {
  const run = safeName("run", o.run);
  const files = ctx.files.run(run);
  const manifest = await readJson<Manifest>(files.manifest);
  const drawn = await readJson<Listed[]>(files.sample);
  const file = await readJsonOr<MessagesFile>(files.messages, { messages: [], rejected: [] });
  const done = new Set([...file.messages.map((m) => m.id), ...file.rejected]);
  let pending = drawn.filter((s) => !done.has(s.id));
  say(ctx, `fetch ${run}: ${drawn.length} sampled, ${pending.length} to read`);

  const pace = pacing(ctx);
  if (manifest.sample?.singleMessage && pending.length) {
    // A reply that arrived after the sample's window makes a thread a conversation.
    // One pass over every id settles all of them at list cost, not a thread read each.
    const size = await threadSizes(ctx, pace);
    const grown = pending.filter((s) => (size.get(s.threadId) ?? 1) > 1);
    file.rejected.push(...grown.map((s) => s.id));
    pending = pending.filter((s) => (size.get(s.threadId) ?? 1) <= 1);
    say(ctx, `  ${grown.length} grown threads rejected unread`);
  }

  let failures = 0;
  let sinceSave = 0;
  await pool(pending, pace.concurrency, async (s) => {
    await pace.limiter.take();
    const msg = await withRetry(() => ctx.io.gmail.getMessage(s.id, "full"), pace.retry);
    file.messages.push({ ...toOrganiseMessage(msg, ctx.profile.bodyChars), threadId: s.threadId });
    if (++sinceSave % 100 === 0) await writeJson(files.messages, file);
  }, { onError: () => failures++ });
  await writeJson(files.messages, file);

  const summary: FetchSummary = {
    fetched: file.messages.length,
    rejected: file.rejected.length,
    failures,
    quotaRetries: pace.counter.quotaRetries,
  };
  await updateManifest(ctx, run, (m) => ({ ...m, fetch: { at: isoNow(ctx), ...summary } }));
  return summary;
}
