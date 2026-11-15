/**
 * The capture and corpus stages: mailbox metadata to local shards, and the
 * sent-mail corpus derived from them.
 *
 * @module
 */

import { resolve } from "@std/path";
import {
  fromCaptured,
  incrementalQuery,
  newestDate,
  parseShard,
  shardFor,
  toCaptured,
} from "../capture.ts";
import { CorpusBuilder, selfAddressesFrom } from "../corpus.ts";
import { Relationships } from "../relationships.ts";
import { pool, withRetry } from "../throttle.ts";
import type { CapturedMessage, CaptureState } from "../types.ts";
import { isoNow, listAll, pacing, say, type StageContext } from "./context.ts";
import { ensureDir, readJsonOr, writeJson } from "./store.ts";
import type { CaptureSummary, CorpusSummary } from "./types.ts";

const SOURCES = { sent: "in:sent", received: "-in:sent -in:chats -in:draft" } as const;

/** Every message held for a source, optionally limited to some shard years. */
export async function loadCapture(
  ctx: StageContext,
  source: "sent" | "received",
  years?: readonly (string | number)[],
): Promise<CapturedMessage[]> {
  const out: CapturedMessage[] = [];
  const dir = ctx.files.captureDir(source);
  const wanted = years?.map(String);
  try {
    for await (const e of Deno.readDir(dir)) {
      if (!e.isFile || !e.name.endsWith(".jsonl")) continue;
      if (wanted?.length && !wanted.includes(e.name.slice(0, -".jsonl".length))) continue;
      out.push(...parseShard(await Deno.readTextFile(`${dir}/${e.name}`)));
    }
  } catch (err) {
    // fallback: nothing captured for this source yet.
    if (!(err instanceof Deno.errors.NotFound)) throw err;
  }
  return out;
}

/**
 * Capture metadata to append-only yearly shards, `capture/<source>/<year>.jsonl`.
 *
 * Incremental from the last captured date (less `overlapDays`) unless `full`.
 * Every line is written as it is fetched, so an interrupted capture resumes. A
 * capped run (`max` reached) does not move the incremental marker, since older
 * matches may remain.
 */
export async function capture(
  ctx: StageContext,
  o: { source: "sent" | "received"; full?: boolean; overlapDays?: number; max?: number },
): Promise<CaptureSummary> {
  const base = SOURCES[o.source];
  if (!base) throw new TypeError(`capture source must be "sent" or "received"`);
  const state = await readJsonOr<CaptureState>(ctx.files.captureState, { sources: {} });
  const prior = state.sources[o.source];
  const query = o.full ? base : incrementalQuery(base, prior?.lastInternalDate, o.overlapDays ?? 2);
  const held = await loadCapture(ctx, o.source);
  const seen = new Set(held.map((m) => m.id));

  const pace = pacing(ctx);
  const max = o.max ?? 1_000_000;
  const listed = await listAll(ctx.io.gmail, query, max, pace);
  const todo = listed.filter((m) => !seen.has(m.id));
  say(ctx, `capture ${o.source}: ${listed.length} listed, ${todo.length} new`);

  await ensureDir(ctx.files.captureDir(o.source));
  const handles = new Map<string, Deno.FsFile>();
  const enc = new TextEncoder();
  let captured = 0;
  let failures = 0;
  // The marker is the newest message held, including any a capped run captured before it.
  let newest = Math.max(Number(prior?.lastInternalDate ?? 0), Number(newestDate(held) || 0));
  try {
    await pool(todo, pace.concurrency, async (m) => {
      await pace.limiter.take();
      const rec = toCaptured(
        await withRetry(() => ctx.io.gmail.getMessage(m.id, "metadata"), pace.retry),
      );
      const year = shardFor(rec);
      let h = handles.get(year);
      if (!h) {
        const path = ctx.files.shard(o.source, year);
        h = await Deno.open(path, { create: true, append: true, write: true, mode: 0o600 });
        await Deno.chmod(path, 0o600).catch(() => {
          // fallback: chmod is unavailable on some filesystems; the create mode stands.
        });
        handles.set(year, h);
      }
      await h.write(enc.encode(JSON.stringify(rec) + "\n"));
      captured++;
      newest = Math.max(newest, Number(rec.internalDate || 0));
    }, { onError: () => failures++ });
  } finally {
    for (const h of handles.values()) h.close();
  }

  if (listed.length < max && captured) {
    state.sources[o.source] = {
      lastInternalDate: String(newest),
      lastRun: isoNow(ctx),
      captured: seen.size + captured,
    };
    await writeJson(ctx.files.captureState, state);
  }
  return {
    source: o.source,
    query,
    captured,
    failures,
    total: seen.size + captured,
    shards: [...handles.keys()].sort(),
  };
}

/**
 * Build the sent-mail corpus from the sent capture, in two passes: first which
 * addresses are the account holder's own (they are never correspondents), then
 * every recipient. Writes the profile's `corpus` path.
 */
export async function corpus(
  ctx: StageContext,
  o: { minGenuine?: number; years?: number[] } = {},
): Promise<CorpusSummary> {
  const captured = await loadCapture(ctx, "sent", o.years);
  if (!captured.length) {
    throw new Error(`no sent capture in this data directory; capture "sent" first`);
  }
  const pace = pacing(ctx);
  const me = await withRetry(() => ctx.io.gmail.profile(), pace.retry);
  const self = selfAddressesFrom(captured.map((r) => r.headers.From ?? ""), {
    profile: me.emailAddress,
  });
  const builder = new CorpusBuilder({ selfAddresses: self });
  for (const rec of captured) builder.add(fromCaptured(rec));
  const query = `capture:sent${o.years?.length ? ` years=${o.years.join(",")}` : ""}`;
  const c = builder.finish(query, o.minGenuine ?? 1);

  const path = resolve(ctx.dataDir, ctx.profile.corpus);
  await writeJson(path, c);
  const rel = new Relationships(c, ctx.profile.relationships);
  const strong =
    c.correspondents.filter((p) => p.kind === "person" && rel.strength(p.address) === "strong")
      .length;
  say(ctx, `corpus: ${c.scanned} sent messages, ${c.correspondents.length} correspondents`);
  return { scanned: c.scanned, correspondents: c.correspondents.length, strong, path };
}
