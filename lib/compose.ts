/**
 * Draft bodies: the new text and HTML, then a signature, then a quote or a forwarded-message
 * block. One pure function assembles them for every kind of draft, so replies, forwards and edits
 * cannot drift apart. No client, no network.
 *
 * @module
 */

/** Escape text for HTML: `& < > " '`. Everything from another message goes through this. */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Plain text as HTML: escaped, with line breaks as `<br>`. */
export function textToHtml(text: string): string {
  return escapeHtml(text).replace(/\r?\n/g, "<br>");
}

/** A block after the new body and signature: a quote or a forwarded message, as text and as HTML. */
export interface BodyTail {
  /** The plain-text rendering. */
  text: string;
  /** The HTML rendering. Built from escaped text only. */
  html: string;
}

/** A signature, as HTML (already scrubbed) and as plain text. */
export interface SignatureBlock {
  /** HTML, placed inside `<div class="gmail_signature">`. */
  html: string;
  /** Plain text, placed after a `-- ` line. */
  text: string;
}

/** What {@link composeBody} assembles. */
export interface ComposeInput {
  /** The new text; always sent, and the plain alternative to `html`. */
  text: string;
  /** The new body as HTML, sent as given. Absent: the escaped text. */
  html?: string;
  /** A signature, after the new body and before any tail. */
  signature?: SignatureBlock | null;
  /** A quote or forwarded-message block, last. */
  tail?: BodyTail | null;
}

/** The composed body: always text, and HTML when anything needs it. */
export interface ComposedBody {
  /** The plain-text body. */
  text: string;
  /** The HTML body, or absent when the draft is plain text only. */
  html?: string;
}

/**
 * Assemble a draft's body. With only `text`, the draft stays plain text. Otherwise the HTML is the
 * new body (`html`, or the escaped text), then `<div class="gmail_signature">`, then the tail; the
 * text follows the same order, with `-- ` before the signature.
 */
export function composeBody(input: ComposeInput): ComposedBody {
  const sig = input.signature ?? null;
  const tail = input.tail ?? null;
  if (input.html === undefined && !sig && !tail) return { text: input.text };

  let text = input.text;
  let html = `<div dir="ltr">${input.html ?? textToHtml(input.text)}</div>`;
  if (sig) {
    text += `\n\n-- \n${sig.text}`;
    html += `<br><div class="gmail_signature">${sig.html}</div>`;
  }
  if (tail) {
    text += `\n\n${tail.text}`;
    html += `<br>${tail.html}`;
  }
  return { text, html };
}
