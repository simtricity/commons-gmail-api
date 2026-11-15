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
  /** Which kind of question this answers. */
  type: "choice" | "score" | "noul";
  /** Choice: the selected option id. */
  choice?: string;
  /** Score: position along the levels, may fall between two. */
  score?: number;
  /** Noul: probability of yes, 0–1. */
  noul?: number;
  /** Choice/Score only: how peaked the distribution is. Not a correctness measure. */
  confidence?: number;
  /** Choice/Score only: the probability of each option or level. */
  probabilities?: Record<string, number>;
  /** Choice/Score only: a readable name for each key of `probabilities`, when sent. */
  legend?: Record<string, string>;
}

/** Token counts for one decision-model call. */
export interface Usage {
  /** Tokens in the request. */
  input_tokens: number;
  /** Tokens in the response. */
  output_tokens: number;
}

/** A decision-model response: one answer per question id. */
export interface SystemOneResponse {
  /** The model that answered. */
  model: string;
  /** Answers by question id. */
  answers: Record<string, Answer>;
  /** What the call cost. */
  usage: Usage;
}

// ── configuration ────────────────────────────────────────────────────────────

// ── mail ─────────────────────────────────────────────────────────────────────

/** What a person would glance at to judge a message. */
export interface MailState {
  /** The `From` header. */
  from: string;
  /** The `To` header. */
  to: string;
  /** The `Subject` header. */
  subject: string;
  /** The `Date` header. */
  date: string;
  /** Whether the message carries `In-Reply-To`. */
  is_reply: boolean;
  /** Whether the message carries `List-Unsubscribe`. */
  has_list_unsubscribe: boolean;
  /** Body text, quoted-reply lines removed and truncated. */
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
  /** Gmail message id. */
  id: string;
  /** Gmail thread id. */
  threadId: string;
  /** ms since epoch, as Gmail reports it. */
  internalDate: string;
  /** Gmail label ids at capture time. */
  labelIds?: string[];
  /** Gmail's size estimate, in bytes. */
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
  /** The RFC 2919 `List-Id`. */
  listId: string;
  /** Where posts go, once learned from sent mail. */
  address?: string;
  /** Messages received from the list. */
  received: number;
  /** Whether any sent message belongs to this list. */
  youPost: boolean;
}

/** One correspondent in the sent-mail corpus. */
export interface Correspondent {
  /** Lower-cased email address. */
  address: string;
  /** The domain of `address`. */
  domain: string;
  /** A list address is not a person, and should not be read as a relationship. */
  kind: "person" | "list";
  /** Messages you sent them that were genuine, not auto-replies or list posts. */
  genuine: number;
  /** Messages reaching them only via an auto-reply or a mailing list post. */
  incidental: number;
  /** ISO 8601 time of the first message sent to them. Empty when unknown. */
  firstSeen: string;
  /** ISO 8601 time of the last message sent to them. Empty when unknown. */
  lastSeen: string;
}

/** Who you have written to, built from sent mail by `CorpusBuilder`. */
export interface Corpus {
  /** When the corpus was built, ISO 8601. */
  builtAt: string;
  /** The Gmail search query that selected the sent mail. */
  query: string;
  /** Sent messages read. */
  scanned: number;
  /** Of those, auto-replies. */
  autoReplies: number;
  /** Of those, mailing-list posts. */
  listPosts: number;
  /** Addresses that are the account holder's own, excluded from correspondents. */
  selfAddresses?: string[];
  /** Everyone written to, most genuine correspondence first. */
  correspondents: Correspondent[];
}
