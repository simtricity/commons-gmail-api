/**
 * The profile: which schemes run, and how the decision model is asked.
 *
 * A profile is plain JSON, so it can live beside the data it governs. Every
 * field but `schemes` has a default, and an absent `schemes` means generic
 * triage, so `{}` is a working profile.
 *
 * @module
 */

import { choiceScheme } from "./choice.ts";
import { questionsFor } from "./questions.ts";
import type { RelationshipOptions } from "./relationships.ts";
import { ProfileError, type Scheme, type SenderRulings } from "./scheme.ts";
import type { ThresholdOverrides } from "./triage/decide.ts";
import { triageScheme } from "./triage/scheme.ts";
import type { Question } from "./types.ts";

/** The decision model a profile uses unless it names one. */
export const DEFAULT_MODEL = "jev-latest";

/** Characters of body shown to the model unless the profile says otherwise. */
export const DEFAULT_BODY_CHARS = 2000;

/** Where the sent-mail corpus lives, relative to the data directory, unless the profile says otherwise. */
export const DEFAULT_CORPUS = "derived/corpus.json";

/** One scheme as a profile file declares it. */
export type SchemeSpec =
  | {
    kind: "triage";
    labels?: { pattern?: string };
    thresholds?: ThresholdOverrides;
    questions?: Record<string, Question>;
  }
  | {
    kind: "choice";
    question: { id: string; instructions: unknown; options: Record<string, unknown> };
    labels: { pattern: string };
    unlabelled: string[];
  };

/** A profile as stored, usually `<data>/profile.json`. */
export interface ProfileFile {
  /** Default `"jev-latest"`. */
  model?: string;
  /** Characters of body shown to the model. Default 2000. */
  bodyChars?: number;
  /** Background facts sent with every message as `state.context`. */
  context?: Record<string, unknown>;
  /** Sent-mail corpus, relative to the data directory. Default `derived/corpus.json`. */
  corpus?: string;
  /** How much correspondence makes a relationship. */
  relationships?: RelationshipOptions;
  /** USD per million input tokens, for cost reporting only. Absent: tokens are reported, cost is not. */
  pricePerMTok?: number;
  /** The schemes to run, by id. Absent: one generic triage scheme. */
  schemes?: Record<string, SchemeSpec>;
}

/** A validated profile, its schemes built. */
export interface Profile {
  /** The decision model to ask. */
  model: string;
  /** Characters of body shown to the model. */
  bodyChars: number;
  /** Background facts sent with every message. */
  context?: Record<string, unknown>;
  /** Sent-mail corpus, relative to the data directory. */
  corpus: string;
  /** How much correspondence makes a relationship. */
  relationships?: RelationshipOptions;
  /** USD per million input tokens, when known. */
  pricePerMTok?: number;
  /** In the order the file lists them. */
  schemes: Scheme[];
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  Boolean(v) && typeof v === "object" && !Array.isArray(v);

/**
 * Validate a profile and build its schemes.
 *
 * `senders` holds each scheme's sender rulings, by scheme id. Refuses
 * ({@link ProfileError}): a profile that is not an object; an explicit but empty
 * `schemes`; an unknown kind; a label pattern without `{category}`/`{verdict}`
 * or with an empty prefix; two schemes whose label prefixes are equal or nest;
 * two schemes defining one question id differently; a sender ruling naming an
 * unknown scheme or category; one address under two categories of a scheme.
 */
export function parseProfile(raw: unknown, senders: Record<string, SenderRulings> = {}): Profile {
  if (!isRecord(raw)) throw new ProfileError("a profile must be a JSON object");
  const file = raw as ProfileFile;

  // fallback: a stranger's empty profile gets generic triage.
  const specs = file.schemes === undefined ? { triage: { kind: "triage" as const } } : file.schemes;
  if (!isRecord(specs) || !Object.keys(specs).length) {
    throw new ProfileError(
      `"schemes" must name at least one scheme; leave it out for triage alone`,
    );
  }
  for (const id of Object.keys(senders)) {
    if (!(id in specs)) throw new ProfileError(`sender rulings for unknown scheme "${id}"`);
  }

  const schemes = Object.entries(specs).map(([id, spec]) => buildScheme(id, spec, senders[id]));
  for (let i = 0; i < schemes.length; i++) {
    for (let j = i + 1; j < schemes.length; j++) {
      const [a, b] = [schemes[i], schemes[j]];
      if (a.labelPrefix.startsWith(b.labelPrefix) || b.labelPrefix.startsWith(a.labelPrefix)) {
        throw new ProfileError(
          `schemes "${a.id}" and "${b.id}" share label space ("${a.labelPrefix}", "${b.labelPrefix}")`,
        );
      }
    }
  }
  questionsFor(schemes);

  const bodyChars = file.bodyChars ?? DEFAULT_BODY_CHARS;
  if (!Number.isInteger(bodyChars) || bodyChars <= 0) {
    throw new ProfileError(`"bodyChars" must be a positive whole number`);
  }
  if (file.pricePerMTok !== undefined && !(file.pricePerMTok >= 0)) {
    throw new ProfileError(`"pricePerMTok" must be a number of US dollars, zero or more`);
  }
  if (file.context !== undefined && !isRecord(file.context)) {
    throw new ProfileError(`"context" must be an object`);
  }
  return {
    model: file.model ?? DEFAULT_MODEL,
    bodyChars,
    context: file.context,
    corpus: file.corpus ?? DEFAULT_CORPUS,
    relationships: file.relationships,
    pricePerMTok: file.pricePerMTok,
    schemes,
  };
}

function buildScheme(id: string, spec: unknown, senders: SenderRulings | undefined): Scheme {
  if (!isRecord(spec)) throw new ProfileError(`scheme "${id}" must be an object`);
  if (spec.kind === "triage") {
    const s = spec as Extract<SchemeSpec, { kind: "triage" }>;
    return triageScheme({
      id,
      labelPattern: s.labels?.pattern,
      thresholds: s.thresholds,
      questions: s.questions,
      senders,
    });
  }
  if (spec.kind === "choice") {
    const s = spec as Extract<SchemeSpec, { kind: "choice" }>;
    if (
      !isRecord(s.question) || typeof s.question.id !== "string" || !isRecord(s.question.options)
    ) {
      throw new ProfileError(`choice scheme "${id}" needs a question with an id and options`);
    }
    if (typeof s.labels?.pattern !== "string") {
      throw new ProfileError(`choice scheme "${id}" needs labels.pattern`);
    }
    if (!Array.isArray(s.unlabelled)) {
      throw new ProfileError(`choice scheme "${id}" needs an "unlabelled" list`);
    }
    return choiceScheme({
      id,
      question: s.question,
      labelPattern: s.labels.pattern,
      unlabelled: s.unlabelled,
      senders,
    });
  }
  throw new ProfileError(`scheme "${id}" has unknown kind "${String(spec.kind)}"`);
}
