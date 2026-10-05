/**
 * Capturing mailbox metadata to durable, append-only files.
 *
 * The distinction that shapes this module is captured versus derived. Reading a
 * large mailbox costs roughly an hour of API quota; deriving a correspondent
 * corpus, a thread index or a label decision from an existing capture costs
 * seconds. Derivation rules change often — auto-reply detection, list detection
 * and self-address exclusion all changed within a day of first use — and each
 * change would otherwise mean another full re-read.
 *
 * So: capture once, keep it, derive freely. Pure functions only; the CLI owns
 * the filesystem.
 *
 * @module
 */

import { header } from "../mime.ts";
import type { Message } from "../types.ts";
import type { CapturedMessage } from "./types.ts";

/**
 * Headers worth keeping. Deliberately wider than any current derivation needs,
 * because adding one later means re-reading the mailbox while carrying an unused
 * one costs a few bytes.
 */
export const CAPTURED_HEADERS = [
  "From",
  "To",
  "Cc",
  "Bcc",
  "Reply-To",
  "Subject",
  "Date",
  "Message-ID",
  "In-Reply-To",
  "References",
  "Auto-Submitted",
  "X-Autoreply",
  "Precedence",
  "List-Id",
  "List-Post",
  "List-Unsubscribe",
  "Delivered-To",
] as const;

/** Project a Gmail message down to what is worth keeping. Never the body. */
export function toCaptured(msg: Message): CapturedMessage {
  const headers: Record<string, string> = {};
  for (const name of CAPTURED_HEADERS) {
    const value = header(msg.payload, name);
    if (value) headers[name] = value;
  }
  return {
    id: msg.id,
    threadId: msg.threadId,
    internalDate: msg.internalDate ?? "",
    labelIds: msg.labelIds,
    sizeEstimate: msg.sizeEstimate,
    headers,
  };
}

/** Which yearly shard a message belongs in. Undated mail goes to "unknown". */
export function shardFor(msg: { internalDate?: string }): string {
  const ms = Number(msg.internalDate ?? 0);
  if (!ms) return "unknown";
  return String(new Date(ms).getUTCFullYear());
}

/**
 * Build a Gmail query for an incremental run.
 *
 * `overlapDays` re-fetches a little of what is already held, which costs almost
 * nothing and absorbs clock skew and late-delivered mail. Duplicate ids are
 * discarded on write, so overlapping is always safe.
 */
export function incrementalQuery(
  base: string,
  lastInternalDate?: string,
  overlapDays = 2,
): string {
  const ms = Number(lastInternalDate ?? 0);
  if (!ms) return base;
  const from = new Date(ms - overlapDays * 86_400_000);
  const y = from.getUTCFullYear();
  const m = String(from.getUTCMonth() + 1).padStart(2, "0");
  const d = String(from.getUTCDate()).padStart(2, "0");
  return `${base} after:${y}/${m}/${d}`;
}

/** Parse a capture shard. Malformed lines are skipped, not fatal. */
export function parseShard(text: string): CapturedMessage[] {
  const out: CapturedMessage[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as CapturedMessage);
    } catch {
      // fallback: a truncated final line from an interrupted run is expected,
      // and losing one message is better than refusing to read the shard.
    }
  }
  return out;
}

/** Newest internalDate across a set of captured messages. */
export function newestDate(msgs: readonly CapturedMessage[]): string {
  let best = 0;
  for (const m of msgs) {
    const n = Number(m.internalDate ?? 0);
    if (n > best) best = n;
  }
  return best ? String(best) : "";
}

/**
 * Rebuild a Message-shaped object from a captured record.
 *
 * Everything downstream reads messages through `header()`, so restoring the
 * header array is enough to let derivations run against a capture exactly as
 * they run against a live fetch. No body is reconstructed, because none was kept.
 */
export function fromCaptured(rec: CapturedMessage): Message {
  return {
    id: rec.id,
    threadId: rec.threadId,
    internalDate: rec.internalDate,
    labelIds: rec.labelIds,
    sizeEstimate: rec.sizeEstimate,
    payload: {
      headers: Object.entries(rec.headers).map(([name, value]) => ({ name, value })),
    },
  };
}

/** What is wrong with a shard, and what is merely worth knowing. */
export interface ShardAudit {
  count: number;
  /** Oldest and newest `internalDate` held, ms since epoch. 0 when empty. */
  first: number;
  last: number;
  problems: string[];
  notes: string[];
}

/**
 * Check a shard against itself, without reference to Gmail.
 *
 * A capture is append-only and written as it is fetched, which is what makes an
 * interrupted run resumable — and also what lets a half-written line, a repeated
 * id or a message filed under the wrong year survive unnoticed. A message in the
 * wrong shard is the worst of these, because every year-bounded run afterwards
 * looks straight past it.
 *
 * `year` is optional so a shard can be audited before its year is known.
 */
export function auditShard(text: string, year?: number): ShardAudit {
  const problems: string[] = [];
  const notes: string[] = [];

  const lines = text.split("\n").filter((l) => l.trim()).length;
  const msgs = parseShard(text);
  if (msgs.length !== lines) problems.push(`${lines - msgs.length} lines failed to parse`);

  const ids = new Set(msgs.map((m) => m.id));
  if (ids.size !== msgs.length) problems.push(`${msgs.length - ids.size} duplicate ids`);

  const start = year === undefined ? -Infinity : Date.UTC(year, 0, 1);
  const end = year === undefined ? Infinity : Date.UTC(year + 1, 0, 1);
  const dates: number[] = [];
  let stray = 0;
  for (const m of msgs) {
    const t = Number(m.internalDate ?? 0);
    if (!t || t < start || t >= end) stray++;
    else dates.push(t);
  }
  if (stray) {
    problems.push(
      year === undefined
        ? `${stray} messages with no usable date`
        : `${stray} messages dated outside ${year}`,
    );
  }

  // Without a sender nothing downstream can derive anything at all.
  const noFrom = msgs.filter((m) => !m.headers?.From).length;
  if (noFrom) problems.push(`${noFrom} messages with no From header`);

  // Not a fault: a draft, a bounce, or a send where everyone was Bcc'd.
  const noTo = msgs.filter((m) => !m.headers?.To && !m.headers?.Cc && !m.headers?.Bcc).length;
  if (noTo) notes.push(`${noTo} with no To/Cc/Bcc (drafts, bounces or Bcc-only sends)`);

  dates.sort((a, b) => a - b);
  return {
    count: msgs.length,
    first: dates[0] ?? 0,
    last: dates[dates.length - 1] ?? 0,
    problems,
    notes,
  };
}
