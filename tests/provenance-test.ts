/** Offline tests for headers.ts (Authentication-Results, auth summary) and links.ts. */
import { assert, assertEquals } from "@std/assert";
import {
  addressDomain,
  authSummary,
  extractHtmlLinks,
  extractTextLinks,
  type Message,
  messageLinks,
  orgDomain,
  parseAuthenticationResults,
  provenanceHeaders,
  readMessage,
  toBase64Url,
} from "../mod.ts";

const b64url = (s: string) =>
  toBase64Url(btoa(String.fromCharCode(...new TextEncoder().encode(s))));

function msg(
  headers: [string, string][],
  body: { html?: string; plain?: string } = {},
): Message {
  const parts = [
    ...(body.plain !== undefined
      ? [{ mimeType: "text/plain", filename: "", body: { size: 1, data: b64url(body.plain) } }]
      : []),
    ...(body.html !== undefined
      ? [{ mimeType: "text/html", filename: "", body: { size: 1, data: b64url(body.html) } }]
      : []),
  ];
  return {
    id: "m1",
    threadId: "t1",
    payload: {
      mimeType: "multipart/alternative",
      filename: "",
      headers: headers.map(([name, value]) => ({ name, value })),
      body: { size: 0 },
      parts,
    },
  } as Message;
}

const GENUINE_AR = "mx.google.com; dkim=pass header.i=@shop.example.com header.s=sel1 " +
  "header.b=AbCd; spf=pass (google.com: domain of bounce+x@mailer.example.net designates " +
  '192.0.2.1 as permitted sender) smtp.mailfrom="bounce+x@mailer.example.net"; ' +
  "dmarc=pass (p=REJECT sp=REJECT dis=NONE) header.from=shop.example.com";

Deno.test("parseAuthenticationResults: authserv-id, results, quoted props, comments", () => {
  const r = parseAuthenticationResults(GENUINE_AR);
  assertEquals(r.authservId, "mx.google.com");
  assertEquals(r.results.map((x) => `${x.method}=${x.result}`), [
    "dkim=pass",
    "spf=pass",
    "dmarc=pass",
  ]);
  assertEquals(r.results[0].props["header.i"], "@shop.example.com");
  assertEquals(r.results[0].props["header.s"], "sel1");
  assertEquals(r.results[1].props["smtp.mailfrom"], "bounce+x@mailer.example.net");
  assert(r.results[2].comment.includes("p=REJECT"));
  // ARC form carries a leading instance tag
  assertEquals(parseAuthenticationResults(`i=1; ${GENUINE_AR}`).authservId, "mx.google.com");
});

Deno.test("authSummary: genuine bulk mail has no flags, only notes", () => {
  const a = authSummary(msg([
    ["Return-Path", "<bounce+x@mailer.example.net>"],
    ["Authentication-Results", GENUINE_AR],
    ["From", "Shop <orders@shop.example.com>"],
  ]));
  assertEquals(a.dkim, [{ result: "pass", domain: "shop.example.com", selector: "sel1" }]);
  assertEquals(a.spf, { result: "pass", mailfrom: "bounce+x@mailer.example.net" });
  assertEquals(a.dmarc, { result: "pass", policy: "reject", headerFrom: "shop.example.com" });
  assertEquals(a.flags, []);
  assertEquals(a.notes, ["return-path-other-domain"]);
});

Deno.test("authSummary: lookalike sender raises dkim, dmarc and reply-to flags", () => {
  const a = authSummary(msg([
    [
      "Authentication-Results",
      "mx.google.com; dkim=pass header.i=@lookalike.example.org header.s=s; " +
      "spf=softfail smtp.mailfrom=x@lookalike.example.org; " +
      "dmarc=fail (p=QUARANTINE sp=NONE dis=QUARANTINE) header.from=bank.example.com",
    ],
    ["From", "Bank <security@bank.example.com>"],
    ["Reply-To", "help@lookalike.example.org"],
  ]));
  assertEquals(a.flags.sort(), [
    "dkim-not-aligned",
    "dmarc-fail",
    "reply-to-other-domain",
    "spf-fail",
  ]);
});

Deno.test("authSummary trusts the topmost mx.google.com header, not a forged lower one", () => {
  const a = authSummary(msg([
    ["Authentication-Results", "mx.google.com; dkim=fail header.d=bank.example.com; dmarc=fail"],
    ["Authentication-Results", "mx.google.com; dkim=pass header.d=bank.example.com; dmarc=pass"],
    ["From", "security@bank.example.com"],
  ]));
  assertEquals(a.dkim[0].result, "fail");
  assert(a.flags.includes("dmarc-fail"));
});

Deno.test("authSummary flags a message with no Authentication-Results", () => {
  const a = authSummary(msg([["From", "a@b.example.com"]]));
  assertEquals(a.authservId, null);
  assert(a.flags.includes("no-authentication-results"));
});

Deno.test("addressDomain and orgDomain", () => {
  assertEquals(addressDomain('"A, B" <x@Mail.Example.COM>'), "mail.example.com");
  assertEquals(addressDomain("<bounce@x.example.net>"), "x.example.net");
  assertEquals(addressDomain("no address"), undefined);
  assertEquals(orgDomain("a.b.example.co.uk"), "example.co.uk");
  assertEquals(orgDomain("mail.example.com"), "example.com");
  assertEquals(orgDomain("example.com"), "example.com");
});

Deno.test("provenanceHeaders keeps only the provenance set, in order", () => {
  const names = provenanceHeaders(msg([
    ["Received", "r2"],
    ["Subject", "s"],
    ["Received", "r1"],
    ["DKIM-Signature", "d=x"],
    ["X-Mailer", "m"],
  ])).map((h) => h.name);
  assertEquals(names, ["Received", "Received", "DKIM-Signature"]);
});

Deno.test("extractHtmlLinks: entities, quoting, mailto, and text/target mismatch", () => {
  const links = extractHtmlLinks(`
    <a href="https://www.shop.example.com/a?x=1&amp;y=2">Your <b>order</b></a>
    <a class=c href='https://evil.example.net/login'>https://www.bank.example.com/login</a>
    <a href="https://links.shop.example.com/t">shop.example.com</a>
    <a href=mailto:help@shop.example.com>email us</a>
    <a name="anchor">no href</a>`);
  assertEquals(links.length, 4);
  assertEquals(links[0].href, "https://www.shop.example.com/a?x=1&y=2");
  assertEquals(links[0].text, "Your order");
  assertEquals(links[0].mismatch, false);
  assertEquals(links[1].host, "evil.example.net");
  assertEquals(links[1].textHost, "www.bank.example.com");
  assertEquals(links[1].mismatch, true);
  assertEquals(links[2].mismatch, false, "same organisation, different subdomain");
  assertEquals([links[3].scheme, links[3].host], ["mailto", "shop.example.com"]);
});

Deno.test("extractTextLinks trims trailing punctuation", () => {
  const l = extractTextLinks("See https://a.example.com/x. Or (https://b.example.org/y), thanks");
  assertEquals(l.map((x) => x.href), ["https://a.example.com/x", "https://b.example.org/y"]);
  assert(l.every((x) => x.source === "text/plain"));
});

Deno.test("messageLinks prefers HTML, counts hosts, falls back to plain text", () => {
  const html = msg([["From", "a@shop.example.com"]], {
    plain: "ignored https://plain.example.com",
    html: '<a href="https://a.example.com/1">1</a><a href="https://a.example.com/2">2</a>' +
      '<a href="https://b.example.com/">www.other.example.org</a>',
  });
  const r = messageLinks(html);
  assertEquals(r.hosts, [{ host: "a.example.com", count: 2 }, { host: "b.example.com", count: 1 }]);
  assertEquals(r.mismatches, 1);
  const plain = messageLinks(msg([], { plain: "go to https://c.example.com/now" }));
  assertEquals(plain.links[0].host, "c.example.com");
});

Deno.test("readMessage always carries auth; headers and links only when asked", () => {
  const m = msg([["From", "a@shop.example.com"], ["Authentication-Results", GENUINE_AR]], {
    html: '<a href="https://shop.example.com">x</a>',
  });
  const plain = readMessage(m);
  assertEquals(plain.auth.dkim[0].result, "pass");
  assertEquals(plain.headers, undefined);
  assertEquals(plain.links, undefined);
  const full = readMessage(m, { headers: true, links: true });
  assertEquals(full.headers?.length, 2);
  assertEquals(full.links?.links.length, 1);
});
