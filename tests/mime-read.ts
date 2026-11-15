/**
 * Test-only reader for the raw messages the builder writes: headers, the multipart tree and decoded
 * bodies. Not a general MIME parser; it reads what `buildRawMessage` produces.
 */

/** One MIME part: its headers (lower-cased names), decoded body bytes, and children if multipart. */
export interface Part {
  headers: Record<string, string>;
  /** The content type without parameters, lower-cased. */
  type: string;
  body: Uint8Array;
  parts: Part[];
}

/** base64url (unpadded) → bytes. */
export function fromBase64Url(s: string): Uint8Array {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  return Uint8Array.from(atob(b64 + "=".repeat((4 - b64.length % 4) % 4)), (c) => c.charCodeAt(0));
}

function headersOf(head: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of head.replace(/\r\n[ \t]+/g, " ").split("\r\n")) {
    const i = line.indexOf(":");
    if (i > 0) out[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
  }
  return out;
}

function parsePart(raw: string): Part {
  const cut = raw.indexOf("\r\n\r\n");
  const headers = headersOf(cut < 0 ? raw : raw.slice(0, cut));
  const content = cut < 0 ? "" : raw.slice(cut + 4);
  const ct = headers["content-type"] ?? "text/plain";
  const type = ct.split(";")[0].trim().toLowerCase();
  if (type.startsWith("multipart/")) {
    const boundary = /boundary="?([^";]+)"?/.exec(ct)![1];
    const pieces = content.split(`--${boundary}`).slice(1);
    const parts = pieces.filter((p) => !p.startsWith("--")).map((p) =>
      parsePart(p.replace(/^\r\n/, "").replace(/\r\n$/, ""))
    );
    return { headers, type, body: new Uint8Array(), parts };
  }
  const enc = (headers["content-transfer-encoding"] ?? "").toLowerCase();
  const body = enc === "base64"
    ? Uint8Array.from(atob(content.replace(/\s+/g, "")), (c) => c.charCodeAt(0))
    : new TextEncoder().encode(content);
  return { headers, type, body, parts: [] };
}

/** Read a `message.raw` value (base64url of the whole RFC 5322 message). */
export function readRaw(raw: string): Part {
  return parsePart(new TextDecoder().decode(fromBase64Url(raw)));
}

/** Every leaf part, depth first. */
export function leaves(p: Part): Part[] {
  return p.parts.length ? p.parts.flatMap(leaves) : [p];
}

/** The decoded text of the first leaf of `type`, or undefined. */
export function textOf(p: Part, type: string): string | undefined {
  const leaf = leaves(p).find((l) => l.type === type && !l.headers["content-disposition"]);
  return leaf ? new TextDecoder().decode(leaf.body) : undefined;
}

/** The tree's shape, e.g. `multipart/mixed[multipart/alternative[text/plain,text/html],application/pdf]`. */
export function shape(p: Part): string {
  return p.parts.length ? `${p.type}[${p.parts.map(shape).join(",")}]` : p.type;
}
