import { assertEquals, assertThrows } from "@std/assert";
import { parsePolicy, PolicyError } from "../../lib/organise/policy.ts";
import { DEFAULT_LABEL_PATTERN, isVerdict, verdictLabel } from "../../lib/organise/verdict.ts";

Deno.test("a policy maps each address to its verdict, case-insensitively", () => {
  const p = parsePolicy({
    _comment: "ignored",
    delete: { "News@Vendor.test": "newsletter" },
    important: { "exports@data.test": "private data" },
  });
  assertEquals(p.get("news@vendor.test"), { verdict: "delete", note: "newsletter" });
  assertEquals(p.get("exports@data.test")?.verdict, "important");
  assertEquals(p.size, 2);
});

Deno.test("an address ruled under two verdicts is rejected, not last-one-wins", () => {
  assertThrows(
    () => parsePolicy({ delete: { "a@x.test": "" }, keep: { "A@x.test": "" } }),
    PolicyError,
    "ruled both",
  );
});

Deno.test("an unknown verdict is rejected", () => {
  assertThrows(() => parsePolicy({ archive: { "a@x.test": "" } }), PolicyError, "unknown verdict");
});

Deno.test("verdictLabel fills the pattern", () => {
  assertEquals(verdictLabel(DEFAULT_LABEL_PATTERN, 2020, "important"), "organiser/2020/important");
  assertEquals(verdictLabel("triage/{verdict}", 2020, "defer"), "triage/defer");
});

Deno.test("a label pattern without {verdict} would merge every verdict, so it throws", () => {
  assertThrows(() => verdictLabel("organiser/{year}", 2020, "keep"));
});

Deno.test("isVerdict accepts exactly the four verdicts", () => {
  assertEquals(["delete", "defer", "keep", "important"].every(isVerdict), true);
  assertEquals(isVerdict("for-delete"), false);
});
