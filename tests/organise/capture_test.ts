import { assertEquals } from "@std/assert";
import { auditShard, parseShard, shardFor } from "../../lib/organise/capture.ts";
import type { CapturedMessage } from "../../lib/organise/types.ts";

/** Synthetic captured message. No real addresses appear in these fixtures. */
function rec(over: Partial<CapturedMessage> = {}): CapturedMessage {
  return {
    id: crypto.randomUUID(),
    threadId: "t",
    // 2025-06-15T12:00:00Z
    internalDate: String(Date.UTC(2025, 5, 15, 12)),
    headers: { From: "me@example.test", To: "jo@partner.test", Subject: "Hello" },
    ...over,
  };
}

const shard = (...msgs: CapturedMessage[]) => msgs.map((m) => JSON.stringify(m)).join("\n") + "\n";

Deno.test("a clean shard reports no problems", () => {
  const a = auditShard(shard(rec(), rec(), rec()), 2025);
  assertEquals(a.count, 3);
  assertEquals(a.problems, []);
  assertEquals(a.notes, []);
});

Deno.test("an empty shard is empty, not broken", () => {
  const a = auditShard("", 2025);
  assertEquals(a.count, 0);
  assertEquals(a.first, 0);
  assertEquals(a.last, 0);
  assertEquals(a.problems, []);
});

Deno.test("a half-written line is caught", () => {
  // Exactly what an interrupted append leaves behind.
  const text = shard(rec(), rec()) + '{"id":"truncated","threadId":';
  const a = auditShard(text, 2025);
  assertEquals(a.count, 2);
  assertEquals(a.problems, ["1 lines failed to parse"]);
});

Deno.test("duplicate ids are caught", () => {
  const dup = rec({ id: "same" });
  const a = auditShard(shard(dup, rec(), { ...dup }), 2025);
  assertEquals(a.count, 3);
  assertEquals(a.problems, ["1 duplicate ids"]);
});

Deno.test("a message filed under the wrong year is caught", () => {
  // The failure that matters most: every year-bounded run afterwards skips it.
  const wrong = rec({ internalDate: String(Date.UTC(2024, 11, 31, 23)) });
  const a = auditShard(shard(rec(), wrong), 2025);
  assertEquals(a.problems, ["1 messages dated outside 2025"]);
});

Deno.test("year boundaries are half-open, so neither edge is stray", () => {
  const first = rec({ internalDate: String(Date.UTC(2025, 0, 1, 0, 0, 0)) });
  const last = rec({ internalDate: String(Date.UTC(2025, 11, 31, 23, 59, 59)) });
  assertEquals(auditShard(shard(first, last), 2025).problems, []);
  // One millisecond past the end belongs to the next year.
  const over = rec({ internalDate: String(Date.UTC(2026, 0, 1)) });
  assertEquals(auditShard(shard(over), 2025).problems, ["1 messages dated outside 2025"]);
});

Deno.test("without a year only an unusable date is a problem", () => {
  const undated = rec({ internalDate: "0" });
  const a = auditShard(shard(rec(), undated));
  assertEquals(a.problems, ["1 messages with no usable date"]);
});

Deno.test("a missing From is a problem, missing recipients only a note", () => {
  const noFrom = rec({ headers: { To: "jo@partner.test" } });
  assertEquals(auditShard(shard(noFrom), 2025).problems, ["1 messages with no From header"]);

  const bccOnly = rec({ headers: { From: "me@example.test", Subject: "Notice" } });
  const a = auditShard(shard(bccOnly), 2025);
  assertEquals(a.problems, []);
  assertEquals(a.notes, ["1 with no To/Cc/Bcc (drafts, bounces or Bcc-only sends)"]);
});

Deno.test("first and last span only the in-range messages", () => {
  const early = rec({ internalDate: String(Date.UTC(2025, 1, 1)) });
  const late = rec({ internalDate: String(Date.UTC(2025, 10, 1)) });
  const stray = rec({ internalDate: String(Date.UTC(2023, 0, 1)) });
  const a = auditShard(shard(late, stray, early), 2025);
  assertEquals(a.first, Date.UTC(2025, 1, 1));
  assertEquals(a.last, Date.UTC(2025, 10, 1));
});

Deno.test("several faults are reported together, not one at a time", () => {
  const dup = rec({ id: "same" });
  const text = shard(dup, { ...dup }, rec({ internalDate: String(Date.UTC(2020, 0, 1)) })) +
    "{oops";
  const a = auditShard(text, 2025);
  assertEquals(a.problems.length, 3);
});

Deno.test("shardFor files a message by the year of its internalDate", () => {
  assertEquals(shardFor({ internalDate: String(Date.UTC(2019, 6, 4)) }), "2019");
});

Deno.test("parseShard ignores blank lines", () => {
  assertEquals(parseShard("\n" + shard(rec()) + "\n\n").length, 1);
});
