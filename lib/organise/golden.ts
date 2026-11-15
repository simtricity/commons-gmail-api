/**
 * A golden set: messages the account holder has ruled on, replayed against the engine.
 *
 * Every time someone says "this one should have gone" or "never lose this", that
 * ruling becomes a case. Re-deciding is free, so every threshold change and every
 * new route is scored against all of them before it touches a label.
 *
 * @module
 */

import { ProfileError, type SchemeDecision } from "./scheme.ts";
import { type Verdict, VERDICTS } from "./verdict.ts";

/** One ruled message and the categories it may get under one scheme. */
export interface GoldenCase {
  /** Gmail message id. */
  id: string;
  /** The scheme ruled on. Default `"triage"`; {@link parseGolden} fills it in. */
  scheme?: string;
  /** The category wanted, or several that are all acceptable. */
  expect: string | string[];
  /** Why it was ruled this way, for whoever reads a failure. */
  note?: string;
  /**
   * Categories that would be a critical failure rather than a miss: a must-keep
   * record landing in `delete`, say. A critical failure fails the evaluation.
   */
  never?: string[];
}

const isText = (v: unknown): v is string => typeof v === "string" && v.length > 0;

/**
 * Parse and validate a golden set shaped `{ "cases": [...] }`.
 *
 * Every returned case has `scheme` set, `"triage"` when absent. With
 * `categories` (scheme id → its categories), each case's `expect` and `never`
 * must be categories of its scheme, and a scheme missing from it is refused;
 * without, triage cases are still checked against the four verdicts. Throws
 * {@link ProfileError} on a case with no `id`, an unknown category, or one
 * listed under both `expect` and `never`.
 */
export function parseGolden(
  raw: unknown,
  categories?: Readonly<Record<string, readonly string[]>>,
): GoldenCase[] {
  const cases = (raw as { cases?: unknown })?.cases;
  if (!Array.isArray(cases)) throw new ProfileError(`golden set needs a "cases" array`);
  return cases.map((c, i) => checkCase(c, `golden case ${i}`, categories));
}

/** Validate one case as {@link parseGolden} does, returning it with `scheme` filled in. */
export function checkCase(
  c: unknown,
  where: string,
  categories?: Readonly<Record<string, readonly string[]>>,
): GoldenCase {
  const k = c as Partial<GoldenCase> | undefined;
  const scheme = k?.scheme ?? "triage";
  const expect = [k?.expect].flat();
  if (!isText(k?.id) || !isText(scheme) || !expect.length || !expect.every(isText)) {
    throw new ProfileError(`${where} needs an "id" and an "expect" of categories`);
  }
  const never = k.never ?? [];
  if (!Array.isArray(never) || !never.every(isText)) {
    throw new ProfileError(`${where}: "never" must be a list of categories`);
  }
  const allowed = categories
    ? categories[scheme]
    : scheme === "triage"
    ? (VERDICTS as readonly string[])
    : undefined;
  if (categories && !allowed) throw new ProfileError(`${where}: unknown scheme "${scheme}"`);
  const stray = allowed && [...expect, ...never].find((v) => !allowed.includes(v));
  if (stray) throw new ProfileError(`${where}: "${stray}" is not a category of "${scheme}"`);
  if (never.some((v) => expect.includes(v))) {
    throw new ProfileError(`${where} expects a category it also lists under "never"`);
  }
  return { ...k, scheme } as GoldenCase;
}

/** One case the run decided differently from its ruling. */
export interface GoldenFailure {
  /** The case that failed. */
  case: GoldenCase;
  /** The verdict the run gave. */
  got: Verdict;
  /** The route that gave it. */
  route: string;
  /** That route's reason. */
  why: string;
  /** Whether `got` is one of the case's `never` verdicts. */
  critical: boolean;
}

/** A golden set replayed against one run's decisions. */
export interface EvalResult {
  /** Cases whose message is in the run. */
  evaluated: number;
  /** Evaluated cases that got an acceptable verdict. */
  passed: number;
  /** Every evaluated case that did not, critical or not. */
  failures: GoldenFailure[];
  /** How many failures are critical. Any at all fails the evaluation. */
  criticalFailures: number;
  /** Cases whose message this run did not decide. */
  notInRun: string[];
}

/**
 * Score a run's decisions against a golden set.
 *
 * A case whose message the run did not decide is listed in `notInRun`, not counted as a
 * failure.
 */
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

/** One case a scheme decided differently from its ruling. */
export interface ScoreFailure {
  /** The case that failed. */
  case: GoldenCase;
  /** The category the run gave. */
  got: string;
  /** The rule that gave it. */
  route: string;
  /** That rule's reason. */
  why: string;
  /** Whether `got` is one of the case's `never` categories. */
  critical: boolean;
}

/** One scheme's decisions scored against its golden cases. */
export interface ScoreResult {
  /** The scheme scored. */
  scheme: string;
  /** Cases whose message is in the run. */
  evaluated: number;
  /** Evaluated cases that got an acceptable category. */
  passed: number;
  /** Every evaluated case that did not, critical or not. */
  failures: ScoreFailure[];
  /** How many failures are critical. Any at all fails the score. */
  criticalFailures: number;
  /** Ids of cases whose message this run did not decide. */
  notInRun: string[];
}

/**
 * Score one scheme's decisions against the cases for that scheme only.
 *
 * A case without `scheme` counts as triage. Decisions of other schemes are
 * ignored, so one run's decisions for every scheme can be passed together.
 */
export function score(
  cases: readonly GoldenCase[],
  decisions: readonly SchemeDecision[],
  scheme: string,
): ScoreResult {
  const byId = new Map(decisions.filter((d) => d.scheme === scheme).map((d) => [d.id, d]));
  const out: ScoreResult = {
    scheme,
    evaluated: 0,
    passed: 0,
    failures: [],
    criticalFailures: 0,
    notInRun: [],
  };
  for (const c of cases) {
    if ((c.scheme ?? "triage") !== scheme) continue;
    const d = byId.get(c.id);
    if (!d) {
      out.notInRun.push(c.id);
      continue;
    }
    out.evaluated++;
    if ([c.expect].flat().includes(d.category)) {
      out.passed++;
      continue;
    }
    const critical = Boolean(c.never?.includes(d.category));
    out.failures.push({ case: c, got: d.category, route: d.route, why: d.why, critical });
    if (critical) out.criticalFailures++;
  }
  return out;
}
