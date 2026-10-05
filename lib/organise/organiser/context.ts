/**
 * What every stage shares: the data directory, the injected clients, the
 * profile, and Gmail pacing.
 *
 * @module
 */

import type { GoldenCase } from "../golden.ts";
import type { Profile } from "../profile.ts";
import { ProfileError, type Scheme, type SenderRulings } from "../scheme.ts";
import { RateLimiter, type RetryOptions, withRetry } from "../throttle.ts";
import type { Layout } from "./store.ts";
import type { OrganiserGmail, OrganiserIO } from "./types.ts";

/** The state one {@link Organiser} hands each stage. */
export interface StageContext {
  dataDir: string;
  files: Layout;
  io: OrganiserIO;
  profile: Profile;
  senders: Record<string, SenderRulings>;
  golden: GoldenCase[];
}

/** The injected clock, as ms since epoch. */
export const nowOf = (ctx: StageContext): number => (ctx.io.now ?? Date.now)();

/** The injected clock, as an ISO timestamp. */
export const isoNow = (ctx: StageContext): string => new Date(nowOf(ctx)).toISOString();

/** A progress line, if the caller wants them. */
export const say = (ctx: StageContext, line: string): void => ctx.io.log?.(line);

/** The scheme by id, or a ProfileError naming the ones there are. */
export function schemeOf(ctx: StageContext, id: string): Scheme {
  const s = ctx.profile.schemes.find((x) => x.id === id);
  if (!s) {
    throw new ProfileError(
      `no scheme "${id}"; the profile has ${ctx.profile.schemes.map((x) => x.id).join(", ")}`,
    );
  }
  return s;
}

/** The chosen schemes, or every scheme when none are named. */
export function schemesOf(ctx: StageContext, ids?: readonly string[]): Scheme[] {
  return ids?.length ? ids.map((id) => schemeOf(ctx, id)) : ctx.profile.schemes;
}

/** Gmail pacing: a shared limiter, the in-flight limit, and retry options counting quota waits. */
export function pacing(ctx: StageContext) {
  const p = ctx.io.pacing ?? {};
  const limiter = new RateLimiter(p.readsPerSecond ?? 4, 2);
  const counter = { quotaRetries: 0 };
  const retry: RetryOptions = {
    quotaBaseMs: p.quotaRetryMs ?? 8000,
    onRetry: () => counter.quotaRetries++,
  };
  return { limiter, concurrency: p.concurrency ?? 4, retry, counter };
}

/** Every message a query lists, newest first as Gmail returns them, up to `max`. Paced. */
export async function listAll(
  gmail: OrganiserGmail,
  q: string,
  max: number,
  pace: ReturnType<typeof pacing>,
): Promise<{ id: string; threadId: string }[]> {
  const out: { id: string; threadId: string }[] = [];
  let pageToken: string | undefined;
  while (out.length < max) {
    // A list page costs the same quota as one message read.
    await pace.limiter.take();
    const page = await withRetry(
      () => gmail.listMessages(q, { maxResults: Math.min(500, max - out.length), pageToken }),
      pace.retry,
    );
    out.push(...(page.messages ?? []));
    pageToken = page.nextPageToken;
    if (!pageToken) break;
  }
  return out.slice(0, max);
}
