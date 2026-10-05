/**
 * Bounces: parse a delivery failure notice into who failed, why, and which message it was.
 * Handles RFC 3464 delivery status notifications (`multipart/report;
 * report-type=delivery-status`) and, as a fallback, the plain-text notices some relays send.
 * Pure except {@link findBounces}, which searches the mailbox.
 * @module
 */

import type { GmailClient } from "./client.ts";
import { decodeBase64Url, header } from "./mime.ts";
import type { Message, MessagePart } from "./types.ts";

/** What a failure most likely means, from its status code and diagnostic text. */
export type BounceReason =
  | "no-such-user" // the mailbox does not exist (5.1.1, "invalid recipient", "user unknown")
  | "suppressed" // a relay refused because the address bounced before (suppression list)
  | "mailbox-full" // over quota (5.2.2)
  | "domain-not-found" // the recipient domain has no mail server or does not resolve
  | "policy" // rejected by policy: spam, authentication, blocked sender (5.7.x)
  | "temporary" // a 4.x failure; the sender may still be retrying
  | "other";

/** One failed (or delayed) recipient in a bounce. */
export interface BounceRecipient {
  /** The address that failed (`Final-Recipient`, else parsed from the text). */
  address: string;
  /** `Action`: `failed`, `delayed`, `delivered`, `relayed`, `expanded`. Text notices: `failed`. */
  action: string;
  /** Enhanced status code (`5.1.1`), when given or found in the diagnostic. */
  status?: string;
  /** `permanent` for 5.x, `transient` for 4.x. */
  severity?: "permanent" | "transient";
  /** The server that refused (`Remote-MTA`, or the host named in a text notice). */
  remoteMta?: string;
  /** The refusing server's own words (`Diagnostic-Code`, or the text notice's line). */
  diagnostic?: string;
  /** Best guess at the cause; see {@link BounceReason}. */
  reason: BounceReason;
}

/** The message that bounced, from the returned headers when the report includes them. */
export interface BouncedMessage {
  /** `Message-ID` of the original (also `X-Original-Message-ID` on Gmail reports). */
  messageId?: string;
  /** Original `From`: the address it was sent as. */
  from?: string;
  /** Original `To`. */
  to?: string;
  /** Original `Cc`. */
  cc?: string;
  /** Original `Subject`. */
  subject?: string;
  /** Original `Date`. */
  date?: string;
}

/** A parsed bounce. */
export interface Bounce {
  /** `dsn` for an RFC 3464 report; `text` when parsed from a plain-text notice. */
  kind: "dsn" | "text";
  /** Gmail id of the bounce message itself. */
  bounceId: string;
  /** `Date` of the bounce. */
  date: string;
  /** Who sent the bounce, e.g. `mailer-daemon@googlemail.com`. */
  reporter: string;
  /** `Reporting-MTA`, when given. */
  reportingMta?: string;
  /** Every recipient the report covers, failed or not. */
  recipients: BounceRecipient[];
  /** The original message, when the report returned its headers. */
  original: BouncedMessage;
}

function decode(p: MessagePart): string {
  return p.body?.data ? new TextDecoder().decode(decodeBase64Url(p.body.data)) : "";
}

function walk(p: MessagePart | undefined, out: MessagePart[] = []): MessagePart[] {
  if (!p) return out;
  out.push(p);
  p.parts?.forEach((c) => walk(c, out));
  return out;
}

/** Parse `Name: value` lines with RFC 5322 continuation into groups split by blank lines. */
function fieldGroups(text: string): Record<string, string>[] {
  const groups: Record<string, string>[] = [];
  let cur: Record<string, string> = {};
  let last = "";
  for (const line of text.replace(/\r\n/g, "\n").split("\n")) {
    if (!line.trim()) {
      if (Object.keys(cur).length) groups.push(cur);
      cur = {};
      last = "";
    } else if (/^[ \t]/.test(line) && last) {
      cur[last] += " " + line.trim();
    } else {
      const i = line.indexOf(":");
      if (i > 0) {
        last = line.slice(0, i).trim().toLowerCase();
        cur[last] = line.slice(i + 1).trim();
      }
    }
  }
  if (Object.keys(cur).length) groups.push(cur);
  return groups;
}

/** Strip an address-type prefix: `rfc822; a@b` → `a@b`, `dns; host` → `host`. */
const typed = (v?: string) => v?.replace(/^[a-z0-9-]+\s*;\s*/i, "").trim();

/** Classify a failure from its enhanced status code and diagnostic text. */
export function bounceReason(
  status: string | undefined,
  diagnostic: string | undefined,
): BounceReason {
  const d = (diagnostic ?? "").toLowerCase();
  if (
    /previously bounced|suppress|on (the|our) (bounce|block) ?list|recipient is blocked by suppression/
      .test(d)
  ) {
    return "suppressed";
  }
  if (
    status === "5.1.1" || status === "5.1.10" ||
    /invalid recipient|user unknown|unknown user|no such (user|mailbox)|does not exist|mailbox unavailable|recipient (address )?rejected|address not found|not a valid recipient/
      .test(d)
  ) return "no-such-user";
  if (status === "5.2.2" || /quota|mailbox (is )?full|over ?quota/.test(d)) return "mailbox-full";
  if (
    status === "5.1.2" || status === "5.4.4" ||
    /name or service not known|domain not found|no mx|host not found|nxdomain|unrouteable/.test(d)
  ) return "domain-not-found";
  if (
    status?.startsWith("5.7") || /spam|blocked|blacklist|dmarc|spf|policy|not authori[sz]ed/.test(d)
  ) {
    return "policy";
  }
  if (status?.startsWith("4") || /^4\d\d\b/.test(d)) return "temporary";
  return "other";
}

function recipient(
  address: string,
  action: string,
  status: string | undefined,
  remoteMta: string | undefined,
  diagnostic: string | undefined,
): BounceRecipient {
  const enhanced = /\b([245]\.\d{1,3}\.\d{1,3})\b/;
  // fallback: no usable Status (absent, or a bare SMTP code like "550"); take the enhanced code
  // out of the diagnostic text if present
  const st = status?.match(enhanced)?.[1] ?? diagnostic?.match(enhanced)?.[1];
  // fallback: some relays write Final-Recipient as free text; keep just the address
  address = address.match(/[\w.+-]+(?:'[\w.+-]+)*@[\w-]+(?:\.[\w-]+)+/)?.[0] ?? address;
  const severity = st?.startsWith("5")
    ? "permanent"
    : st?.startsWith("4")
    ? "transient"
    : /\b5\d\d\b/.test(diagnostic ?? "")
    ? "permanent"
    : /\b4\d\d\b/.test(diagnostic ?? "")
    ? "transient"
    : undefined;
  return {
    address: address.toLowerCase(),
    action: action.toLowerCase(),
    ...(st ? { status: st } : {}),
    ...(severity ? { severity } : {}),
    ...(remoteMta ? { remoteMta } : {}),
    ...(diagnostic ? { diagnostic } : {}),
    reason: bounceReason(st, diagnostic),
  };
}

function originalFrom(fields: Record<string, string>): BouncedMessage {
  const o: BouncedMessage = {};
  if (fields["message-id"]) o.messageId = fields["message-id"];
  if (fields["from"]) o.from = fields["from"];
  if (fields["to"]) o.to = fields["to"];
  if (fields["cc"]) o.cc = fields["cc"];
  if (fields["subject"]) o.subject = fields["subject"];
  if (fields["date"]) o.date = fields["date"];
  return o;
}

/** True when the message looks like a delivery failure notice. */
export function isBounce(msg: Message): boolean {
  const ct = header(msg.payload, "Content-Type") ?? msg.payload?.mimeType ?? "";
  if (/report-type\s*=\s*"?delivery-status/i.test(ct)) return true;
  const from = (header(msg.payload, "From") ?? "").toLowerCase();
  const subject = (header(msg.payload, "Subject") ?? "").toLowerCase();
  return /mailer-daemon|postmaster|bounces?[.@]/.test(from) &&
    /deliver|undeliver|failure|returned|bounce/.test(subject);
}

/**
 * Parse a bounce, or return null when the message is not one. Needs `format: "full"`.
 *
 * For an RFC 3464 report the `message/delivery-status` part is read whole; Gmail delivers it
 * with the per-message fields as part headers and the per-recipient fields as a child
 * `text/plain`, so both are read. Returned headers come from `text/rfc822-headers`,
 * `message/rfc822-headers` or `message/rfc822`. Without a report, recipients are taken from
 * a plain-text notice: each address on a line near a 4xx/5xx diagnostic.
 */
export function parseBounce(msg: Message): Bounce | null {
  if (!isBounce(msg)) return null;
  const parts = walk(msg.payload);
  const base = {
    bounceId: msg.id,
    date: header(msg.payload, "Date") ?? "",
    reporter: header(msg.payload, "From") ?? "",
  };

  const ds = parts.find((p) => p.mimeType === "message/delivery-status");
  if (ds) {
    // Gmail splits the report: per-message fields arrive as headers of the report part or of
    // its child, per-recipient fields as the child's body. Rebuild it as one field block.
    const fieldLines = (p: MessagePart) =>
      (p.headers ?? []).filter((h) => !/^content-/i.test(h.name)).map((h) =>
        `${h.name}: ${h.value}`
      );
    const text = [
      ...fieldLines(ds),
      ...(ds.parts ?? []).flatMap(fieldLines),
      "",
      decode(ds),
      ...(ds.parts ?? []).map(decode),
    ].join("\n");
    const groups = fieldGroups(text);
    const perMessage = Object.assign({}, ...groups.filter((g) => !g["final-recipient"]));
    const recipients = groups.filter((g) => g["final-recipient"]).map((g) =>
      recipient(
        typed(g["final-recipient"]) ?? "",
        g["action"] ?? "failed",
        g["status"],
        typed(g["remote-mta"]),
        typed(g["diagnostic-code"]),
      )
    );
    const returned = parts.find((p) =>
      /^(text\/rfc822-headers|message\/rfc822-headers)$/.test(p.mimeType ?? "")
    );
    const embedded = parts.find((p) => p.mimeType === "message/rfc822");
    let original: BouncedMessage = {};
    if (returned) original = originalFrom(fieldGroups(decode(returned))[0] ?? {});
    else if (embedded?.parts?.[0]?.headers) {
      const f: Record<string, string> = {};
      for (const h of embedded.parts[0].headers) f[h.name.toLowerCase()] ??= h.value;
      original = originalFrom(f);
    }
    // fallback: no returned headers; Gmail still names the original in its per-message fields
    if (!original.messageId && perMessage["x-original-message-id"]) {
      original.messageId = perMessage["x-original-message-id"];
    }
    return {
      kind: "dsn",
      ...base,
      ...(perMessage["reporting-mta"] ? { reportingMta: typed(perMessage["reporting-mta"]) } : {}),
      recipients,
      original,
    };
  }

  // fallback: no machine-readable report; read the human notice the relay sent instead
  const body = parts.filter((p) => p.mimeType === "text/plain" && !p.filename).map(decode)
    .join("\n");
  const lines = body.split(/\r?\n/);
  const recipients: BounceRecipient[] = [];
  const seen = new Set<string>();
  lines.forEach((line, i) => {
    for (const m of line.matchAll(/[\w.+-]+(?:'[\w.+-]+)*@[\w-]+(?:\.[\w-]+)+/g)) {
      const address = m[0].toLowerCase();
      if (seen.has(address) || address === base.reporter.toLowerCase()) continue;
      const near = lines.slice(i, i + 4).join(" ");
      const diag = near.match(/(?:responded with|said|error|reason)\s*:\s*(.+)$/i)?.[1]?.trim() ??
        (/\b[45]\d\d\b/.test(near) ? near.trim() : undefined);
      if (!diag) continue;
      seen.add(address);
      const host = near.match(/host\s+([\w.-]+\.[a-z]{2,})/i)?.[1];
      recipients.push(recipient(address, "failed", undefined, host, diag));
    }
  });
  const xFailed = header(msg.payload, "X-Failed-Recipients");
  if (!recipients.length && xFailed) {
    for (const a of xFailed.split(",").map((x) => x.trim()).filter(Boolean)) {
      recipients.push(recipient(a, "failed", undefined, undefined, undefined));
    }
  }
  return { kind: "text", ...base, recipients, original: {} };
}

/** Gmail query matching delivery failure notices from common senders. */
export const BOUNCE_QUERY =
  '(from:mailer-daemon OR from:postmaster OR from:bounces OR subject:undeliverable OR subject:"delivery status notification" OR subject:"mail delivery failure" OR subject:"returned mail")';

/** Options for {@link findBounces}. */
export interface FindBouncesOptions {
  /** Only bounces that name this recipient. */
  recipient?: string;
  /** Look back this many days. Default 90. */
  days?: number;
  /** Max bounce messages to read. Default 50. */
  max?: number;
}

/**
 * Search the mailbox for bounces and parse each, newest first. A recipient that bounced
 * before is the usual reason a relay now refuses it outright ("suppressed").
 */
export async function findBounces(
  gmail: GmailClient,
  opts: FindBouncesOptions = {},
): Promise<Bounce[]> {
  const days = opts.days ?? 90;
  const q = [BOUNCE_QUERY, `newer_than:${days}d`, opts.recipient ? `"${opts.recipient}"` : ""]
    .filter(Boolean).join(" ");
  const list = await gmail.listMessages(q, { maxResults: opts.max ?? 50 });
  const out: Bounce[] = [];
  for (const ref of list.messages ?? []) {
    const b = parseBounce(await gmail.getMessage(ref.id, "full"));
    if (!b) continue;
    if (
      opts.recipient &&
      !b.recipients.some((r) => r.address === opts.recipient!.toLowerCase())
    ) continue;
    out.push(b);
  }
  return out;
}
