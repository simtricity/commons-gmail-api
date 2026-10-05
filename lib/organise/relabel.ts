/**
 * Turning one scheme's decisions into label changes.
 *
 * @module
 */

import type { OrganiseMessage } from "./message.ts";
import type { Scheme, SchemeDecision } from "./scheme.ts";

/** One batch of identical label changes. */
export interface RelabelGroup {
  /** The label to add. Absent for an unlabelled category. */
  add?: string;
  /** The scheme's other labels for the same year, sorted. */
  remove: string[];
  /** The messages to change, sorted. */
  ids: string[];
}

/**
 * Group decisions into label changes, ordered by year then category order.
 *
 * Each group adds the category's label and removes the scheme's labels for
 * every other category of that year, in the same call, so a message is never
 * momentarily unlabelled or doubly labelled. An unlabelled category only
 * removes.
 *
 * Messages are grouped by year only when the label pattern carries `{year}`.
 * Without it every year's label is the same, so one group per category carries
 * the whole change rather than one identical group per year.
 *
 * Decisions of other schemes are ignored. Throws for a decision whose message
 * is not in `messages`, or whose category the scheme does not have.
 */
export function relabelPlan(
  scheme: Scheme,
  decisions: readonly SchemeDecision[],
  messages: readonly Pick<OrganiseMessage, "id" | "internalDate">[],
): RelabelGroup[] {
  const dates = new Map(messages.map((m) => [m.id, m.internalDate]));
  const byYear = scheme.labelPattern.includes("{year}");
  const groups = new Map<string, { year: number; category: string; date: string; ids: string[] }>();

  for (const d of decisions) {
    if (d.scheme !== scheme.id) continue;
    const date = dates.get(d.id);
    if (date === undefined) throw new Error(`relabelPlan: no message ${d.id} for its decision`);
    if (!scheme.categories.includes(d.category)) {
      throw new Error(`relabelPlan: "${d.category}" is not a category of "${scheme.id}"`);
    }
    const year = byYear ? utcYear(date) : 0;
    const key = `${year}\u0000${d.category}`;
    const g = groups.get(key) ?? { year, category: d.category, date, ids: [] };
    g.ids.push(d.id);
    groups.set(key, g);
  }

  const order = (c: string) => scheme.categories.indexOf(c);
  return [...groups.values()]
    .sort((a, b) => a.year - b.year || order(a.category) - order(b.category))
    .map(({ category, date, ids }) => {
      const add = scheme.label(category, date);
      const remove = scheme.categories
        .filter((c) => c !== category)
        .map((c) => scheme.label(c, date))
        .filter((l): l is string => l !== undefined)
        .sort();
      return add === undefined ? { remove, ids: ids.sort() } : { add, remove, ids: ids.sort() };
    });
}

function utcYear(internalDate: string): number {
  const ms = Number(internalDate);
  // fallback: an unparseable date groups with the epoch year, as labelFor names it.
  return new Date(Number.isFinite(ms) ? ms : 0).getUTCFullYear();
}
