/**
 * Pacing, retry and concurrency.
 *
 * `@simtricity-commons/gmail-api` deliberately ships none of these, so any job
 * that walks a large mailbox has to supply them. They live here rather than in
 * that read-only client, which other services import.
 *
 * @module
 */

/**
 * Gmail signals quota exhaustion as **403 rateLimitExceeded**, not 429.
 * Treating 403 as fatal discards every message the moment the per-minute
 * ceiling is touched. Genuine permission failures are also 403, so the reason
 * string decides which is which.
 */
const QUOTA_403 = /rateLimitExceeded|userRateLimitExceeded|Quota exceeded|RESOURCE_EXHAUSTED/i;

function statusOf(err: unknown): number | undefined {
  const s = (err as { status?: unknown })?.status;
  return typeof s === "number" ? s : undefined;
}

/** Back off on quota and 5xx. Give up on every other 4xx. */
export function isRetryable(err: unknown): boolean {
  const status = statusOf(err);
  if (status === 403) return QUOTA_403.test(String((err as Error)?.message ?? err));
  if (typeof status === "number") return status === 429 || status >= 500;
  // fallback: a bare network failure carries no status and is worth another go
  // rather than losing the whole run.
  return err instanceof TypeError;
}

/** How {@link withRetry} retries. */
export interface RetryOptions {
  /** Total tries, the first included. Default 6. */
  attempts?: number;
  /**
   * First backoff for a server error or network failure, in ms. Default 500. A quota refusal
   * (429, or a rate-limit 403) starts at 8 s instead, because quota windows are minutes long.
   */
  baseMs?: number;
  /** Called before each sleep, for progress reporting. */
  onRetry?: (attempt: number, waitMs: number, err: unknown) => void;
}

/**
 * Call `fn`, retrying quota refusals, 5xx responses and network failures.
 *
 * Backoff doubles per attempt with random jitter, each wait capped at 75 s. Any other
 * error, and the last attempt's, is rethrown.
 */
export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const { attempts = 6, baseMs = 500, onRetry } = opts;
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (!isRetryable(err) || i === attempts - 1) throw err;
      // Quota windows are measured in minutes, so backoff in hundreds of
      // milliseconds can never clear one.
      const code = statusOf(err);
      const base = code === 429 || code === 403 ? 8000 : baseMs;
      const wait = Math.min(75_000, base * 2 ** i) + Math.random() * base;
      onRetry?.(i + 1, wait, err);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
  throw lastErr;
}

/**
 * Token bucket, so a job paces itself rather than discovering the ceiling by
 * hitting it. Gmail allows a fixed number of quota units per minute per user
 * and a message read costs five of them.
 */
export class RateLimiter {
  private tokens: number;
  private last = performance.now();

  /**
   * `ratePerSec` is the sustained rate. `burst` is how many can be taken at once after a
   * pause, and defaults to `ratePerSec`.
   */
  constructor(private ratePerSec: number, private burst = ratePerSec) {
    this.tokens = burst;
  }

  /** Wait until a token is free, then take it. */
  async take(): Promise<void> {
    while (true) {
      const now = performance.now();
      this.tokens = Math.min(
        this.burst,
        this.tokens + ((now - this.last) / 1000) * this.ratePerSec,
      );
      this.last = now;
      if (this.tokens >= 1) {
        this.tokens -= 1;
        return;
      }
      await new Promise((r) =>
        setTimeout(r, Math.max(10, ((1 - this.tokens) / this.ratePerSec) * 1000))
      );
    }
  }
}

/**
 * Run `worker` over `items` with at most `limit` in flight. Results keep the
 * input order. A worker that throws is reported through `onError` and its slot
 * is left undefined, so one bad message never aborts a long run.
 */
export async function pool<A, B>(
  items: readonly A[],
  limit: number,
  worker: (item: A, index: number) => Promise<B>,
  hooks: {
    onProgress?: (done: number, total: number) => void;
    onError?: (item: A, err: unknown) => void;
  } = {},
): Promise<(B | undefined)[]> {
  const results = new Array<B | undefined>(items.length);
  let next = 0;
  let done = 0;

  async function run(): Promise<void> {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      try {
        results[i] = await worker(items[i], i);
      } catch (err) {
        hooks.onError?.(items[i], err);
      }
      hooks.onProgress?.(++done, items.length);
    }
  }

  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, run));
  return results;
}
