/**
 * Choosing which messages a run looks at.
 *
 * Listing is cheap and Gmail returns each message's `threadId` beside its `id`,
 * so thread sizes and reply history come free, without reading any message.
 *
 * @module
 */

/** A message as a listing returns it, before any read. */
export interface Listed {
  /** Gmail message id. */
  id: string;
  /** Gmail thread id. */
  threadId: string;
}

/**
 * Messages worth judging on their own.
 *
 * A thread you ever sent into is a conversation, not a standalone, so it is
 * never a candidate. With `singleMessage`, only threads holding exactly one of
 * the listed messages qualify; that count is within the listing only, so the
 * fetch stage confirms it against the whole thread.
 */
export function candidatesOf(
  listed: readonly Listed[],
  sentThreads: ReadonlySet<string>,
  singleMessage: boolean,
): Listed[] {
  const size = new Map<string, number>();
  for (const m of listed) size.set(m.threadId, (size.get(m.threadId) ?? 0) + 1);
  return listed.filter((m) =>
    !sentThreads.has(m.threadId) && (!singleMessage || size.get(m.threadId) === 1)
  );
}

/**
 * Fisher–Yates over a fixed linear congruential generator, so a seed always
 * draws the same sample and a trial can be repeated against the same mail.
 * Not for anything that needs real randomness.
 */
export function seededShuffle<T>(items: readonly T[], seed: number): T[] {
  let s = seed;
  const rand = () => (s = (s * 1103515245 + 12345) % 2147483648) / 2147483648;
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}
