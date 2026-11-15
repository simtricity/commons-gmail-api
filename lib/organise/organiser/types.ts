/**
 * The types the organiser's stages take and return.
 *
 * @module
 */

import type { Message } from "../../types.ts";
import type { Judge } from "../judge.ts";
import type { GoldenCase } from "../golden.ts";
import type { Strength } from "../relationships.ts";
import type { Answers, SchemeDecision } from "../scheme.ts";
import type { Protection } from "../triage/decide.ts";

/**
 * The Gmail reads the organiser makes. A `GmailClient` holding a read grant is one;
 * declaring only these methods keeps the organiser testable against a fake.
 */
export interface OrganiserGmail {
  /** Message ids matching a Gmail search, one page at a time. */
  listMessages(
    q: string,
    opts?: { maxResults?: number; pageToken?: string },
  ): Promise<{ messages?: { id: string; threadId: string }[]; nextPageToken?: string }>;
  /** One message, in full or metadata only. */
  getMessage(id: string, format?: "full" | "metadata"): Promise<Message>;
  /** Every label in the mailbox. */
  listLabels(): Promise<{ id: string; name: string }[]>;
  /** The mailbox's own address. */
  profile(): Promise<{ emailAddress: string }>;
}

/**
 * The only Gmail writes the organiser makes: label creation and relabelling inside
 * one prefix. A `GuardedWriter` holding a write grant is one.
 */
export interface OrganiserWriter {
  /** Create a label inside `prefix`, with its parents, unless it exists. */
  createScopedLabel(
    prefix: string,
    name: string,
  ): Promise<{ label: { id: string; name: string }; created: boolean }>;
  /** Add and remove labels inside `prefix` on `ids`; a dry run unless `apply`. */
  scopedRelabel(
    req: { prefix: string; add?: string; remove: string[]; ids: string[]; apply?: boolean },
  ): Promise<{ calls?: number }>;
}

/** What the organiser may use. Everything is injected; nothing is read from the environment. */
export interface OrganiserIO {
  /** Read grant: a `GmailClient`, or anything with its four read methods. */
  gmail: OrganiserGmail;
  /** Needed by `judge`. */
  judge?: Judge;
  /** Write grant through the guard (a `GuardedWriter`); needed by `apply` with `apply: true`. */
  writer?: OrganiserWriter;
  /** Clock for timestamps, and for `decide` when a call gives no `now`. Default `Date.now`. */
  now?: () => number;
  /** Progress lines. Default: silent. */
  log?: (line: string) => void;
  /** Gmail pacing. Defaults: 4 reads a second, 4 in flight, quota retries from 8000 ms. */
  pacing?: { readsPerSecond?: number; concurrency?: number; quotaRetryMs?: number };
}

/** `runs/<run>/manifest.json`: what each stage did to a run. */
export interface Manifest {
  /** The run id. */
  id: string;
  /** Set for a year sample. */
  year?: number;
  /** When the sample was drawn. */
  createdAt: string;
  /** How the sample was drawn. */
  sample?: {
    query: string;
    seed: number;
    size: number;
    singleMessage: boolean;
    listed: number;
    candidates: number;
  };
  /** The last fetch. */
  fetch?: { at: string; fetched: number; rejected: number; failures: number; quotaRetries: number };
  /** Every judge pass. */
  judge?: {
    /** Every pass that asked something, oldest first. */
    passes: {
      at: string;
      model: string;
      questions: string[];
      messages: number;
      inputTokens: number;
      failures: number;
    }[];
    /** Sum over passes. */
    inputTokens: number;
    /** Only when the profile sets `pricePerMTok`. */
    costUsd?: number;
  };
  /** The last decide, per scheme. */
  decide?: Record<string, { at: string; now: string; counts: Record<string, number> }>;
  /** The last apply, per scheme. */
  apply?: Record<string, { at: string; calls: number }>;
}

/** `runs/<run>/decisions.<scheme>.json`. */
export interface DecisionsFile {
  /** The scheme decided. */
  scheme: string;
  /** When. */
  decidedAt: string;
  /** The clock decide used, ISO. */
  now: string;
  /** One decision per fetched message. */
  decisions: SchemeDecision[];
}

/** How {@link Organiser.sample} draws. */
export interface SampleOptions {
  /** Run id: a path segment of letters, digits, `.`, `_` and `-`. */
  run: string;
  /** One calendar year of received mail. Exactly one of `year` and `query`. */
  year?: number;
  /** A Gmail query, ANDed with `-in:sent -in:chats -in:draft`. */
  query?: string;
  /** Default 500. */
  size?: number;
  /** Default `year * 10000 + size`, or `size` for a query sample. */
  seed?: number;
  /** Only threads holding exactly one message. */
  singleMessage?: boolean;
  /** Redraw an existing sample. */
  force?: boolean;
}

/** What one capture did. */
export interface CaptureSummary {
  /** Which mail. */
  source: "sent" | "received";
  /** The Gmail query listed. */
  query: string;
  /** New messages captured. */
  captured: number;
  /** Messages that could not be read; re-run to retry. */
  failures: number;
  /** Messages held for this source after the run. */
  total: number;
  /** Shard years written this run. */
  shards: string[];
}

/** What one corpus build did. */
export interface CorpusSummary {
  /** Sent messages read. */
  scanned: number;
  /** People and lists written to. */
  correspondents: number;
  /** Correspondents with a strong relationship. */
  strong: number;
  /** Absolute path written. */
  path: string;
}

/** What one fetch did. */
export interface FetchSummary {
  /** Messages the run holds after this pass (a resumed fetch reports the total, not the increment). */
  fetched: number;
  /** Sampled as single-message threads, found to have grown, never read. */
  rejected: number;
  /** Messages that could not be read; re-run to retry. */
  failures: number;
  /** Quota refusals waited out. */
  quotaRetries: number;
}

/** What one judge pass did. */
export interface JudgeSummary {
  /** Messages asked something this pass. */
  messages: number;
  /** Question ids asked this pass, sorted. */
  questions: string[];
  /** The model, as the endpoint reported it. */
  model: string;
  /** Input tokens this pass. */
  inputTokens: number;
  /** All passes on this run. */
  totalInputTokens: number;
  /** Messages whose call failed; re-run to retry. */
  failures: number;
}

/** What one decide did for one scheme. */
export interface DecideSummary {
  /** The scheme decided. */
  scheme: string;
  /** Category → messages. */
  counts: Record<string, number>;
  /** route → category → count. */
  routes: Record<string, Record<string, number>>;
  /** `"<was> → <now>"` → ids, against the previous decide of this scheme. */
  moves: Record<string, string[]>;
  /** Senders whose messages got more than one category, most messages first. */
  splits: { sender: string; total: number; categories: Record<string, number> }[];
}

/** What one apply did, or would do. */
export interface ApplySummary {
  /** The scheme applied. */
  scheme: string;
  /** True unless `apply: true` was given. */
  dryRun: boolean;
  /** Labels that would be or were created. */
  toCreate: string[];
  /** Messages already carrying exactly their label. */
  unchanged: number;
  /** `"<held> → <category>"` → count; held is a category, `+`-joined categories, or `unlabelled`. */
  moves: Record<string, number>;
  /** batchModify calls made. 0 on a dry run. */
  calls: number;
}

/** Labels in Gmail compared with a scheme's decisions. */
export interface ReconcileResult {
  /** The scheme compared. */
  scheme: string;
  /** Every run message carries exactly its decided label. */
  ok: boolean;
  /** Category → run messages carrying its label (unlabelled categories: carrying none of the scheme's labels). */
  counts: Record<string, number>;
  /** Label → members outside this run. */
  outsideRun: Record<string, number>;
  /** Messages whose labels disagree with their decision. */
  wrong: { id: string; decided: string; labelled: string }[];
}

/** Why one message got its category. */
export interface Explanation {
  /** Gmail message id. */
  id: string;
  /** The scheme explained. */
  scheme: string;
  /** The `From` header. */
  from: string;
  /** The `Subject` header. */
  subject: string;
  /** The deterministic facts the triage routes read. */
  facts: {
    sender: string;
    domain: string;
    ageYears: number;
    protection: Protection;
    strength: Strength;
    campaign: boolean;
    discussionList: boolean;
  };
  /** The stored answers. */
  answers: Answers;
  /** The hash each answer was asked under. */
  asked: Record<string, string>;
  /** The decision. */
  decision: SchemeDecision;
}

/** A ruling to record. */
export interface RuleOptions {
  /** The scheme ruled on. */
  scheme: string;
  /** Message id. */
  id: string;
  /** The category, or several acceptable ones. */
  is: string | string[];
  /** Categories that would be a critical failure. */
  never?: string[];
  /** Why. */
  note?: string;
  /** Also rule the message's sender into `is` (which must then be one category). */
  sender?: boolean;
  /** Re-decide this run's scheme afterwards and report the message's new decision. */
  run?: string;
}

/** What a ruling recorded. */
export interface RuleResult {
  /** The golden case written. */
  case: GoldenCase;
  /** The sender ruling written, when asked for. */
  sender?: { address: string; category: string };
  /** The message's new decision, when a run was given. */
  decision?: SchemeDecision;
}
