/**
 * Pure projections over Gmail message shapes: MIME walk, base64url, hashing, headers.
 * No I/O, no env, no credentials — safe to import anywhere and to unit-test offline.
 * @module
 */

import type { AttachmentRef, Message, MessagePart } from "./types.ts";

/** Case-insensitive header lookup on a part (or a message payload). */
export function header(
  part: MessagePart | undefined,
  name: string,
): string | undefined {
  const lower = name.toLowerCase();
  return part?.headers?.find((h) => h.name.toLowerCase() === lower)?.value;
}

/**
 * Walk the MIME tree for parts that carry an attachment id.
 *
 * A part is `inline` when its Content-Disposition is `inline` AND it has a Content-ID —
 * the shape of an image embedded in an HTML body. Signature logos and tracking pixels
 * live here; callers filter on the flag rather than this function guessing intent.
 */
export function listAttachments(msg: Message): AttachmentRef[] {
  const out: AttachmentRef[] = [];
  const walk = (part?: MessagePart) => {
    if (!part) return;
    if (part.body?.attachmentId && part.filename) {
      const disposition = header(part, "content-disposition")?.toLowerCase() ??
        "";
      const contentId = header(part, "content-id");
      out.push({
        messageId: msg.id,
        filename: part.filename,
        attachmentId: part.body.attachmentId,
        mimeType: part.mimeType ?? "application/octet-stream",
        size: part.body.size ?? 0,
        inline: disposition.startsWith("inline") && !!contentId,
      });
    }
    for (const child of part.parts ?? []) walk(child);
  };
  walk(msg.payload);
  return out;
}

/** base64url (Gmail's encoding) → bytes. Tolerates missing padding. */
export function decodeBase64Url(data: string): Uint8Array {
  const b64 = data.replace(/-/g, "+").replace(/_/g, "/");
  const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
  const bin = atob(padded);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

/** Lowercase hex SHA-256 of `bytes`, via WebCrypto. */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Metadata-only view of a message: no body, no snippet. */
export interface MessageSummary {
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
  /** `Subject` header as sent. */
  subject: string;
  /** Attachments found in the MIME tree, without attachment ids (those are ephemeral). */
  attachments: {
    filename: string;
    mimeType: string;
    size: number;
    inline: boolean;
  }[];
}

/**
 * Built field by field, never by spreading the API object — `messages.get` returns
 * `snippet` by default, and a spread would leak body text into anything that logs this.
 */
export function summarize(msg: Message): MessageSummary {
  return {
    id: msg.id,
    threadId: msg.threadId,
    date: header(msg.payload, "date") ?? "",
    from: header(msg.payload, "from") ?? "",
    to: header(msg.payload, "to") ?? "",
    subject: header(msg.payload, "subject") ?? "",
    attachments: listAttachments(msg).map((a) => ({
      filename: a.filename,
      mimeType: a.mimeType,
      size: a.size,
      inline: a.inline,
    })),
  };
}

/**
 * Accept a Gmail thread/message id as a bare hex string or as the last path segment of
 * a Gmail web URL in the legacy hex form (`…#inbox/18c9f0a1b2d3e4f5`). The newer
 * `FMfcgz…` URL tokens are not API ids and are rejected.
 */
export function parseGmailId(input: string): string {
  const trimmed = input.trim();
  const candidate = trimmed.includes("/")
    ? trimmed.split(/[/#?]/).filter(Boolean).at(-1) ?? ""
    : trimmed;
  if (!/^[0-9a-f]{12,20}$/i.test(candidate)) {
    throw new Error(
      `"${input}" is not a Gmail API id. Pass the 16-hex id from the API/search ` +
        `results (a Gmail web "FMfcgz…" URL token cannot be converted).`,
    );
  }
  return candidate.toLowerCase();
}

/** Fields of an RFC 5322 message built by {@link buildRawMessage}. */
export interface RawMessageInput {
  /** To recipients. */
  to: string[];
  /** Cc recipients. */
  cc?: string[];
  /** Bcc recipients. */
  bcc?: string[];
  /** Subject; non-ASCII is RFC 2047 encoded. */
  subject: string;
  /** Plain-text body, UTF-8. */
  text: string;
  /** Message-ID of the message being replied to. */
  inReplyTo?: string;
  /** References chain, oldest first. */
  references?: string[];
  /** Files to attach. With any, the message becomes `multipart/mixed`. */
  attachments?: RawAttachment[];
}

/** One file attached by {@link buildRawMessage}. */
export interface RawAttachment {
  /** Filename shown to the recipient; non-ASCII is RFC 2231 encoded. */
  filename: string;
  /** File bytes. */
  content: Uint8Array;
  /** MIME type. Default: guessed from the extension by {@link mimeTypeFor}. */
  mimeType?: string;
}

const MIME_BY_EXT: Record<string, string> = {
  pdf: "application/pdf",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  txt: "text/plain",
  md: "text/markdown",
  csv: "text/csv",
  html: "text/html",
  json: "application/json",
  xml: "application/xml",
  zip: "application/zip",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  xlsm: "application/vnd.ms-excel.sheet.macroEnabled.12",
  ppt: "application/vnd.ms-powerpoint",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  dwg: "image/vnd.dwg",
  dxf: "image/vnd.dxf",
};

/** MIME type for a filename by extension; `application/octet-stream` when unknown. */
export function mimeTypeFor(filename: string): string {
  const ext = filename.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1];
  return (ext && MIME_BY_EXT[ext]) ?? "application/octet-stream";
}

// Starts with "=_", which base64 lines never contain, so it cannot collide with a part body.
const BOUNDARY = "=_gmail-api_mixed_0";

function encodeHeaderWord(value: string): string {
  if (/^[\x20-\x7e]*$/.test(value)) return value;
  return `=?UTF-8?B?${encodeBase64(new TextEncoder().encode(value))}?=`;
}

function encodeBase64(bytes: Uint8Array): string {
  let bin = "";
  // Chunked: one fromCharCode per 32 KiB keeps multi-MB attachments fast and under arg limits.
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

/** Standard base64 → base64url as Gmail's `raw` fields expect. */
export function toBase64Url(b64: string): string {
  return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** `filename` parameter: plain quoted when ASCII-safe, else RFC 2231 `filename*=UTF-8''…`. */
function filenameParam(name: string): string {
  if (/^[\x20-\x7e]*$/.test(name) && !/["\\]/.test(name)) return `filename="${name}"`;
  const pct = Array.from(
    new TextEncoder().encode(name),
    (b) =>
      /[A-Za-z0-9!#$&+\-.^_`|~]/.test(String.fromCharCode(b))
        ? String.fromCharCode(b)
        : `%${b.toString(16).toUpperCase().padStart(2, "0")}`,
  ).join("");
  return `filename*=UTF-8''${pct}`;
}

/** Push `bytes` as base64 in 76-char lines. */
function pushBase64(lines: string[], bytes: Uint8Array): void {
  const b64 = encodeBase64(bytes);
  for (let i = 0; i < b64.length; i += 76) lines.push(b64.slice(i, i + 76));
}

/**
 * Build an RFC 5322 message and return it base64url-encoded, ready for
 * `users.drafts.create` `message.raw`. Deterministic: no Date or Message-ID header, Gmail adds
 * them. The body is base64 transfer-encoded so any UTF-8 text is safe. With `attachments` the
 * message is `multipart/mixed`: the text part first, then each file as a base64
 * `Content-Disposition: attachment` part.
 */
export function buildRawMessage(input: RawMessageInput): string {
  const lines: string[] = [];
  lines.push(`To: ${input.to.join(", ")}`);
  if (input.cc?.length) lines.push(`Cc: ${input.cc.join(", ")}`);
  if (input.bcc?.length) lines.push(`Bcc: ${input.bcc.join(", ")}`);
  lines.push(`Subject: ${encodeHeaderWord(input.subject)}`);
  if (input.inReplyTo) lines.push(`In-Reply-To: ${input.inReplyTo}`);
  if (input.references?.length) lines.push(`References: ${input.references.join(" ")}`);
  lines.push("MIME-Version: 1.0");
  const text = new TextEncoder().encode(input.text);
  if (!input.attachments?.length) {
    lines.push("Content-Type: text/plain; charset=UTF-8");
    lines.push("Content-Transfer-Encoding: base64");
    lines.push("");
    pushBase64(lines, text);
  } else {
    lines.push(`Content-Type: multipart/mixed; boundary="${BOUNDARY}"`);
    lines.push("");
    lines.push(`--${BOUNDARY}`);
    lines.push("Content-Type: text/plain; charset=UTF-8");
    lines.push("Content-Transfer-Encoding: base64");
    lines.push("");
    pushBase64(lines, text);
    for (const a of input.attachments) {
      const type = (a.mimeType ?? mimeTypeFor(a.filename)).replace(/[\r\n]/g, "");
      const param = filenameParam(a.filename.replace(/[\r\n]/g, " "));
      lines.push(`--${BOUNDARY}`);
      lines.push(`Content-Type: ${type}; ${param.replace(/^filename/, "name")}`);
      lines.push(`Content-Disposition: attachment; ${param}`);
      lines.push("Content-Transfer-Encoding: base64");
      lines.push("");
      pushBase64(lines, a.content);
    }
    lines.push(`--${BOUNDARY}--`);
  }
  return toBase64Url(encodeBase64(new TextEncoder().encode(lines.join("\r\n") + "\r\n")));
}
