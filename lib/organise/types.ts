/**
 * Wire and domain types.
 *
 * Nothing here knows what your mail is about. Question sets, label names and
 * thresholds all arrive as configuration, so the same binary serves a solicitor
 * sorting client correspondence and a sysadmin triaging alerts.
 *
 * @module
 */

// ── decision model wire shapes ───────────────────────────────────────────────

/** One typed question put to a System One decision model. */
export type Question =
  | { type: "choice"; instructions: unknown; criteria: Record<string, unknown> }
  | { type: "score"; instructions: unknown; criteria: unknown[] }
  | { type: "noul"; instructions: unknown };

/** One typed answer. `noul` carries no confidence; the probability is the answer. */
export interface Answer {
  type: "choice" | "score" | "noul";
  /** Choice: the selected option id. */
  choice?: string;
  /** Score: position along the levels, may fall between two. */
  score?: number;
  /** Noul: probability of yes, 0–1. */
  noul?: number;
  /** Choice/Score only: how peaked the distribution is. Not a correctness measure. */
  confidence?: number;
  probabilities?: Record<string, number>;
  legend?: Record<string, string>;
}

export interface Usage {
  input_tokens: number;
  output_tokens: number;
}

export interface SystemOneResponse {
  model: string;
  answers: Record<string, Answer>;
  usage: Usage;
}

// ── configuration ────────────────────────────────────────────────────────────

// ── mail ─────────────────────────────────────────────────────────────────────

/** What a person would glance at to judge a message. */
export interface MailState {
  from: string;
  to: string;
  subject: string;
  date: string;
  is_reply: boolean;
  has_list_unsubscribe: boolean;
  body: string;
}

/**
 * One captured message: the metadata, never the body.
 *
 * Capturing a mailbox costs about an hour of API quota; deriving anything from
 * the capture costs seconds. So the capture is the asset and every derived
 * artefact is disposable. This shape deliberately carries more headers than any
 * current derivation needs, because adding a field later means re-reading the
 * whole mailbox while ignoring one costs nothing.
 */
export interface CapturedMessage {
  id: string;
  threadId: string;
  /** ms since epoch, as Gmail reports it. */
  internalDate: string;
  labelIds?: string[];
  sizeEstimate?: number;
  /** Raw header values, exactly as sent. Absent headers are omitted. */
  headers: Record<string, string>;
}

/** Progress marker so a later run only fetches what is new. */
export interface CaptureState {
  /** Newest internalDate captured, per source. */
  sources: Record<string, { lastInternalDate: string; lastRun: string; captured: number }>;
}

/**
 * A mailing list you can post to, discovered from received mail.
 *
 * `listId` is the RFC 2919 `List-Id`. `address` is where posts go, which can
 * only be learned by asking Gmail which sent messages belong to the list,
 * because an outgoing copy carries no `List-*` headers at all.
 */
export interface ListEntry {
  listId: string;
  address?: string;
  received: number;
  /** Whether any sent message belongs to this list. */
  youPost: boolean;
}

/** One correspondent in the sent-mail corpus. */
export interface Correspondent {
  address: string;
  domain: string;
  /** A list address is not a person, and should not be read as a relationship. */
  kind: "person" | "list";
  /** Messages you sent them that were genuine, not auto-replies or list posts. */
  genuine: number;
  /** Messages reaching them only via an auto-reply or a mailing list post. */
  incidental: number;
  firstSeen: string;
  lastSeen: string;
}

export interface Corpus {
  builtAt: string;
  query: string;
  scanned: number;
  autoReplies: number;
  listPosts: number;
  /** Addresses that are the operator's own, excluded from correspondents. */
  selfAddresses?: string[];
  correspondents: Correspondent[];
}
