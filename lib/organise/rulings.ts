/**
 * Recording rulings: a golden case for a message, a category for a sender.
 *
 * Both return new values and never mutate their input, so a caller can validate
 * a ruling before writing anything.
 *
 * @module
 */

import { checkCase, type GoldenCase } from "./golden.ts";
import { ProfileError, type SenderRulings } from "./scheme.ts";

/**
 * Add a case, replacing any case with the same scheme and id. Validates like
 * `parseGolden` (triage cases against the four verdicts), throwing
 * {@link ProfileError}.
 */
export function withRuling(cases: readonly GoldenCase[], ruling: GoldenCase): GoldenCase[] {
  const c = checkCase(ruling, `ruling for ${ruling?.id}`);
  const same = (x: GoldenCase) => x.id === c.id && (x.scheme ?? "triage") === c.scheme;
  return cases.some(same) ? cases.map((x) => same(x) ? c : x) : [...cases, c];
}

/**
 * Put `address` under `category`, removing it from every other category, so an
 * address is never ruled twice. Throws {@link ProfileError} for a category
 * outside `categories`. Addresses are stored lower-cased; a category left empty
 * is dropped.
 */
export function withSenderRuling(
  rulings: SenderRulings,
  address: string,
  category: string,
  note: string,
  categories: readonly string[],
): SenderRulings {
  if (!categories.includes(category)) {
    throw new ProfileError(`"${category}" is not one of ${categories.join(", ")}`);
  }
  const a = address.trim().toLowerCase();
  const out: SenderRulings = {};
  for (const [c, addresses] of Object.entries(rulings)) {
    const kept = Object.fromEntries(
      Object.entries(addresses).filter(([x]) => x.trim().toLowerCase() !== a),
    );
    if (Object.keys(kept).length || c.startsWith("_")) out[c] = kept;
  }
  out[category] = { ...out[category], [a]: note };
  return out;
}
