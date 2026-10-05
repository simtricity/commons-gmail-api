/**
 * The questions put to the decision model, merged across schemes.
 *
 * Every active scheme's questions go to the model in one call per message: the
 * fixed question block is most of each call's input, so a call per scheme would
 * pay for it again each time.
 *
 * @module
 */

import { ProfileError, type Scheme } from "./scheme.ts";
import type { Question } from "./types.ts";

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
