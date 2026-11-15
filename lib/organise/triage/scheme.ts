/**
 * The four-verdict triage engine as a {@link Scheme}.
 *
 * A thin wrapper: the routes, their order and the default thresholds are the
 * engine's own (`ROUTES`, `DEFAULT_THRESHOLDS`), imported rather than rebuilt,
 * so the scheme decides exactly as `decide()` does.
 *
 * @module
 */

import { parsePolicy } from "../policy.ts";
import {
  labelFor,
  labelPrefixOf,
  ProfileError,
  type Scheme,
  type SchemeDecision,
  type SenderRulings,
} from "../scheme.ts";
import type { Question } from "../types.ts";
import { DEFAULT_LABEL_PATTERN, type Verdict, VERDICTS } from "../verdict.ts";
import {
  decide,
  type DecisionInput,
  mergeThresholds,
  ROUTES,
  type ThresholdOverrides,
  VERDICT_QUESTIONS,
} from "./decide.ts";
import { TRIAGE_DEFAULT_QUESTIONS } from "./questions.ts";

/** How {@link triageScheme} is set up. Every field is optional. */
export interface TriageSchemeOptions {
  /** Default `"triage"`. */
  id?: string;
  /** Default `"organiser/{year}/{verdict}"`. */
  labelPattern?: string;
  /** Per-group overrides of the default thresholds. */
  thresholds?: ThresholdOverrides;
  /** Wording overrides by question id. Ids outside the triage set are refused. */
  questions?: Record<string, Question>;
  /** Sender rulings: verdict → address → note. They outrank every model answer. */
  senders?: SenderRulings;
}

/**
 * The four-verdict engine as a scheme.
 *
 * Throws {@link ProfileError} for a bad label pattern, an unknown question id or
 * threshold group, or sender rulings that name an unknown verdict or rule one
 * address twice.
 */
export function triageScheme(opts: TriageSchemeOptions = {}): Scheme<Verdict> {
  const id = opts.id ?? "triage";
  const labelPattern = opts.labelPattern ?? DEFAULT_LABEL_PATTERN;
  const labelPrefix = labelPrefixOf(labelPattern);

  const known: readonly string[] = VERDICT_QUESTIONS;
  const stray = Object.keys(opts.questions ?? {}).filter((q) => !known.includes(q));
  if (stray.length) {
    throw new ProfileError(`triage scheme "${id}": "${stray[0]}" is not a triage question`);
  }
  const questions = Object.freeze({ ...TRIAGE_DEFAULT_QUESTIONS, ...opts.questions });

  const thresholds = refusing(id, () => mergeThresholds(opts.thresholds));
  const policy = refusing(id, () => parsePolicy(opts.senders ?? {}));

  return {
    id,
    kind: "triage",
    categories: VERDICTS,
    unlabelled: [],
    questions,
    labelPattern,
    labelPrefix,
    decide(msg, answers, ctx): SchemeDecision<Verdict> {
      const input: DecisionInput = {
        id: msg.id,
        from: msg.state.from,
        subject: msg.state.subject,
        date: msg.state.date,
        internalDate: msg.internalDate,
        envelope: msg.envelope,
        answers,
      };
      const d = decide(
        input,
        { policy, relationships: ctx.relationships, thresholds, now: ctx.now },
        ROUTES,
      );
      return {
        id: d.id,
        scheme: id,
        category: d.verdict,
        route: d.route,
        why: d.why,
        sender: d.sender.toLowerCase(),
        subject: d.subject,
      };
    },
    label: (category, internalDate) => labelFor(labelPattern, internalDate, category),
  };
}

/** Run a setup step, turning the engine's own refusals into a ProfileError naming the scheme. */
function refusing<T>(scheme: string, fn: () => T): T {
  try {
    return fn();
  } catch (err) {
    // mergeThresholds refuses an unknown group with a plain Error, parsePolicy with PolicyError.
    if (err instanceof Error) {
      throw new ProfileError(`triage scheme "${scheme}": ${err.message}`, { cause: err });
    }
    throw err;
  }
}
