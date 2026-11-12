/**
 * Offline tests for drafting: threaded replies, HTML bodies, quoted history, reply-all, signatures,
 * listing, forwarding and updating drafts. Synthetic mailbox only.
 */
import { assert, assertEquals } from "@std/assert";
import {
  buildRawMessage,
  composeBody,
  escapeHtml,
  QUOTE_MAX_CHARS,
  quoteBlock,
  textToHtml,
} from "../mod.ts";
import { FakeGmail, type FixtureMessage } from "./replies-fake.ts";
import { leaves, readRaw, shape, textOf } from "./mime-read.ts";

const ORIGINAL: FixtureMessage = {
  id: "orig",
  threadId: "t1",
  headers: {
    "From": "Sender Name <sender@away.test>",
    "Reply-To": "Desk <desk@away.test>",
    "To": "owner@home.test",
    "Subject": "Quote request",
    "Date": "Tue, 10 Nov 2026 09:15:00 +0000",
    "Message-ID": "<m2@away.test>",
    "References": "<m1@away.test>",
  },
  text: "Please send the quote.",
};

const posted = (fake: FakeGmail) =>
  fake.writes().at(-1)!.body as { message: { raw: string; threadId?: string } };

Deno.test("regression: a reply draft with an attachment keeps every threading header", async () => {
  const fake = new FakeGmail([ORIGINAL]);
  const { writer } = fake.writers();
  await writer.createDraft({
    replyToMessageId: "orig",
    text: "Attached.",
    quote: false,
    attachments: [{ filename: "quote.pdf", content: new Uint8Array([37, 80, 68, 70]) }],
  });
  const body = posted(fake);
  assertEquals(body.message.threadId, "t1");
  const m = readRaw(body.message.raw);
  assertEquals(m.headers["in-reply-to"], "<m2@away.test>");
  assertEquals(m.headers["references"], "<m1@away.test> <m2@away.test>");
  assertEquals(m.headers["subject"], "Re: Quote request");
  assertEquals(m.headers["to"], "Desk <desk@away.test>", "Reply-To is preferred over From");
  assertEquals(shape(m), "multipart/mixed[text/plain,application/pdf]");
  const file = leaves(m).find((p) => p.type === "application/pdf")!;
  assertEquals([...file.body], [37, 80, 68, 70]);

  const noReplyTo = new FakeGmail([{
    ...ORIGINAL,
    headers: { ...ORIGINAL.headers, "Reply-To": "" },
  }]);
  delete noReplyTo.messages.get("orig")!.headers["Reply-To"];
  await noReplyTo.writers().writer.createDraft({
    replyToMessageId: "orig",
    text: "x",
    quote: false,
  });
  assertEquals(
    readRaw(posted(noReplyTo).message.raw).headers["to"],
    "Sender Name <sender@away.test>",
  );
});

Deno.test("builder: text alone, text with HTML, and either with files, as the right MIME tree", () => {
  const base = { to: ["a@b.test"], subject: "S", text: "Plain — café" };
  const html = "<p>Rich — <b>café</b></p>";
  const file = { filename: "f.pdf", content: new Uint8Array([1, 2, 3, 250]) };

  const plain = readRaw(buildRawMessage(base));
  assertEquals(shape(plain), "text/plain");
  assertEquals(textOf(plain, "text/plain"), "Plain — café");

  const alt = readRaw(buildRawMessage({ ...base, html }));
  assertEquals(shape(alt), "multipart/alternative[text/plain,text/html]");
  assertEquals(textOf(alt, "text/plain"), "Plain — café");
  assertEquals(textOf(alt, "text/html"), html, "HTML is sent exactly as given");
  for (const l of leaves(alt)) assert(l.headers["content-type"].includes("charset=UTF-8"));

  const mixed = readRaw(buildRawMessage({ ...base, html, attachments: [file] }));
  assertEquals(
    shape(mixed),
    "multipart/mixed[multipart/alternative[text/plain,text/html],application/pdf]",
  );
  assertEquals([...leaves(mixed).find((p) => p.type === "application/pdf")!.body], [1, 2, 3, 250]);
  assertEquals(textOf(mixed, "text/html"), html);

  assertEquals(
    shape(readRaw(buildRawMessage({ ...base, attachments: [file] }))),
    "multipart/mixed[text/plain,application/pdf]",
    "files without HTML keep the 0.5.0 shape",
  );
  assertEquals(
    buildRawMessage({ ...base, html }),
    buildRawMessage({ ...base, html }),
    "deterministic",
  );
});

Deno.test("composer: plain stays plain; HTML, signature and tail in Gmail's order", () => {
  assertEquals(composeBody({ text: "hi" }), { text: "hi" }, "nothing needs HTML: plain text only");

  const sig = { html: "<b>Jo</b>", text: "Jo" };
  const tail = { text: "On X, Y wrote:\n> q", html: '<div class="gmail_quote">Q</div>' };
  assertEquals(composeBody({ text: "a<b\nc", html: undefined, signature: sig }), {
    text: "a<b\nc\n\n-- \nJo",
    html: '<div dir="ltr">a&lt;b<br>c</div><br><div class="gmail_signature"><b>Jo</b></div>',
  });
  assertEquals(composeBody({ text: "t", html: "<i>t</i>", tail }), {
    text: "t\n\nOn X, Y wrote:\n> q",
    html: '<div dir="ltr"><i>t</i></div><br><div class="gmail_quote">Q</div>',
  });
  const both = composeBody({ text: "t", signature: sig, tail });
  assert(
    both.html!.indexOf("gmail_signature") < both.html!.indexOf("gmail_quote"),
    "signature above the quote",
  );
  assert(both.text.indexOf("-- ") < both.text.indexOf("wrote:"));

  assertEquals(
    escapeHtml(`<a href="x" onerror='y'>&</a>`),
    "&lt;a href=&quot;x&quot; onerror=&#39;y&#39;&gt;&amp;&lt;/a&gt;",
  );
  assertEquals(textToHtml("a\r\nb\nc"), "a<br>b<br>c");
});

Deno.test("createDraft with an HTML body sends text and HTML as alternatives", async () => {
  const fake = new FakeGmail();
  await fake.writers().writer.createDraft({
    to: ["x@away.test"],
    subject: "S",
    text: "Plain",
    html: "<p>Rich</p>",
  });
  const m = readRaw(posted(fake).message.raw);
  assertEquals(shape(m), "multipart/alternative[text/plain,text/html]");
  assertEquals([textOf(m, "text/plain"), textOf(m, "text/html")], [
    "Plain",
    '<div dir="ltr"><p>Rich</p></div>',
  ]);
});

Deno.test("quote: attribution, `> ` lines, and Gmail's quote wrapper", () => {
  const q = quoteBlock({
    date: "Tue, 10 Nov 2026 09:15:00 +0000",
    from: "A <a@x.test>",
    text: "one\n\ntwo",
  });
  assertEquals(q.text, "On Tue, 10 Nov 2026 09:15:00 +0000, A <a@x.test> wrote:\n> one\n>\n> two");
  assert(q.html.startsWith('<div class="gmail_quote"><div class="gmail_attr">On Tue'));
  assert(q.html.includes("A &lt;a@x.test&gt; wrote:<br></div>"), "attribution escaped");
  assert(q.html.includes('<blockquote class="gmail_quote"'));
  assert(q.html.includes(">one<br><br>two</blockquote></div>"));

  assertEquals(quoteBlock({ from: "A", text: "x" }).text, "A wrote:\n> x", "no Date header");
});

Deno.test("quote: hostile original text is escaped, never live HTML", () => {
  const evil = `<script>alert(1)</script> <img src=http://track.test/p.gif onerror="x()"> & co`;
  const q = quoteBlock({ from: `"Eve" <e@x.test>`, text: evil });
  for (const bad of ["<script", "<img", 'onerror="']) assert(!q.html.includes(bad), bad);
  assert(q.html.includes("&lt;script&gt;alert(1)&lt;/script&gt;"));
  assert(q.html.includes("&amp; co"));
  assert(q.html.includes("&quot;Eve&quot;"));
});

Deno.test("quote: capped at QUOTE_MAX_CHARS with a marker", () => {
  const long = "y".repeat(QUOTE_MAX_CHARS + 10);
  const q = quoteBlock({ from: "A", text: long });
  assert(q.text.endsWith("> [… quoted text shortened]"));
  assertEquals(q.text.split("y").length - 1, QUOTE_MAX_CHARS);
  assert(!quoteBlock({ from: "A", text: "short" }).text.includes("shortened"));
});

Deno.test("reply draft quotes the original by default; quote:false leaves it out", async () => {
  const html = '<p>Please send the <b>quote</b>.</p><img src="http://track.test/p.gif">';
  const fake = new FakeGmail([{ ...ORIGINAL, html }]);
  const { writer } = fake.writers();
  const plan = await writer.buildDraft({ replyToMessageId: "orig", text: "Here it is." });
  assertEquals(plan.quoted, true);
  assertEquals(fake.writes().length, 0, "buildDraft writes nothing");
  assert(fake.calls.some((c) => c.path.includes("format=full")));

  await writer.createDraft({ replyToMessageId: "orig", text: "Here it is." });
  const m = readRaw(posted(fake).message.raw);
  assertEquals(shape(m), "multipart/alternative[text/plain,text/html]");
  assertEquals(
    textOf(m, "text/plain"),
    "Here it is.\n\nOn Tue, 10 Nov 2026 09:15:00 +0000, Sender Name <sender@away.test> wrote:\n" +
      "> Please send the quote.",
    "the original's text/plain is what is quoted",
  );
  const h = textOf(m, "text/html")!;
  assert(h.startsWith('<div dir="ltr">Here it is.</div><br><div class="gmail_quote">'));
  assert(!h.includes("<img") && !h.includes("<b>"), "none of the original's HTML is carried");

  const off = new FakeGmail([ORIGINAL]);
  const p2 = await off.writers().writer.buildDraft({
    replyToMessageId: "orig",
    text: "x",
    quote: false,
  });
  assertEquals(p2.quoted, false);
  assertEquals(shape(readRaw(p2.message.raw)), "text/plain");
  assert(
    off.calls.some((c) => c.path.includes("format=metadata")),
    "no body read when not quoting",
  );
});

Deno.test("reply quote falls back to the original's HTML as text when it has no text/plain", async () => {
  const fake = new FakeGmail([{
    ...ORIGINAL,
    text: undefined,
    html: "<p>Only <i>html</i> &amp; more</p>",
  }]);
  const plan = await fake.writers().writer.buildDraft({ replyToMessageId: "orig", text: "ok" });
  const t = textOf(readRaw(plan.message.raw), "text/plain")!;
  assert(t.includes("> Only html & more"), t);
});

Deno.test("quote is ignored on a new draft", async () => {
  const fake = new FakeGmail();
  const plan = await fake.writers().writer.buildDraft({
    to: ["x@away.test"],
    subject: "S",
    text: "t",
    quote: true,
  });
  assertEquals(plan.quoted, false);
  assertEquals(shape(readRaw(plan.message.raw)), "text/plain");
});
