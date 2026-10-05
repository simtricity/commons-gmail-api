import { assertEquals, assertThrows } from "@std/assert";
import { evaluate, parseGolden } from "../../lib/organise/golden.ts";
import type { Verdict } from "../../lib/organise/verdict.ts";

const d = (id: string, verdict: Verdict) => ({ id, verdict, route: "r", why: "w" });

Deno.test("a case passes when the verdict is any of those expected", () => {
  const cases = parseGolden({ cases: [{ id: "a", expect: ["keep", "important"] }] });
  assertEquals(evaluate(cases, [d("a", "important")]).passed, 1);
});

Deno.test("a miss is not critical; landing on a forbidden verdict is", () => {
  const cases = parseGolden({
    cases: [
      { id: "a", expect: "important", never: ["delete"] },
      { id: "b", expect: "important", never: ["delete"] },
      { id: "c", expect: "delete" },
    ],
  });
  const r = evaluate(cases, [d("a", "delete"), d("b", "keep"), d("c", "keep")]);
  assertEquals(r.failures.length, 3);
  assertEquals(r.criticalFailures, 1);
  assertEquals(r.failures.map((f) => f.critical), [true, false, false]);
});

Deno.test("cases outside the run are reported, not failed", () => {
  const r = evaluate(parseGolden({ cases: [{ id: "gone", expect: "delete" }] }), []);
  assertEquals(r.evaluated, 0);
  assertEquals(r.notInRun, ["gone"]);
});

Deno.test("a malformed golden file is rejected", () => {
  assertThrows(() => parseGolden({ cases: [{ id: "a", expect: "archive" }] }));
  assertThrows(() => parseGolden({}));
  assertThrows(() => parseGolden({ cases: [{ id: "a", expect: "keep", never: ["keep"] }] }));
});
