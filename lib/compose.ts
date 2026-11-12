/**
 * Draft bodies: the new text and HTML, then a signature, then a quote or a forwarded-message
 * block. One pure function assembles them for every kind of draft, so replies, forwards and edits
 * cannot drift apart. No client, no network.
 *
 * @module
 */

import { stripHtml } from "./body.ts";

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

/** Decode the entities and drop the whitespace a URL scheme can be hidden behind. */
function schemeOf(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);?/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);?/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(
      /&(tab|newline|colon);/gi,
      (_, n) => ({ tab: "\t", newline: "\n", colon: ":" })[n.toLowerCase() as "tab"],
    )
    // deno-lint-ignore no-control-regex
    .replace(/[\u0000-\u0020]+/g, "")
    .toLowerCase();
}

/**
 * Make a signature's HTML safe to carry: remove `<script>` and `<style>` elements, every
 * event-handler attribute (`on…=`), and any attribute whose value is a `javascript:` or
 * `vbscript:` URL, including entity-encoded ones. Any `<` that does not open a well-formed tag
 * (an unclosed tag, a stray bracket) becomes `&lt;`, so nothing unchecked can merge with the
 * markup around it. Everything else, images included, is kept: it is the account holder's own
 * signature, from their Gmail settings.
 */
export function scrubSignatureHtml(html: string): string {
  const attr = /\s([a-z_:][-a-z0-9_:.]*)(\s*=\s*("[^"]*"|'[^']*'|[^\s"'>]+))?/gi;
  const token =
    /<!--[\s\S]*?-->|<\/[a-z][a-z0-9]*[^<>]*>|<([a-z][a-z0-9]*)\b((?:[^<>"']|"[^"]*"|'[^']*')*)>|</gi;
  // removing one element can splice another together from its neighbours: repeat until stable
  let out = html;
  for (let prev = ""; prev !== out;) {
    prev = out;
    out = out.replace(/<(script|style)\b[\s\S]*?<\/\1\s*>/gi, "");
  }
  return out
    .replace(/<(script|style)\b[\s\S]*$/i, "") // one left unclosed runs to the end
    .replace(token, (whole, tag?: string, attrs?: string) => {
      if (whole === "<") return "&lt;";
      if (!tag) return /^<\/(script|style)\b/i.test(whole) ? "" : whole;
      if (/^(script|style)$/i.test(tag)) return "";
      const kept = (attrs ?? "").replace(attr, (a, name: string, _eq, value?: string) => {
        if (/^on/i.test(name)) return "";
        const v = value?.replace(/^["']|["']$/g, "") ?? "";
        return /^(javascript|vbscript):/.test(schemeOf(v)) ? "" : a;
      });
      return `<${tag}${kept}>`;
    });
}

/** A send-as signature as a {@link SignatureBlock}: scrubbed HTML, and its text. Empty: null. */
export function signatureBlock(signatureHtml: string | undefined): SignatureBlock | null {
  const html = scrubSignatureHtml(signatureHtml ?? "").trim();
  return html ? { html, text: stripHtml(html) } : null;
}
