/**
 * The questions put to the decision model, merged across schemes.
 *
 * Every active scheme's questions go to the model in one call per message: the
 * fixed question block is most of each call's input, so a call per scheme would
 * pay for it again each time.
 *
 * @module
 */

import { sha256Hex } from "../mime.ts";
import { ProfileError, type Scheme } from "./scheme.ts";
import type { Answer, Question } from "./types.ts";

/**
 * JSON with every object's keys sorted, recursively, so two values that differ
 * only in key order serialise identically. Arrays keep their order.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>).sort().map((
        k,
      ) => [k, sortKeys((value as Record<string, unknown>)[k])]),
    );
  }
  return value;
}

/**
 * Union of the schemes' questions.
 *
 * Throws {@link ProfileError} when two schemes define one question id
 * differently, because the model would be asked only one of them and one
 * scheme would read an answer to a question it never asked. Identical
 * definitions, in any key order, are merged.
 */
export function questionsFor(schemes: readonly Scheme[]): Record<string, Question> {
  const out: Record<string, Question> = {};
  const owner: Record<string, string> = {};
  for (const scheme of schemes) {
    for (const [id, question] of Object.entries(scheme.questions)) {
      if (id in out && canonicalJson(out[id]) !== canonicalJson(question)) {
        throw new ProfileError(
          `question "${id}" is defined differently by schemes "${owner[id]}" and "${scheme.id}"`,
        );
      }
      out[id] = question;
      owner[id] ??= scheme.id;
    }
  }
  return out;
}

/** What, besides the question, changes the answer: the context and the body cap. Not the model. */
export interface JudgementShape {
  /** The background facts sent with every message, if any. */
  context?: unknown;
  /** Characters of body shown to the model. */
  bodyChars: number;
}

/**
 * A fingerprint of everything that determines one question's answer: 16 hex
 * characters, stable across key order.
 *
 * The model is deliberately left out. A model alias moves over time, and
 * re-asking every stored question whenever it moved would cost a full re-judge
 * for no change in the question.
 */
export async function questionHash(question: Question, shape: JudgementShape): Promise<string> {
  const text = canonicalJson({
    question,
    context: shape.context ?? null,
    bodyChars: shape.bodyChars,
  });
  return (await sha256Hex(new TextEncoder().encode(text))).slice(0, 16);
}

/** One message's stored answers, with the hash each answer was asked under. */
export interface StoredAnswers {
  /** Gmail message id. */
  id: string;
  /** Answers by question id. */
  answers: Record<string, Answer>;
  /** The {@link questionHash} each answer was asked under, by question id. */
  asked: Record<string, string>;
}

/**
 * Question ids to ask: never answered, or answered under a different hash.
 *
 * Rewording one question changes only its hash, so only it is asked again.
 */
export function pendingQuestions(
  stored: StoredAnswers | undefined,
  hashes: Readonly<Record<string, string>>,
): string[] {
  return Object.keys(hashes).filter((id) =>
    !stored?.answers[id] || stored.asked[id] !== hashes[id]
  );
}
