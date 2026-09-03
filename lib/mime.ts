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

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Metadata-only view of a message: no body, no snippet. */
export interface MessageSummary {
  id: string;
  threadId: string;
  date: string;
  from: string;
  to: string;
  subject: string;
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
