/**
 * Links in a message body, for checking where a message really sends you: every `href` in the
 * HTML part (taken before tags are stripped), bare URLs in the plain-text part, a host → count
 * summary, and a flag where the visible link text names a different host from the target. Pure.
 * @module
 */

import { orgDomain } from "./headers.ts";
import { decodeBase64Url } from "./mime.ts";
import type { Message, MessagePart } from "./types.ts";

/** One link found in a message body. */
export interface LinkRef {
  /** The target as written, entities decoded. */
  href: string;
  /** Scheme without the colon: `https`, `http`, `mailto`, `tel`, … */
  scheme: string;
  /** Target host, lower case (for `mailto:` the address's domain); empty when there is none. */
  host: string;
  /** Visible link text, tags stripped and whitespace collapsed. Empty for plain-text URLs. */
  text: string;
  /** Host named in the visible text, when the text looks like a URL or domain. */
  textHost?: string;
  /** True when `textHost` is a different organisation from `host`: the classic phishing tell. */
  mismatch: boolean;
  /** Which body part the link came from. */
  source: "text/html" | "text/plain";
}

/** Result of {@link messageLinks}. */
export interface MessageLinks {
  /** Every link, in body order. Duplicates are kept. */
  links: LinkRef[];
  /** Number of links per target host, most frequent first. */
  hosts: { host: string; count: number }[];
  /** Number of links with `mismatch`. */
  mismatches: number;
}

function decodeEntities(s: string): string {
  return s.replace(/&#x([0-9a-f]+);/gi, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function target(href: string): { scheme: string; host: string } {
  const scheme = href.match(/^([a-z][a-z0-9+.-]*):/i)?.[1]?.toLowerCase() ?? "";
  if (scheme === "mailto") {
    const addr = href.slice(7).split("?")[0];
    return { scheme, host: addr.slice(addr.lastIndexOf("@") + 1).toLowerCase() };
  }
  try {
    return { scheme, host: new URL(href).hostname.toLowerCase() };
  } catch {
    // fallback: relative, malformed or scheme-less target; report it without a host
    return { scheme, host: "" };
  }
}

const HOSTISH = /\b(?:https?:\/\/)?((?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,})\b/i;

/** Host named by visible link text such as `www.bank.com` or `https://bank.com/login`. */
function textHost(text: string): string | undefined {
  if (/@/.test(text)) return undefined; // an address, not a host claim
  const m = text.match(HOSTISH);
  if (!m) return undefined;
  const host = m[1].toLowerCase();
  // Require a known-looking TLD shape and avoid sentence fragments like "e.g".
  return /\.[a-z]{2,}$/.test(host) ? host : undefined;
}

function link(href: string, text: string, source: LinkRef["source"]): LinkRef {
  const t = target(href);
  const th = text ? textHost(text) : undefined;
  return {
    href,
    scheme: t.scheme,
    host: t.host,
    text,
    ...(th ? { textHost: th } : {}),
    mismatch: !!(th && t.host && orgDomain(th) !== orgDomain(t.host)),
    source,
  };
}

/** Every `<a href>` in an HTML string, with its visible text. */
export function extractHtmlLinks(html: string): LinkRef[] {
  const out: LinkRef[] = [];
  const re = /<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi;
  for (const m of html.matchAll(re)) {
    const attr = m[1].match(/\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i);
    if (!attr) continue;
    const href = decodeEntities((attr[1] ?? attr[2] ?? attr[3] ?? "").trim());
    if (!href) continue;
    const text = decodeEntities(m[2].replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
    out.push(link(href, text, "text/html"));
  }
  return out;
}

/** Bare `http(s)://` URLs in plain text. */
export function extractTextLinks(text: string): LinkRef[] {
  return [...text.matchAll(/\bhttps?:\/\/[^\s<>"')\]]+/gi)].map((m) =>
    link(m[0].replace(/[.,;:!?]+$/, ""), "", "text/plain")
  );
}

/**
 * Links in a message's body: from the first non-attachment `text/html` part, else bare URLs in
 * the first `text/plain` part. Needs `format: "full"`.
 */
export function messageLinks(msg: Message): MessageLinks {
  const parts: MessagePart[] = [];
  const walk = (p?: MessagePart) => {
    if (!p) return;
    parts.push(p);
    p.parts?.forEach(walk);
  };
  walk(msg.payload);
  const body = (type: string) =>
    parts.find((p) => p.mimeType === type && !!p.body?.data && !p.filename);
  const decode = (p: MessagePart) => new TextDecoder().decode(decodeBase64Url(p.body!.data!));
  const html = body("text/html");
  const plain = body("text/plain");
  const links = html
    ? extractHtmlLinks(decode(html))
    // fallback: no HTML part; plain-text mail carries only bare URLs, with no link text to compare
    : plain
    ? extractTextLinks(decode(plain))
    : [];
  const counts = new Map<string, number>();
  for (const l of links) if (l.host) counts.set(l.host, (counts.get(l.host) ?? 0) + 1);
  const hosts = [...counts].map(([host, count]) => ({ host, count }))
    .sort((a, b) => b.count - a.count || a.host.localeCompare(b.host));
  return { links, hosts, mismatches: links.filter((l) => l.mismatch).length };
}
