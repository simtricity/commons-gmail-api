/**
 * Message bodies as text, for reading mail rather than archiving it. Attachments never appear
 * in the output: a `text/plain` part with a filename is an attached file, not the body.
 * @module
 */

import type { GmailClient } from "./client.ts";
import { allHeaders, type AuthSummary, authSummary, type HeaderLine } from "./headers.ts";
import { type MessageLinks, messageLinks } from "./links.ts";
import { decodeBase64Url, header, summarize } from "./mime.ts";
import type { Message, MessagePart } from "./types.ts";

/** Which part a body came from. */
export type BodySource = "text/plain" | "text/html" | "snippet" | "none";

/** Result of {@link bodyText}. */
export interface BodyText {
  /** The text, truncated to `maxChars` with a trailing note when cut. */
  text: string;
  /** Where the text came from. `text/html` means tags were stripped. */
  source: BodySource;
  /** Characters removed by `maxChars`; 0 when nothing was cut. */
  truncatedChars: number;
}

/** Options for {@link bodyText}. */
export interface BodyTextOptions {
  /** Cap on characters returned per message. Default: no cap. */
  maxChars?: number;
}

/** Options for {@link readMessage} and {@link readMessages}. */
export interface ReadOptions extends BodyTextOptions {
  /** Include every header, in message order, as `headers`. */
  headers?: boolean;
  /** Include the body's links, host counts and mismatch flags as `links`. */
  links?: boolean;
}

function decodeText(data?: string): string {
  if (!data) return "";
  return new TextDecoder().decode(decodeBase64Url(data));
}

/** Reduce HTML to readable text: drops style/script, turns block ends into newlines, decodes common entities. */
export function stripHtml(html: string): string {
  return html.replace(/<style[\s\S]*?<\/style>|<script[\s\S]*?<\/script>/gi, "")
    .replace(/<br\s*\/?>|<\/p>|<\/div>|<\/tr>|<\/li>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * A message's body as text: the first `text/plain` part that is not an attachment, else the
 * first such `text/html` part with tags stripped, else Gmail's snippet. Needs the message
 * fetched with `format: "full"`.
 */
export function bodyText(msg: Message, opts: BodyTextOptions = {}): BodyText {
  const parts: MessagePart[] = [];
  const walk = (p?: MessagePart) => {
    if (!p) return;
    parts.push(p);
    p.parts?.forEach(walk);
  };
  walk(msg.payload);
  const isBody = (p: MessagePart, type: string) =>
    p.mimeType === type && !!p.body?.data && !p.filename;
  let text = "";
  let source: BodySource = "none";
  const plain = parts.find((p) => isBody(p, "text/plain"));
  const html = parts.find((p) => isBody(p, "text/html"));
  if (plain) {
    text = decodeText(plain.body!.data).trim();
    source = "text/plain";
  } else if (html) {
    // fallback: HTML-only mail is stripped to text; formatting is lost but content is preserved
    text = stripHtml(decodeText(html.body!.data));
    source = "text/html";
  } else if (msg.snippet) {
    // fallback: no inline body part (e.g. body held only as an attachment); Gmail's preview
    text = msg.snippet;
    source = "snippet";
  }
  let truncatedChars = 0;
  if (opts.maxChars !== undefined && text.length > opts.maxChars) {
    truncatedChars = text.length - opts.maxChars;
    text = `${text.slice(0, opts.maxChars)}\n…[truncated ${truncatedChars} chars]`;
  }
  return { text, source, truncatedChars };
}

/** One message as read by {@link readMessages}: headers, labels, attachment names, body text. */
export interface ReadMessage {
  /** Gmail message id. */
  id: string;
  /** Gmail thread id. */
  threadId: string;
  /** `Date` header as sent. */
  date: string;
  /** `From` header as sent. */
  from: string;
  /** `To` header as sent. */
  to: string;
  /** `Cc` header as sent, if any. */
  cc?: string;
  /** `Subject` header as sent. */
  subject: string;
  /** Label ids on the message. */
  labelIds: string[];
  /** Non-inline attachments: names, types and sizes only. */
  attachments: { filename: string; mimeType: string; size: number }[];
  /** Body text; see {@link bodyText}. */
  text: string;
  /** Where the body came from. */
  source: BodySource;
  /** Characters cut by `maxChars`. */
  truncatedChars: number;
  /** DKIM, SPF and DMARC as the receiving server judged them, with phishing flags. */
  auth: AuthSummary;
  /** Every header, in order. Only with `headers: true`. */
  headers?: HeaderLine[];
  /** Links in the body. Only with `links: true`. */
  links?: MessageLinks;
}

/** Turn one full-format message into a {@link ReadMessage}. */
export function readMessage(msg: Message, opts: ReadOptions = {}): ReadMessage {
  const s = summarize(msg);
  const body = bodyText(msg, opts);
  const cc = header(msg.payload, "cc");
  return {
    id: msg.id,
    threadId: msg.threadId,
    date: s.date,
    from: s.from,
    to: s.to,
    ...(cc ? { cc } : {}),
    subject: s.subject,
    labelIds: msg.labelIds ?? [],
    attachments: s.attachments.filter((a) => !a.inline).map((a) => ({
      filename: a.filename,
      mimeType: a.mimeType,
      size: a.size,
    })),
    text: body.text,
    source: body.source,
    truncatedChars: body.truncatedChars,
    auth: authSummary(msg),
    ...(opts.headers ? { headers: allHeaders(msg) } : {}),
    ...(opts.links ? { links: messageLinks(msg) } : {}),
  };
}

/** Read every message in a thread (oldest first), or one message, as text. */
export async function readMessages(
  gmail: GmailClient,
  target: { threadId?: string; messageId?: string },
  opts: ReadOptions = {},
): Promise<ReadMessage[]> {
  if (!!target.threadId === !!target.messageId) {
    throw new Error("readMessages: pass exactly one of threadId or messageId");
  }
  const msgs = target.threadId
    ? (await gmail.getThread(target.threadId, "full")).messages ?? []
    : [await gmail.getMessage(target.messageId!, "full")];
  return msgs.map((m) => readMessage(m, opts));
}

/**
 * The message exactly as received (RFC 5322 bytes, `format: "raw"`), for saving as `.eml` and
 * inspecting in a mail client or forensic tool.
 */
export async function rawMessage(gmail: GmailClient, messageId: string): Promise<Uint8Array> {
  const m = await gmail.getMessage(messageId, "raw");
  if (!m.raw) throw new Error(`rawMessage: Gmail returned no raw body for ${messageId}`);
  return decodeBase64Url(m.raw);
}
