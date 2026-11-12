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

/** Characters of an original's text kept in a quote. */
export const QUOTE_MAX_CHARS = 100_000;

/** The original message a quote is built from: its headers as written, and its body as text. */
export interface QuotedOriginal {
  /** The `Date` header as written, with its own offset. */
  date?: string;
  /** The `From` header as written. */
  from: string;
  /** The body as plain text (from `bodyText`). */
  text: string;
}

/** `On <date>, <from> wrote:`, or `<from> wrote:` without a date. */
export function attribution(o: Pick<QuotedOriginal, "date" | "from">): string {
  return o.date ? `On ${o.date}, ${o.from} wrote:` : `${o.from} wrote:`;
}

/** The original's text, capped at {@link QUOTE_MAX_CHARS} with a marker. */
function capped(text: string): string {
  return text.length > QUOTE_MAX_CHARS
    ? `${text.slice(0, QUOTE_MAX_CHARS)}\n[… quoted text shortened]`
    : text;
}

/**
 * The quoted history under a reply, as Gmail writes it: the attribution, then the original with
 * each line prefixed `> ` in text, and inside Gmail's `gmail_quote` wrapper in HTML, so Gmail
 * folds it. The HTML holds only the escaped text: none of the original's HTML, scripts or images.
 */
export function quoteBlock(original: QuotedOriginal): BodyTail {
  const body = capped(original.text);
  const attr = attribution(original);
  const quoted = body.split(/\r?\n/).map((l) => (l ? `> ${l}` : ">")).join("\n");
  return {
    text: `${attr}\n${quoted}`,
    html: `<div class="gmail_quote"><div class="gmail_attr">${escapeHtml(attr)}<br></div>` +
      `<blockquote class="gmail_quote" style="margin:0 0 0 .8ex;border-left:1px #ccc solid;padding-left:1ex">` +
      `${textToHtml(body)}</blockquote></div>`,
  };
}
