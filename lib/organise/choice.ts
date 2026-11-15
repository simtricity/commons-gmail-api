/**
 * A declarative scheme: one Choice question, whose winning option is the category.
 *
 * @module
 */

import { senderIdentity } from "./envelope.ts";
import {
  labelFor,
  labelPrefixOf,
  ProfileError,
  type Scheme,
  type SchemeDecision,
  type SenderRulings,
} from "./scheme.ts";

/** How {@link choiceScheme} is set up. */
export interface ChoiceSchemeOptions {
  /** Unique within a profile. */
  id: string;
  /** One Choice question: its id, its instructions, and its options with their descriptions. */
  question: { id: string; instructions: unknown; options: Record<string, unknown> };
  /** Label name template; see {@link Scheme}. */
  labelPattern: string;
  /** Options that carry no label. At least one is required: it is where an unanswered message goes. */
  unlabelled: string[];
  /** Sender rulings: option → address → note. They outrank the model's answer. */
  senders?: SenderRulings;
}

/**
 * A declarative scheme: the Choice's winning option is the category.
 *
 * Order: a sender ruling (route `policy`); a missing answer or an option outside
 * the list → the first unlabelled category (route `incomplete`); otherwise the
 * chosen option (route `choice`). Choice confidence is reported in `why` and
 * never gates anything.
 *
 * Throws {@link ProfileError} for a bad label pattern, a question with no
 * options, no unlabelled option or one that is not an option, or sender rulings
 * naming an unknown option or one address twice.
 */
export function choiceScheme(opts: ChoiceSchemeOptions): Scheme<string> {
  const { id, question, labelPattern } = opts;
  const labelPrefix = labelPrefixOf(labelPattern);
  const categories = Object.keys(question.options ?? {});
  if (!categories.length) throw new ProfileError(`choice scheme "${id}" has no options`);
  if (!opts.unlabelled.length) {
    throw new ProfileError(
      `choice scheme "${id}" needs an unlabelled option for unanswered messages`,
    );
  }
  const stray = opts.unlabelled.find((u) => !categories.includes(u));
  if (stray) throw new ProfileError(`choice scheme "${id}": "${stray}" is not an option`);
  const unlabelled = [...opts.unlabelled];
  const rulings = rulingsByAddress(id, opts.senders ?? {}, categories);

  const questions = Object.freeze({
    [question.id]: {
      type: "choice" as const,
      instructions: question.instructions,
      criteria: question.options,
    },
  });

  return {
    id,
    kind: "choice",
    categories,
    unlabelled,
    questions,
    labelPattern,
    labelPrefix,
    decide(msg, answers): SchemeDecision<string> {
      const sender = senderIdentity(msg.envelope).toLowerCase();
      const base = { id: msg.id, scheme: id, sender, subject: msg.state.subject };
      const ruled = rulings.get(sender);
      if (ruled) {
        return { ...base, category: ruled, route: "policy", why: `sender policy: ${ruled}` };
      }

      const answer = answers[question.id];
      const choice = answer?.choice;
      if (choice === undefined || !categories.includes(choice)) {
        const why = choice === undefined ? "unanswered" : `"${choice}" is not an option`;
        return { ...base, category: unlabelled[0], route: "incomplete", why };
      }
      const confidence = answer?.confidence;
      const why = confidence === undefined
        ? `chose ${choice}`
        : `chose ${choice} (confidence ${confidence.toFixed(2)})`;
      return { ...base, category: choice, route: "choice", why };
    },
    label: (category, internalDate) =>
      unlabelled.includes(category) ? undefined : labelFor(labelPattern, internalDate, category),
  };
}

/** Sender rulings flattened to address → category, refusing what would rule ambiguously. */
function rulingsByAddress(
  scheme: string,
  rulings: SenderRulings,
  categories: readonly string[],
): Map<string, string> {
  const out = new Map<string, string>();
  for (const [category, addresses] of Object.entries(rulings)) {
    if (category.startsWith("_")) continue;
    if (!categories.includes(category)) {
      throw new ProfileError(
        `scheme "${scheme}": sender ruling under unknown category "${category}"`,
      );
    }
    for (const address of Object.keys(addresses ?? {})) {
      const a = address.trim().toLowerCase();
      const prior = out.get(a);
      if (prior) {
        throw new ProfileError(
          `scheme "${scheme}": ${a} is ruled both "${prior}" and "${category}"`,
        );
      }
      out.set(a, category);
    }
  }
  return out;
}
