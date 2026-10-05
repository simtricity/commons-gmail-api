/**
 * What a message's headers say about how it was sent, as opposed to what it says.
 *
 * These are deterministic facts: a VERP return path, a `List-Post` header or an
 * RFC 3834 `Auto-Submitted` value is either there or it is not. They cost no
 * model call, and several of them settle a verdict outright.
 *
 * Pure. Headers in, facts out.
 *
 * @module
 */

import { senderOf } from "./mail.ts";

/** The headers that describe delivery rather than content. Absent headers are "". */
export interface Envelope {
  from: string;
  returnPath: string;
  sender: string;
  /** Google Groups keeps the true author here when it rewrites From. */
  originalSender: string;
  listUnsubscribe: string;
  listId: string;
  listPost: string;
  precedence: string;
  autoSubmitted: string;
}

const ENVELOPE_HEADERS: Record<keyof Envelope, string> = {
  from: "From",
  returnPath: "Return-Path",
  sender: "Sender",
  originalSender: "X-Original-Sender",
  listUnsubscribe: "List-Unsubscribe",
  listId: "List-Id",
  listPost: "List-Post",
  precedence: "Precedence",
  autoSubmitted: "Auto-Submitted",
};

/** Build an envelope from any header lookup, e.g. `(n) => header(msg.payload, n)`. */
export function envelopeOf(get: (name: string) => string | undefined): Envelope {
  const out = {} as Envelope;
  for (const [key, name] of Object.entries(ENVELOPE_HEADERS)) {
    out[key as keyof Envelope] = get(name) ?? "";
  }
  return out;
}

/** A case-insensitive lookup over a plain header record, as held in a capture. */
export function headerLookup(
  headers: Record<string, string>,
): (name: string) => string | undefined {
  const lower = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return (name) => lower.get(name.toLowerCase());
}

const domainPart = (address: string) => (address.includes("@") ? address.split("@").pop()! : "");

/**
 * Who actually wrote it.
 *
 * A Google Group rewrites `From` to the group and keeps the author in
 * `X-Original-Sender`, so reading `From` alone attributes every group post to
 * the group. Only angle-bracket addresses are read; see {@link senderOf}.
 */
export function senderIdentity(env: Pick<Envelope, "from" | "originalSender">): string {
  return senderOf(env.originalSender) || senderOf(env.from);
}

/**
 * Sent through a bulk mailing platform.
 *
 * A campaign's envelope encodes the recipient so bounces can be attributed:
 * `782-482386-you=example.com@platform.example`. That `=` in the local part is
 * the VERP signature, and it never appears on a message a person typed. The
 * From address stays the partner's own, which is exactly how a real colleague's
 * marketing blast slips past a whitelist.
 */
export function sentViaPlatform(env: Pick<Envelope, "from" | "returnPath">): boolean {
  const envelopeAddress = senderOf(env.returnPath) || env.returnPath.replace(/[<>]/g, "").trim();
  const local = envelopeAddress.split("@")[0] ?? "";
  const envelopeDomain = domainPart(envelopeAddress.toLowerCase());
  return Boolean(envelopeDomain) && envelopeDomain !== domainPart(senderOf(env.from)) &&
    local.includes("=");
}

/** A campaign, whoever signed it: an unsubscribe link or a mailing platform's envelope. */
export function isCampaign(env: Envelope | undefined): boolean {
  return Boolean(env?.listUnsubscribe) || (env ? sentViaPlatform(env) : false);
}

/**
 * A discussion list you could post into, rather than a newsletter.
 *
 * `List-Post` is the standard mark (RFC 2369), and a newsletter never carries it.
 * LISTSERV and Majordomo predate it and carry neither `List-Post` nor `List-Id`;
 * what marks them is bouncing to the list owner, `owner-<list>@host`.
 */
export function isDiscussionList(env: Pick<Envelope, "listPost" | "returnPath">): boolean {
  return Boolean(env.listPost) || /^<?owner-[^@\s]+@/i.test(env.returnPath.trim());
}

const REPLY_SUBJECT =
  /^\s*(re:\s*)?(out of (the )?office|automatic reply|auto[-\s]?reply|autoreply|undeliverable|delivery status notification|mail delivery)/i;

/**
 * An out-of-office or a bounce.
 *
 * Only `Auto-Submitted: auto-replied` counts. `auto-generated` is the correct
 * RFC 3834 value for any machine-sent mail, monitoring alerts included, and
 * reading it as an auto-reply swept real alerts into this route.
 */
export function isAutoReplied(subject: string, env: Envelope | undefined): boolean {
  return REPLY_SUBJECT.test(subject) || /auto-replied/i.test(env?.autoSubmitted ?? "");
}

const CALENDAR_SENDER = /^calendar-notification@google\.com$/i;
/** RFC 5546 iCalendar method subjects: unambiguous whoever sends them. */
const CALENDAR_RESPONSE =
  /^\s*(accepted|declined|tentative|cancelled|canceled|updated invitation|invitation):\s*\S/i;
/** Ambiguous on their own ("Notification:"), so they need the calendar's sender too. */
const CALENDAR_SUBJECT =
  /^\s*(notification|reminder|invitation|updated invitation|cancell?ed event|accepted|declined|changed):/i;

/** A calendar invitation, reply or reminder: the event itself lives in the calendar. */
export function isCalendarNotice(sender: string, subject: string): boolean {
  return CALENDAR_RESPONSE.test(subject) ||
    (CALENDAR_SENDER.test(sender) && CALENDAR_SUBJECT.test(subject));
}
