/**
 * Sender rulings: the account holder's word on a sender, which outranks every model.
 *
 * They encode what no model can know, such as that one machine-sent export holds
 * valuable private data while another newsletter from the same company does not.
 * They also make a sender's mail consistent, which judging each message near a
 * threshold is not.
 *
 * The file is `{ "<verdict>": { "<address>": "<why>" } }`. Keys starting with
 * `_` are comments.
 *
 * @module
 */

import { isVerdict, type Verdict } from "./verdict.ts";

/** The ruling on one sender. */
export interface Ruling {
  /** The verdict every message from this sender gets. */
  verdict: Verdict;
  /** Why, as written in the policy file. */
  note: string;
}

/** Rulings keyed by lower-cased sender address. */
export type SenderPolicy = ReadonlyMap<string, Ruling>;

/** Thrown for a policy file that would rule ambiguously. */
export class PolicyError extends Error {
  /** `message` names the offending verdict or address. */
  constructor(message: string) {
    super(message);
    this.name = "PolicyError";
  }
}

/**
 * Parse and validate. An address ruled under two verdicts is an error rather
 * than last-one-wins, because the outcome would depend on key order.
 */
export function parsePolicy(raw: unknown): SenderPolicy {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new PolicyError("sender policy must be an object keyed by verdict");
  }
  const out = new Map<string, Ruling>();
  for (const [key, section] of Object.entries(raw as Record<string, unknown>)) {
    if (key.startsWith("_")) continue;
    if (!isVerdict(key)) throw new PolicyError(`unknown verdict "${key}" in sender policy`);
    if (!section || typeof section !== "object") {
      throw new PolicyError(`sender policy "${key}" must map addresses to reasons`);
    }
    for (const [address, note] of Object.entries(section as Record<string, unknown>)) {
      const a = address.trim().toLowerCase();
      const prior = out.get(a);
      if (prior) {
        throw new PolicyError(`${a} is ruled both "${prior.verdict}" and "${key}"`);
      }
      out.set(a, { verdict: key, note: String(note ?? "") });
    }
  }
  return out;
}
