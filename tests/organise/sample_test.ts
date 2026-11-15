import { assertEquals, assertNotEquals } from "@std/assert";
import { candidatesOf, seededShuffle } from "../../lib/organise/sample.ts";

const listed = [
  { id: "a", threadId: "t1" },
  { id: "b", threadId: "t2" },
  { id: "c", threadId: "t2" },
  { id: "d", threadId: "t3" },
];

Deno.test("a thread you sent into is never a candidate", () => {
  assertEquals(candidatesOf(listed, new Set(["t3"]), false).map((m) => m.id), ["a", "b", "c"]);
});

Deno.test("single-message mode drops threads with more than one listed message", () => {
  assertEquals(candidatesOf(listed, new Set(["t3"]), true).map((m) => m.id), ["a"]);
});

Deno.test("a seed always draws the same order, and different seeds differ", () => {
  const items = Array.from({ length: 50 }, (_, i) => i);
  assertEquals(seededShuffle(items, 7), seededShuffle(items, 7));
  assertNotEquals(seededShuffle(items, 7), seededShuffle(items, 8));
  assertEquals([...seededShuffle(items, 7)].sort((x, y) => x - y), items);
});
