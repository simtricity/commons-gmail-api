/**
 * The four things a message can be told it is.
 *
 * Every verdict is only a label. `delete` marks mail as disposable; nothing in
 * this package trashes or removes anything, and whoever acts on the label does
 * so separately and deliberately.
 *
 * @module
 */

/** Ordered from least to most worth keeping. */
export const VERDICTS = ["delete", "defer", "keep", "important"] as const;

/**
 * - `delete`: nothing personal and nothing worth keeping.
 * - `defer`: machine mail worth holding a while, whose record lives elsewhere.
 * - `keep`: worth keeping, but not important.
 * - `important`: a durable record, a real relationship, or data held nowhere else.
 */
export type Verdict = typeof VERDICTS[number];

/** Whether a value is one of {@link VERDICTS}. */
export function isVerdict(value: unknown): value is Verdict {
  return typeof value === "string" && (VERDICTS as readonly string[]).includes(value);
}

/** Where verdict labels go unless configured otherwise. */
export const DEFAULT_LABEL_PATTERN = "organiser/{year}/{verdict}";

/**
 * The label name for one verdict.
 *
 * `{verdict}` is required, because a pattern without it would file every verdict
 * under the same label. `{year}` is optional, for a mailbox organised as one pile.
 */
export function verdictLabel(pattern: string, year: number | string, verdict: Verdict): string {
  if (!pattern.includes("{verdict}")) {
    throw new Error(`label pattern "${pattern}" must contain {verdict}`);
  }
  return pattern.replaceAll("{year}", String(year)).replaceAll("{verdict}", verdict);
}
