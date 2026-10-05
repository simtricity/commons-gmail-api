/**
 * A golden set: messages the operator has ruled on, replayed against the engine.
 *
 * Every time someone says "this one should have gone" or "never lose this", that
 * ruling becomes a case. Re-deciding is free, so every threshold change and every
 * new route is scored against all of them before it touches a label.
 *
 * @module
 */

import { isVerdict, type Verdict } from "./verdict.ts";

export interface GoldenCase {
  id: string;
  /** The verdict wanted, or several that are all acceptable. */
  expect: Verdict | Verdict[];
  note?: string;
  /**
   * Verdicts that would be a critical failure rather than a miss: a must-keep
   * record landing in `delete`, say. A critical failure fails the evaluation.
   */
  never?: Verdict[];
}

export function parseGolden(raw: unknown): GoldenCase[] {
  const cases = (raw as { cases?: unknown })?.cases;
  if (!Array.isArray(cases)) throw new Error(`golden set needs a "cases" array`);
  return cases.map((c, i) => {
    const expect = [c?.expect].flat();
    if (typeof c?.id !== "string" || !expect.length || !expect.every(isVerdict)) {
      throw new Error(`golden case ${i} needs an "id" and an "expect" of verdicts`);
    }
    const never = c.never ?? [];
    if (!Array.isArray(never) || !never.every(isVerdict)) {
      throw new Error(`golden case ${i}: "never" must be a list of verdicts`);
    }
    if (never.some((v: Verdict) => expect.includes(v))) {
      throw new Error(`golden case ${i} expects a verdict it also lists under "never"`);
    }
    return c as GoldenCase;
  });
}

export interface GoldenFailure {
  case: GoldenCase;
  got: Verdict;
  route: string;
  why: string;
  critical: boolean;
}

export interface EvalResult {
  /** Cases whose message is in the run. */
  evaluated: number;
  passed: number;
  failures: GoldenFailure[];
  criticalFailures: number;
  /** Cases whose message this run did not decide. */
  notInRun: string[];
}

export function evaluate(
  cases: GoldenCase[],
  decisions: Iterable<{ id: string; verdict: Verdict; route: string; why: string }>,
): EvalResult {
  const byId = new Map([...decisions].map((d) => [d.id, d]));
  const out: EvalResult = {
    evaluated: 0,
    passed: 0,
    failures: [],
    criticalFailures: 0,
    notInRun: [],
  };
  for (const c of cases) {
    const d = byId.get(c.id);
    if (!d) {
      out.notInRun.push(c.id);
      continue;
    }
    out.evaluated++;
    if ([c.expect].flat().includes(d.verdict)) {
      out.passed++;
      continue;
    }
    const critical = Boolean(c.never?.includes(d.verdict));
    out.failures.push({ case: c, got: d.verdict, route: d.route, why: d.why, critical });
    if (critical) out.criticalFailures++;
  }
  return out;
}
