import { assertEquals, assertThrows } from "@std/assert";
import { evaluate, parseGolden, score } from "../../lib/organise/golden.ts";
import { withRuling, withSenderRuling } from "../../lib/organise/rulings.ts";
import { ProfileError, type SchemeDecision } from "../../lib/organise/scheme.ts";

const CATEGORIES = { triage: ["delete", "defer", "keep", "important"], topic: ["garden", "none"] };
const RAW = {
  cases: [
    { id: "a", expect: "important", never: ["delete"] },
    { id: "b", scheme: "topic", expect: "garden", note: "the shed" },
  ],
};

const d = (id: string, scheme: string, category: string): SchemeDecision => ({
  id,
  scheme,
  category,
  route: "r",
  why: "w",
  sender: "s@x.test",
  subject: "s",
});

Deno.test("parseGolden: every case gets its scheme; categories check each scheme", () => {
  const cases = parseGolden(RAW, CATEGORIES);
  assertEquals(cases.map((c) => [c.id, c.scheme]), [["a", "triage"], ["b", "topic"]]);
  assertEquals(cases[1].note, "the shed");
  assertThrows(
    () => parseGolden({ cases: [{ id: "x", scheme: "topic", expect: "car" }] }, CATEGORIES),
    ProfileError,
    "car",
  );
  assertThrows(
    () => parseGolden({ cases: [{ id: "x", scheme: "nosuch", expect: "y" }] }, CATEGORIES),
    ProfileError,
    "unknown scheme",
  );
  assertEquals(
    parseGolden({ cases: [{ id: "x", scheme: "other", expect: "anything" }] })[0].scheme,
    "other",
    "unchecked without categories",
  );
  assertThrows(
    () => parseGolden({ cases: [{ id: "x", expect: "archive" }] }),
    ProfileError,
    "archive",
  );
  assertThrows(
    () => parseGolden({ cases: [{ id: "x", expect: "keep", never: ["keep"] }] }),
    ProfileError,
    "never",
  );
  assertThrows(() => parseGolden({ cases: [{ expect: "keep" }] }), ProfileError, "id");
});

Deno.test("score: one scheme's cases against that scheme's decisions only", () => {
  const cases = parseGolden(RAW, CATEGORIES);
  const decisions = [
    d("a", "triage", "delete"),
    d("b", "topic", "garden"),
    d("b", "triage", "keep"),
  ];
  const triage = score(cases, decisions, "triage");
  assertEquals([triage.evaluated, triage.passed, triage.criticalFailures], [1, 0, 1]);
  assertEquals(triage.failures[0].got, "delete");
  const topic = score(cases, decisions, "topic");
  assertEquals([topic.scheme, topic.evaluated, topic.passed, topic.notInRun], ["topic", 1, 1, []]);
  assertEquals(score(cases, [], "topic").notInRun, ["b"]);
});

Deno.test("evaluate still scores triage decisions", () => {
  const r = evaluate(parseGolden(RAW), [{ id: "a", verdict: "important", route: "r", why: "w" }]);
  assertEquals([r.evaluated, r.passed, r.notInRun], [1, 1, ["b"]]);
});

Deno.test("withRuling: replaces by scheme and id, never mutates", () => {
  const cases = parseGolden(RAW, CATEGORIES);
  const replaced = withRuling(cases, { id: "a", expect: "keep" });
  assertEquals(replaced.map((c) => [c.id, c.scheme, c.expect]), [["a", "triage", "keep"], [
    "b",
    "topic",
    "garden",
  ]]);
  assertEquals(cases[0].expect, "important", "input untouched");
  assertEquals(withRuling(cases, { id: "a", scheme: "topic", expect: "none" }).length, 3);
  assertThrows(() => withRuling(cases, { id: "z", expect: "keep", never: ["keep"] }), ProfileError);
});

Deno.test("withSenderRuling: one category per address, lower-cased, input untouched", () => {
  const cats = CATEGORIES.triage;
  const before = {
    delete: { "a@x.test": "old", "b@x.test": "keep me" },
    _comment: { note: "kept" },
  };
  const moved = withSenderRuling(before, " A@X.test ", "keep", "new", cats);
  assertEquals(moved, {
    delete: { "b@x.test": "keep me" },
    _comment: { note: "kept" },
    keep: { "a@x.test": "new" },
  });
  assertEquals(before.delete["a@x.test"], "old", "input untouched");
  assertEquals(withSenderRuling({ keep: { "a@x.test": "n" } }, "a@x.test", "delete", "n", cats), {
    delete: { "a@x.test": "n" },
  }, "an emptied category is dropped");
  assertThrows(() => withSenderRuling({}, "a@x.test", "archive", "n", cats), ProfileError);
});
