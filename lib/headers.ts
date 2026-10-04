/**
 * Message headers for checking where a message came from: the raw header list, a parse of
 * `Authentication-Results` (RFC 8601), and a summary of DKIM, SPF and DMARC with flags for
 * the usual phishing tells. Pure: works on a message fetched with `format: "full"` or
 * `"metadata"`, no I/O.
 * @module
 */

import { header } from "./mime.ts";
import type { Message } from "./types.ts";

/** One header line, in the order the message carries it (newest `Received` first). */
export interface HeaderLine {
  /** Header name as sent. */
  name: string;
  /** Header value as Gmail returns it (unfolded). */
  value: string;
}

/** Every top-level header of a message, in order. */
export function allHeaders(msg: Message): HeaderLine[] {
  return (msg.payload?.headers ?? []).map((h) => ({ name: h.name, value: h.value }));
}

/** Header names that matter when deciding whether mail is genuine. */
export const PROVENANCE_HEADERS: readonly string[] = [
  "From",
  "Reply-To",
  "Return-Path",
  "Sender",
  "Delivered-To",
  "Message-ID",
  "Authentication-Results",
  "ARC-Authentication-Results",
  "Received-SPF",
  "DKIM-Signature",
  "Received",
];

/** The {@link PROVENANCE_HEADERS} of a message, in message order. */
export function provenanceHeaders(msg: Message): HeaderLine[] {
  const want = new Set(PROVENANCE_HEADERS.map((n) => n.toLowerCase()));
  return allHeaders(msg).filter((h) => want.has(h.name.toLowerCase()));
}

/** One method result inside an `Authentication-Results` header, e.g. `dkim=pass header.d=x`. */
export interface AuthMethodResult {
  /** Method name, lower case: `dkim`, `spf`, `dmarc`, `arc`, … */
  method: string;
  /** Result, lower case: `pass`, `fail`, `softfail`, `neutral`, `none`, `temperror`, … */
  result: string;
  /** `ptype.property` values, e.g. `{ "header.i": "@example.com", "smtp.mailfrom": "…" }`. */
  props: Record<string, string>;
  /** Text of any parenthesised comments, joined with a space. */
  comment: string;
}

/** A parsed `Authentication-Results` header. */
export interface AuthenticationResults {
  /** Who did the checking, e.g. `mx.google.com`. */
  authservId: string;
  /** One entry per method result, in order. */
  results: AuthMethodResult[];
}

/** Split on `sep` outside double quotes and parentheses. */
function splitTop(s: string, sep: string): string[] {
  const out: string[] = [];
  let depth = 0, quoted = false, cur = "";
  for (const ch of s) {
    if (ch === '"' && depth === 0) quoted = !quoted;
    else if (!quoted && ch === "(") depth++;
    else if (!quoted && ch === ")" && depth > 0) depth--;
    if (ch === sep && depth === 0 && !quoted) {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  out.push(cur);
  return out.map((x) => x.trim()).filter(Boolean);
}

/** Parse one `Authentication-Results` (or `ARC-Authentication-Results`, minus its `i=N;`) value. */
export function parseAuthenticationResults(value: string): AuthenticationResults {
  const segments = splitTop(value.replace(/^\s*i=\d+\s*;/, ""), ";");
  const authservId = (segments.shift() ?? "").split(/\s+/)[0].toLowerCase();
  const results: AuthMethodResult[] = [];
  for (const seg of segments) {
    const comments: string[] = [];
    const bare = seg.replace(/\(([^()]*)\)/g, (_, c: string) => {
      comments.push(c.trim());
      return " ";
    });
    const tokens = bare.match(/[^\s=]+\s*=\s*(?:"[^"]*"|[^\s;]+)/g) ?? [];
    const [first, ...rest] = tokens;
    if (!first) continue;
    const [method, result] = first.split("=").map((x) => x.trim().toLowerCase());
    const props: Record<string, string> = {};
    for (const t of rest) {
      const i = t.indexOf("=");
      props[t.slice(0, i).trim().toLowerCase()] = t.slice(i + 1).trim().replace(/^"|"$/g, "");
    }
    results.push({ method, result, props, comment: comments.join(" ") });
  }
  return { authservId, results };
}

/** The domain of the first address in a header value (`Name <a@b.c>` or `a@b.c`), lower case. */
export function addressDomain(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const addr = value.match(/<([^>]*)>/)?.[1] ?? value;
  const at = addr.lastIndexOf("@");
  if (at < 0) return undefined;
  return addr.slice(at + 1).trim().replace(/[>"\s].*$/, "").replace(/\.$/, "").toLowerCase() ||
    undefined;
}

// Second-level labels under which registrations sit one level deeper (example.co.uk).
const SLD = new Set(["co", "org", "ac", "gov", "net", "com", "ltd", "plc", "me", "nhs", "sch"]);

/**
 * Approximate organisational domain: the last two labels, or three under a two-letter country
 * code with a common second level (`a.b.example.co.uk` → `example.co.uk`). Approximate because it
 * uses no Public Suffix List; good enough for "is this the same organisation?" flags.
 */
export function orgDomain(domain: string): string {
  const labels = domain.toLowerCase().replace(/\.$/, "").split(".");
  if (labels.length <= 2) return labels.join(".");
  const tld = labels.at(-1)!, sld = labels.at(-2)!;
  const n = tld.length === 2 && SLD.has(sld) ? 3 : 2;
  return labels.slice(-n).join(".");
}

/** Phishing tells raised by {@link authSummary}. Any one of these deserves a closer look. */
export type AuthFlag =
  | "no-authentication-results"
  | "dkim-fail"
  | "dkim-not-aligned"
  | "spf-fail"
  | "dmarc-fail"
  | "dmarc-none"
  | "reply-to-other-domain";

/**
 * Facts that are normal on their own but worth knowing: `return-path-other-domain` is usual
 * for mail sent through a bulk provider (bounces go to the provider), and `dmarc-policy-none`
 * means the sender's domain asks receivers not to act on failures.
 */
export type AuthNote = "return-path-other-domain" | "dmarc-policy-none";

/** DKIM, SPF and DMARC as Gmail's receiving server judged them, plus flags. */
export interface AuthSummary {
  /** The `Authentication-Results` the summary was taken from; null when there was none. */
  authservId: string | null;
  /** Each DKIM result with the signing domain (`header.d`, else `header.i`) and selector. */
  dkim: { result: string; domain?: string; selector?: string }[];
  /** SPF result with the envelope sender (`smtp.mailfrom`). */
  spf: { result: string; mailfrom?: string } | null;
  /** DMARC result with the published policy (from Google's comment) and `header.from`. */
  dmarc: { result: string; policy?: string; headerFrom?: string } | null;
  /** Domain of `From`. */
  fromDomain?: string;
  /** Domain of `Reply-To`, if present. */
  replyToDomain?: string;
  /** Domain of `Return-Path` (the envelope sender). */
  returnPathDomain?: string;
  /** Warnings: each is a reason to doubt the message. Empty means nothing suspicious here. */
  flags: AuthFlag[];
  /** Context, not warnings; see {@link AuthNote}. */
  notes: AuthNote[];
}

/**
 * Summarise how the receiving server authenticated a message. Uses the **topmost**
 * `Authentication-Results` whose authserv-id is `preferAuthserv` (default `mx.google.com`),
 * because that is the one the receiving server added; any lower copy could have been written
 * by the sender. Falls back to the topmost header of any authserv-id.
 */
export function authSummary(
  msg: Message,
  opts: { preferAuthserv?: string } = {},
): AuthSummary {
  const prefer = (opts.preferAuthserv ?? "mx.google.com").toLowerCase();
  const parsed = allHeaders(msg)
    .filter((h) => h.name.toLowerCase() === "authentication-results")
    .map((h) => parseAuthenticationResults(h.value));
  // fallback: no header from the preferred server; use the topmost one from anyone
  const ar = parsed.find((p) => p.authservId === prefer) ?? parsed[0];
  const fromDomain = addressDomain(header(msg.payload, "From"));
  const replyToDomain = addressDomain(header(msg.payload, "Reply-To"));
  const returnPathDomain = addressDomain(header(msg.payload, "Return-Path"));
  const of = (m: string) => ar?.results.filter((r) => r.method === m) ?? [];
  const dkim = of("dkim").map((r) => {
    const domain = r.props["header.d"] ?? addressDomain(r.props["header.i"]) ??
      r.props["header.i"]?.replace(/^@/, "");
    return {
      result: r.result,
      ...(domain ? { domain: domain.toLowerCase() } : {}),
      ...(r.props["header.s"] ? { selector: r.props["header.s"] } : {}),
    };
  });
  const spfR = of("spf")[0];
  const spf = spfR
    ? {
      result: spfR.result,
      ...(spfR.props["smtp.mailfrom"] ? { mailfrom: spfR.props["smtp.mailfrom"] } : {}),
    }
    : null;
  const dmarcR = of("dmarc")[0];
  const policy = dmarcR?.comment.match(/\bp=([a-z]+)/i)?.[1]?.toLowerCase();
  const dmarc = dmarcR
    ? {
      result: dmarcR.result,
      ...(policy ? { policy } : {}),
      ...(dmarcR.props["header.from"] ? { headerFrom: dmarcR.props["header.from"] } : {}),
    }
    : null;

  const flags: AuthFlag[] = [];
  if (!ar) flags.push("no-authentication-results");
  if (dkim.some((d) => d.result !== "pass") && !dkim.some((d) => d.result === "pass")) {
    flags.push("dkim-fail");
  }
  const fromOrg = fromDomain ? orgDomain(fromDomain) : undefined;
  if (
    fromOrg && !dkim.some((d) => d.result === "pass" && d.domain && orgDomain(d.domain) === fromOrg)
  ) flags.push("dkim-not-aligned");
  if (spf && ["fail", "softfail"].includes(spf.result)) flags.push("spf-fail");
  if (dmarc && dmarc.result !== "pass" && dmarc.result !== "none") flags.push("dmarc-fail");
  if (ar && (!dmarc || dmarc.result === "none")) flags.push("dmarc-none");
  if (fromOrg && replyToDomain && orgDomain(replyToDomain) !== fromOrg) {
    flags.push("reply-to-other-domain");
  }
  const notes: AuthNote[] = [];
  if (fromOrg && returnPathDomain && orgDomain(returnPathDomain) !== fromOrg) {
    notes.push("return-path-other-domain");
  }
  if (dmarc?.policy === "none") notes.push("dmarc-policy-none");
  return {
    authservId: ar?.authservId ?? null,
    dkim,
    spf,
    dmarc,
    ...(fromDomain ? { fromDomain } : {}),
    ...(replyToDomain ? { replyToDomain } : {}),
    ...(returnPathDomain ? { returnPathDomain } : {}),
    flags,
    notes,
  };
}
