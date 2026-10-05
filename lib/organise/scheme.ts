/**
 * Schemes: ways of categorising mail.
 *
 * A scheme asks the decision model some questions, turns the answers into one
 * category per message with a pure `decide`, and names a label for each
 * category. Several schemes can run over the same messages, each under its own
 * label prefix, so they never touch one another's labels.
 *
 * @module
 */

import type { OrganiseMessage } from "./message.ts";
import type { Relationships } from "./relationships.ts";
import type { Answer, Question } from "./types.ts";

/** Answers by question id. A missing id means the question was never answered. */
export type Answers = Record<string, Answer | undefined>;

/** One message's category under one scheme. */
export interface SchemeDecision<C extends string = string> {
  /** Gmail message id. */
  id: string;
  /** The deciding scheme's id. */
  scheme: string;
  /** The category the message falls in. */
  category: C;
  /** The rule that decided: a triage route name, or `policy`, `choice`, `incomplete`. */
  route: string;
  /** A one-line reason. */
  why: string;
  /** Sender identity (`senderIdentity`), lower-cased. */
  sender: string;
  /** The `Subject` header. */
  subject: string;
}

/** What a scheme may consult besides the message and its answers. */
export interface SchemeContext {
  /** ms since epoch. Injected, so a decision is reproducible. */
  now: number;
  /** Who you have corresponded with. */
  relationships: Relationships;
}

/**
 * One way of categorising mail.
 *
 * `decide` is pure. Label names come only from `labelPattern`, whose
 * placeholders are `{year}` (the message's UTC year from `internalDate`) and
 * `{category}` (`{verdict}` is accepted as an alias). `labelPrefix` is the
 * literal text before the first placeholder; it is non-empty, ends in `/`, and
 * every label the scheme can produce starts with it.
 */
export interface Scheme<C extends string = string> {
  /** Unique within a profile. */
  readonly id: string;
  /** Which builder made it. */
  readonly kind: "triage" | "choice";
  /** Every category a message can get, in display order. */
  readonly categories: readonly C[];
  /** Categories that carry no label, e.g. a choice scheme's `none`. */
  readonly unlabelled: readonly C[];
  /** The questions this scheme needs answered, by id. */
  readonly questions: Readonly<Record<string, Question>>;
  /** The label name template. */
  readonly labelPattern: string;
  /** The literal start every label of this scheme shares. */
  readonly labelPrefix: string;
  /** Categorise one message. Pure. */
  decide(msg: OrganiseMessage, answers: Answers, ctx: SchemeContext): SchemeDecision<C>;
  /** The label for a category, or `undefined` for an unlabelled one. */
  label(category: C, internalDate: string): string | undefined;
}

/** Sender rulings for one scheme, as stored: category → address → note. */
export type SenderRulings = Record<string, Record<string, string>>;

/** Refused profile, scheme or rulings. Nothing was written. */
export class ProfileError extends Error {
  /** Error class name, stable across minification. */
  override name = "ProfileError";
}

const PLACEHOLDER = /\{([^}]*)\}/g;
const KNOWN = new Set(["year", "category", "verdict"]);

/**
 * The label prefix of a pattern: the literal text before its first placeholder.
 *
 * Throws {@link ProfileError} when the pattern has no `{category}` (or
 * `{verdict}`), uses an unknown placeholder, or its prefix is empty or does not
 * end in `/`. A prefix that ends in `/` is what lets the scoped writer prove a
 * scheme can only ever touch its own labels.
 */
export function labelPrefixOf(pattern: string): string {
  const names = [...pattern.matchAll(PLACEHOLDER)].map((m) => m[1]);
  const unknown = names.filter((n) => !KNOWN.has(n));
  if (unknown.length) {
    throw new ProfileError(`label pattern "${pattern}" has unknown placeholder {${unknown[0]}}`);
  }
  if (!names.includes("category") && !names.includes("verdict")) {
    throw new ProfileError(`label pattern "${pattern}" must contain {category}`);
  }
  const prefix = pattern.slice(0, pattern.indexOf("{"));
  if (!prefix || !prefix.endsWith("/")) {
    throw new ProfileError(
      `label pattern "${pattern}" must start with a fixed prefix ending in "/", e.g. "sorted/"`,
    );
  }
  return prefix;
}

/** The label for `category` on a message received at `internalDate` (ms since epoch). */
export function labelFor(pattern: string, internalDate: string, category: string): string {
  const ms = Number(internalDate);
  // fallback: an unparseable date labels as the epoch year rather than "NaN".
  const year = new Date(Number.isFinite(ms) ? ms : 0).getUTCFullYear();
  return pattern.replaceAll("{year}", String(year)).replaceAll("{category}", category)
    .replaceAll("{verdict}", category);
}
