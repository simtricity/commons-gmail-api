/**
 * Carrying a message's files into a new draft: a forward, or an edit that must keep what the
 * draft already holds. Uses the existing part walk and attachment download; no MIME parsing.
 *
 * @module
 */

import type { GmailClient } from "./client.ts";
import { AttachmentLimitError } from "./errors.ts";
import { decodeBase64Url, header, listAttachments, sha256Hex } from "./mime.ts";
import type { AttachmentRef, DraftAttachment, Message, MessagePart } from "./types.ts";

/** Gmail's limit on a message's total attachment size, in bytes. */
export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

/** One regular file on a message, before download. */
export interface CarryRef {
  /** Filename as sent. */
  filename: string;
  /** MIME type from the part, else `application/octet-stream`. */
  mimeType: string;
  /** Declared size in bytes (`body.size`). */
  size: number;
}

/** Options for {@link carryAttachments}. */
export interface CarryOptions {
  /** Keep only the files this returns true for. Default: every regular file. */
  select?: (ref: CarryRef) => boolean;
  /** Bytes the caller will add to the same draft; counted in the size check. */
  addedBytes?: number;
  /** The size limit. Default {@link MAX_ATTACHMENT_BYTES}. */
  limit?: number;
}

/** The files carried: those behind attachment ids in the message's order, then small embedded ones. */
export interface CarryResult {
  /** Regular files, bytes exact, with the filename and MIME type as sent. */
  files: Required<DraftAttachment>[];
  /** sha256 (hex) of each file, same order. */
  sha256: string[];
  /** Inline parts (Content-ID with inline disposition): counted, never carried. */
  skippedInline: number;
  /** Total bytes of the files carried. */
  totalBytes: number;
}

/**
 * Small files Gmail returns with their bytes in the part (`body.data`) rather than behind an
 * attachment id; `listAttachments` lists only the latter, and an edit must lose neither.
 */
function embeddedFiles(msg: Message): (CarryRef & { inline: boolean; data: string })[] {
  const out: (CarryRef & { inline: boolean; data: string })[] = [];
  const walk = (part?: MessagePart) => {
    if (!part) return;
    if (part.filename && !part.body?.attachmentId && part.body?.data !== undefined) {
      const disposition = header(part, "content-disposition")?.toLowerCase() ?? "";
      out.push({
        filename: part.filename,
        mimeType: part.mimeType || "application/octet-stream",
        size: part.body.size ?? 0,
        inline: disposition.startsWith("inline") && !!header(part, "content-id"),
        data: part.body.data,
      });
    }
    for (const child of part.parts ?? []) walk(child);
  };
  walk(msg.payload);
  return out;
}

/** Every file part on a message, regular and inline, without downloading anything. */
export function fileRefs(msg: Message): (CarryRef & { inline: boolean })[] {
  return [
    ...listAttachments(msg).map(({ filename, mimeType, size, inline }) => ({
      filename,
      mimeType,
      size,
      inline,
    })),
    ...embeddedFiles(msg).map(({ filename, mimeType, size, inline }) => ({
      filename,
      mimeType,
      size,
      inline,
    })),
  ];
}

/**
 * A message's regular files as bytes, ready to attach to a new draft. Give the message id, or the
 * message already read in `full` format. The declared sizes are summed and checked against the
 * limit **before anything is downloaded**: over it throws {@link AttachmentLimitError} and
 * fetches nothing. Inline parts are counted in `skippedInline`, never carried; the caller decides
 * whether that is acceptable.
 */
export async function carryAttachments(
  client: GmailClient,
  message: string | Message,
  opts: CarryOptions = {},
): Promise<CarryResult> {
  const msg = typeof message === "string" ? await client.getMessage(message, "full") : message;
  const select = opts.select ?? (() => true);
  const limit = opts.limit ?? MAX_ATTACHMENT_BYTES;
  const listed = listAttachments(msg);
  const embedded = embeddedFiles(msg);
  const skippedInline = listed.filter((r) => r.inline).length +
    embedded.filter((r) => r.inline).length;
  const remote: AttachmentRef[] = listed.filter((r) => !r.inline && select(r));
  const local = embedded.filter((r) => !r.inline && select(r));

  const declared = [...remote, ...local].reduce((n, r) => n + r.size, 0) + (opts.addedBytes ?? 0);
  if (declared > limit) throw new AttachmentLimitError(declared, limit);
  const files: Required<DraftAttachment>[] = [];
  for (const r of remote) {
    files.push({
      filename: r.filename,
      mimeType: r.mimeType || "application/octet-stream",
      content: await client.getAttachment(r.messageId, r.attachmentId),
    });
  }
  for (const r of local) {
    files.push({ filename: r.filename, mimeType: r.mimeType, content: decodeBase64Url(r.data) });
  }
  const totalBytes = files.reduce((n, f) => n + f.content.length, 0);
  if (totalBytes + (opts.addedBytes ?? 0) > limit) {
    throw new AttachmentLimitError(totalBytes + (opts.addedBytes ?? 0), limit);
  }
  return {
    files,
    sha256: await Promise.all(files.map((f) => sha256Hex(f.content))),
    skippedInline,
    totalBytes,
  };
}
