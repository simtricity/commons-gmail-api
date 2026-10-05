/** Offline tests for bounce.ts on synthetic fixtures shaped like real Gmail, relay and text notices. */
import { assert, assertEquals } from "@std/assert";
import {
  bounceReason,
  isBounce,
  type Message,
  type MessagePart,
  parseBounce,
  readMessage,
  toBase64Url,
} from "../mod.ts";

const b64url = (s: string) =>
  toBase64Url(btoa(String.fromCharCode(...new TextEncoder().encode(s))));
const part = (
  mimeType: string,
  opts: { text?: string; headers?: [string, string][]; parts?: MessagePart[] } = {},
): MessagePart => ({
  mimeType,
  filename: "",
  headers: (opts.headers ?? []).map(([name, value]) => ({ name, value })),
  body: opts.text !== undefined ? { size: opts.text.length, data: b64url(opts.text) } : { size: 0 },
  parts: opts.parts,
});
const msg = (headers: [string, string][], parts: MessagePart[]): Message => ({
  id: "b1",
  threadId: "t1",
  payload: {
    mimeType: "multipart/report",
    filename: "",
    headers: headers.map(([name, value]) => ({ name, value })),
    body: { size: 0 },
    parts,
  },
} as Message);

const REPORT_HEADERS: [string, string][] = [
  ["From", "Mail Delivery Subsystem <mailer-daemon@googlemail.com>"],
  ["Subject", "Delivery Status Notification (Failure)"],
  ["Date", "Mon, 05 Oct 2026 02:22:46 -0700"],
  ["Content-Type", 'multipart/report; boundary="x"; report-type=delivery-status'],
];

Deno.test("Gmail-shaped report: fields split across part headers and child body", () => {
  const b = parseBounce(msg(REPORT_HEADERS, [
    part("text/plain", { text: "** Message not delivered **" }),
    part("message/delivery-status", {
      headers: [["Content-Type", "message/delivery-status"]],
      parts: [part("text/plain", {
        headers: [
          ["Reporting-MTA", "dns; googlemail.com"],
          ["X-Original-Message-ID", "<orig@mail.example.com>"],
        ],
        text: "Final-Recipient: rfc822; Former.Staff@Customer.example.co.uk\n" +
          "Action: failed\nStatus: 5.2.1\n" +
          "Remote-MTA: dns; smtp.relay.example.net (192.0.2.7, the relay for the domain.)\n" +
          "Diagnostic-Code: smtp; 550 5.2.1 Not sending to previously bounced email\n",
      })],
    }),
    part("text/rfc822-headers", {
      text: "From: Me <me@alias.example.org>\nTo: A <a@customer.example.co.uk>\n" +
        "Cc: B <former.staff@customer.example.co.uk>\nSubject: Re: Invoices\n" +
        "Message-ID: <orig@mail.example.com>\nDate: Mon, 5 Oct 2026 10:22:30 +0100\n\n",
    }),
  ]))!;
  assertEquals(b.kind, "dsn");
  assertEquals(b.reportingMta, "googlemail.com");
  assertEquals(b.recipients, [{
    address: "former.staff@customer.example.co.uk",
    action: "failed",
    status: "5.2.1",
    severity: "permanent",
    remoteMta: "smtp.relay.example.net (192.0.2.7, the relay for the domain.)",
    diagnostic: "550 5.2.1 Not sending to previously bounced email",
    reason: "suppressed",
  }]);
  assertEquals(b.original.from, "Me <me@alias.example.org>");
  assertEquals(b.original.subject, "Re: Invoices");
  assertEquals(b.original.messageId, "<orig@mail.example.com>");
});

Deno.test("relay report with free-text Final-Recipient and a bare 550 status", () => {
  const b = parseBounce(msg([
    ["From", "no-reply@bounces.relay.example.net"],
    ["Subject", "Mail Delivery failure."],
  ], [
    part("text/plain", { text: "A message you sent could not be delivered." }),
    part("message/delivery-status", {
      text: "Reporting-MTA: dns; relay.example.net\n\n" +
        "Final-Recipient: ['', 'gone@customer.example.co.uk'] (failed recipient!)\n" +
        "Action: failed\nStatus: 550\n" +
        "Diagnostic-Code: <mx.customer.example.co.uk> : 550 - 550 Invalid Recipient\n",
    }),
  ]))!;
  assertEquals(b.recipients[0].address, "gone@customer.example.co.uk");
  assertEquals(b.recipients[0].status, undefined, "a bare SMTP code is not an enhanced status");
  assertEquals(b.recipients[0].severity, "permanent");
  assertEquals(b.recipients[0].reason, "no-such-user");
});

Deno.test("plain-text notice without a report: recipients from the text", () => {
  const b = parseBounce(msg([
    ["From", "MAILER-DAEMON@mx.example.net"],
    ["Subject", "Undelivered Mail Returned to Sender"],
  ], [
    part("text/plain", {
      text: "The following address(es) failed:\n\n    nobody@nowhere.example.com\n" +
        "      Host nowhere.example.com said: 450 4.5.1 Name or service not known\n",
    }),
  ]))!;
  assertEquals(b.kind, "text");
  assertEquals(b.recipients.length, 1);
  assertEquals(b.recipients[0].address, "nobody@nowhere.example.com");
  assertEquals(b.recipients[0].severity, "transient");
  assertEquals(b.recipients[0].reason, "domain-not-found");
});

Deno.test("X-Failed-Recipients is the last resort", () => {
  const b = parseBounce(msg([
    ["From", "postmaster@mx.example.net"],
    ["Subject", "Delivery failure"],
    ["X-Failed-Recipients", "x@example.com, y@example.com"],
  ], [part("text/plain", { text: "Sorry." })]))!;
  assertEquals(b.recipients.map((r) => r.address), ["x@example.com", "y@example.com"]);
});

Deno.test("isBounce ignores ordinary mail; readMessage adds bounce only for bounces", () => {
  const normal = msg([["From", "a@example.com"], ["Subject", "Delivery of your order"]], [
    part("text/plain", { text: "Your parcel is on its way." }),
  ]);
  assertEquals(isBounce(normal), false);
  assertEquals(parseBounce(normal), null);
  assertEquals(readMessage(normal).bounce, undefined);
  const report = msg(REPORT_HEADERS, [
    part("message/delivery-status", {
      text: "Final-Recipient: rfc822; z@example.com\nAction: failed\nStatus: 5.1.1\n",
    }),
  ]);
  assert(readMessage(report).bounce);
});

Deno.test("bounceReason maps status codes and wording", () => {
  assertEquals(bounceReason("5.1.1", undefined), "no-such-user");
  assertEquals(bounceReason(undefined, "550 Invalid Recipient"), "no-such-user");
  assertEquals(bounceReason("5.2.1", "Not sending to previously bounced email"), "suppressed");
  assertEquals(bounceReason("5.2.2", undefined), "mailbox-full");
  assertEquals(bounceReason("5.7.1", "rejected by DMARC policy"), "policy");
  assertEquals(bounceReason("4.4.1", "connection timed out"), "temporary");
  assertEquals(bounceReason(undefined, "Name or service not known"), "domain-not-found");
  assertEquals(bounceReason("5.0.0", "something else"), "other");
});
