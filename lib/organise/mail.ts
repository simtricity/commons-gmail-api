/**
 * Turning a Gmail message into the state a decision model sees.
 *
 * Pure functions over already-fetched messages. Nothing here opens a socket or
 * reads the environment.
 *
 * @module
 */

import { decodeBase64Url, header } from "../mime.ts";
import type { Message, MessagePart } from "../types.ts";
import type { MailState } from "./types.ts";

/** "Alice Smith <a@b.com>" → "a@b.com". A bare address passes through. */
export function addressOf(value: string): string {
  const m = value.match(/<([^>]+)>/);
  return (m ? m[1] : value).trim().toLowerCase();
}

/** The domain part of the first address in a header value. */
export function domainOf(value: string): string {
  const a = addressOf(value);
  return a.includes("@") ? a.split("@").pop()! : a;
}

/** Every address appearing in a header value. */
export function addressesIn(value: string): string[] {
  return [...value.matchAll(/[\w.+-]+@[\w.-]+\.\w+/g)].map((m) => m[0].toLowerCase());
}

/** Depth-first search for the first part of a given MIME type carrying data. */
function findPart(part: MessagePart | undefined, want: string): string | null {
  if (!part) return null;
  if (part.mimeType === want && part.body?.data) {
    try {
      return new TextDecoder().decode(decodeBase64Url(part.body.data));
    } catch {
      return null;
    }
  }
  for (const child of part.parts ?? []) {
    const found = findPart(child, want);
    if (found) return found;
  }
  return null;
}

function stripHtml(html: string): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"');
}

/**
 * Best available body text, quoted-reply lines removed and truncated.
 *
 * `maxChars` caps the head. Measured on a real mailbox, 60% of messages exceed
 * 2,000 characters but classification answers did not move when the cap was
 * raised sixfold, because most questions are answered by the first screen. Raise
 * it only for questions about detail buried in the body, such as amounts, dates
 * or named equipment.
 */
export function bodyText(msg: Message, maxChars: number): string {
  const plain = findPart(msg.payload, "text/plain");
  // fallback: HTML-only senders are common, so strip tags rather than send nothing.
  const html = plain ? null : findPart(msg.payload, "text/html");
  // fallback: neither part decodable, so use Gmail's own snippet.
  const text = (plain ?? (html ? stripHtml(html) : null) ?? msg.snippet ?? "").replace(/\r\n/g, "\n");

  const trimmed = text
    .split("\n")
    .filter((l) => !/^\s*>/.test(l))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return trimmed.length > maxChars ? `${trimmed.slice(0, maxChars)}\n…[truncated]` : trimmed;
}

/** The message as the model sees it. */
export function toState(msg: Message, maxChars = 2000): MailState {
  const p = msg.payload;
  return {
    from: header(p, "From") ?? "",
    to: header(p, "To") ?? "",
    subject: header(p, "Subject") ?? "(no subject)",
    date: header(p, "Date") ?? "",
    is_reply: Boolean(header(p, "In-Reply-To")),
    has_list_unsubscribe: Boolean(header(p, "List-Unsubscribe")),
    body: bodyText(msg, maxChars),
  };
}

// ── list and auto-reply detection ────────────────────────────────────────────

const AUTO_SUBJECT =
  /^\s*(re:\s*)?(out of (the )?office|automatic reply|auto(matic)?[-_ ]?reply|autoreply|away from|vacation|annual leave|on leave|undeliverable|delivery status notification)\b/i;

/**
 * Did this message leave the mailbox on its own?
 *
 * Matters when building a corpus of people you have genuinely corresponded
 * with. On a real mailbox 23% of sent messages were vacation auto-replies, and
 * they had added 92 domains that genuine correspondence never touched, including
 * bounce addresses of newsletters and social networks. Counting them as contacts
 * makes an address whitelist rescue exactly the mail it should discard.
 */
export function isAutoReply(msg: Message): boolean {
  const p = msg.payload;
  return AUTO_SUBJECT.test(header(p, "Subject") ?? "") ||
    /auto-(replied|generated)/i.test(header(p, "Auto-Submitted") ?? "") ||
    Boolean(header(p, "X-Autoreply")) ||
    /auto_?reply|bulk/i.test(header(p, "Precedence") ?? "");
}

/**
 * Was this addressed to a mailing list rather than a person?
 *
 * `List-Post` is the useful one: a broadcast newsletter carries
 * `List-Unsubscribe` alone, while a list you can reply into carries `List-Id`
 * and `List-Post`. That difference separates practitioner discussion from
 * publications for free, without asking a model anything.
 */
export function isListMail(msg: Message): boolean {
  const p = msg.payload;
  return Boolean(header(p, "List-Id")) || Boolean(header(p, "List-Post"));
}

/**
 * The mailbox a message was sent from.
 *
 * Only the angle-bracket address counts. A display name is free text under RFC
 * 5322 and routinely contains something that looks like an address —
 * `"'no-reply@vendor.example' via redirect" <real@sender.example>` is a Google
 * Group forward, and `"jo jo@old.example" <jo@new.example>` is an address book
 * that stringified a contact. Reading every address in the header promotes that
 * noise to a real sender, which is how a correspondent ends up misfiled as one
 * of the operator's own addresses and silently dropped from a corpus.
 *
 * Falls back to a bare address when there are no angle brackets at all.
 */
export function senderOf(value: string | undefined): string {
  if (!value) return "";
  const angled = value.match(/<\s*([^<>\s]+@[^<>\s]+)\s*>/);
  if (angled) return angled[1].trim().toLowerCase();
  const bare = value.match(/[\w.!#$%&'*+/=?^`{|}~-]+@[\w-]+(?:\.[\w-]+)+/);
  return bare ? bare[0].toLowerCase() : "";
}
