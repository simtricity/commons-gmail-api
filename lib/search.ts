/**
 * Search grouped by thread, the shape agents and people think in. Metadata only: no bodies.
 * @module
 */

import type { GmailClient } from "./client.ts";
import { summarize } from "./mime.ts";

/** One thread in a {@link searchThreads} result. */
export interface ThreadHit {
  /** Gmail thread id. */
  threadId: string;
  /** Matching messages from this thread in the result page. */
  messages: number;
  /** `Date` header of the newest matching message. */
  latest: string;
  /** Distinct `From` headers, newest first. */
  from: string[];
  /** Subject of the newest matching message. */
  subject: string;
  /** Distinct non-inline attachment filenames across the matching messages. */
  attachments: string[];
  /** Matching message ids, newest first. */
  messageIds: string[];
}

/** Result of {@link searchThreads}. */
export interface ThreadSearchResult {
  /** The query as sent to Gmail. */
  query: string;
  /** Messages matched in this page. */
  returned: number;
  /** True when Gmail has more results beyond this page. */
  hasMore: boolean;
  /** Token for the next page, if any. */
  nextPageToken?: string;
  /** Threads in order of their newest matching message. */
  threads: ThreadHit[];
}

/** Options for {@link searchThreads}. */
export interface SearchThreadsOptions {
  /** Messages per page (Gmail counts messages, not threads). Default 20. */
  maxResults?: number;
  /** Continue from a previous result's `nextPageToken`. */
  pageToken?: string;
}

/**
 * Run a Gmail query and group the matching messages by thread. Costs one list call plus one
 * metadata fetch per message. The caller is responsible for bounding `q`; see
 * {@link requireDateBound} for an opt-in check.
 */
export async function searchThreads(
  gmail: GmailClient,
  q: string,
  opts: SearchThreadsOptions = {},
): Promise<ThreadSearchResult> {
  const page = await gmail.listMessages(q, {
    maxResults: opts.maxResults ?? 20,
    pageToken: opts.pageToken,
  });
  const byThread = new Map<string, ReturnType<typeof summarize>[]>();
  for (const m of page.messages ?? []) {
    const s = summarize(await gmail.getMessage(m.id, "metadata"));
    const arr = byThread.get(m.threadId) ?? [];
    arr.push(s);
    byThread.set(m.threadId, arr);
  }
  const threads: ThreadHit[] = [...byThread.entries()].map(([threadId, msgs]) => ({
    threadId,
    messages: msgs.length,
    latest: msgs[0].date,
    from: [...new Set(msgs.map((x) => x.from))],
    subject: msgs[0].subject,
    attachments: [
      ...new Set(
        msgs.flatMap((x) => x.attachments.filter((a) => !a.inline).map((a) => a.filename)),
      ),
    ],
    messageIds: msgs.map((x) => x.id),
  }));
  const result: ThreadSearchResult = {
    query: q,
    returned: page.messages?.length ?? 0,
    hasMore: !!page.nextPageToken,
    threads,
  };
  if (page.nextPageToken) result.nextPageToken = page.nextPageToken;
  return result;
}

const DATE_BOUND = /\b(newer_than|older_than|after|before):/i;

/** A query had no date operator and the caller asked for one. */
export class UnboundedQueryError extends Error {
  /** Error class name, stable across minification. */
  override name = "UnboundedQueryError";
  /**
   * Build with the offending query.
   * @param query The query that lacked a date bound.
   */
  constructor(readonly query: string) {
    super(
      `query has no date bound (newer_than:, older_than:, after: or before:): ${query}`,
    );
  }
}

/** True when `q` contains a Gmail date operator. */
export function hasDateBound(q: string): boolean {
  return DATE_BOUND.test(q);
}

/**
 * Opt-in guard: throw {@link UnboundedQueryError} unless `q` has a date operator. Never
 * applied by the library itself; callers that want the rule call this.
 */
export function requireDateBound(q: string): string {
  if (!hasDateBound(q)) throw new UnboundedQueryError(q);
  return q;
}
