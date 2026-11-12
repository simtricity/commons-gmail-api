/**
 * Offline tests for drafting: threaded replies, HTML bodies, quoted history, reply-all, signatures,
 * listing, forwarding and updating drafts. Synthetic mailbox only.
 */
import { assert, assertEquals } from "@std/assert";
import {
  AttachmentLimitError,
  buildRawMessage,
  carryAttachments,
  composeBody,
  DraftChangedError,
  DraftNotEditableError,
  escapeHtml,
  FORWARD_MARKER,
  forwardBlock,
  forwardSubject,
  MAX_ATTACHMENT_BYTES,
  QUOTE_MAX_CHARS,
  quoteBlock,
  replyAllRecipients,
  SCOPE_READONLY,
  scrubSignatureHtml,
  sha256Hex,
  signatureBlock,
  splitAddresses,
  textToHtml,
} from "../mod.ts";
import { FakeGmail, type FixtureMessage, OWNER, WRITE } from "./replies-fake.ts";
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

Deno.test("recipients: address lists split on commas outside quotes, brackets and comments", () => {
  assertEquals(
    splitAddresses(`"Doe, Jo" <jo@x.test>, b@y.test,(c, d) c@z.test , <e@w.test>`),
    ['"Doe, Jo" <jo@x.test>', "b@y.test", "(c, d) c@z.test", "<e@w.test>"],
  );
  assertEquals(splitAddresses(undefined), []);
  assertEquals(splitAddresses(`"a \\"q, r\\"" <a@x.test>`), [`"a \\"q, r\\"" <a@x.test>`]);
});

Deno.test("reply-all: from someone else, self removed, cc never repeats to", () => {
  const self = new Set([OWNER, "alias@home.test"]);
  const r = replyAllRecipients({
    from: "Sender Name <sender@away.test>",
    to: `Owner <OWNER@home.test>, "Doe, Jo" <jo@away.test>, sender@away.test`,
    cc: "alias@home.test, Kim <kim@away.test>, jo@away.test",
  }, self);
  assertEquals(r, {
    to: ["Sender Name <sender@away.test>"],
    cc: ['"Doe, Jo" <jo@away.test>', "Kim <kim@away.test>"],
  });
  assertEquals(
    replyAllRecipients({ from: "s@away.test", replyTo: "Desk <desk@away.test>", to: OWNER }, self),
    { to: ["Desk <desk@away.test>"], cc: [] },
    "Reply-To wins over From",
  );
});

Deno.test("reply-all: from yourself, to and cc are the original's, minus you", () => {
  const self = new Set([OWNER, "alias@home.test"]);
  assertEquals(
    replyAllRecipients({
      from: "Me <alias@home.test>",
      to: "a@away.test, owner@home.test",
      cc: "b@away.test, Alias <ALIAS@home.test>, a@away.test",
    }, self),
    { to: ["a@away.test"], cc: ["b@away.test"] },
  );
});

const GROUP: FixtureMessage = {
  ...ORIGINAL,
  headers: {
    ...ORIGINAL.headers,
    "Reply-To": "",
    "To": `${OWNER}, Jo <jo@away.test>`,
    "Cc": "Kim <kim@away.test>, alias@home.test",
  },
};

Deno.test("createDraft replyAll: computed recipients, caller to replaces, caller cc adds, no bcc", async () => {
  const fake = new FakeGmail([GROUP]);
  fake.sendAs.push({ sendAsEmail: "alias@home.test" });
  const { writer } = fake.writers();

  const p = await writer.buildDraft({ replyToMessageId: "orig", text: "all", replyAll: true });
  assertEquals(p.recipients, {
    to: ["Sender Name <sender@away.test>"],
    cc: ["Jo <jo@away.test>", "Kim <kim@away.test>"],
    bcc: [],
  });
  const m = readRaw(p.message.raw);
  assertEquals(m.headers["cc"], "Jo <jo@away.test>, Kim <kim@away.test>");
  assertEquals(m.headers["bcc"], undefined, "Bcc is never computed");

  const p2 = await writer.buildDraft({
    replyToMessageId: "orig",
    text: "x",
    replyAll: true,
    to: ["jo@away.test"],
    cc: ["new@away.test", "kim@away.test"],
  });
  assertEquals(p2.recipients.to, ["jo@away.test"]);
  assertEquals(p2.recipients.cc, ["Kim <kim@away.test>", "new@away.test"]);

  const sendAsReads = () => fake.calls.filter((c) => c.path.includes("sendAs")).length;
  const before = sendAsReads();
  const plain = await writer.buildDraft({ replyToMessageId: "orig", text: "x", quote: false });
  assertEquals(plain.recipients, { to: ["Sender Name <sender@away.test>"], cc: [], bcc: [] });
  assertEquals(sendAsReads(), before, "a plain reply reads no send-as");
});

Deno.test("createDraft replyAll without replyToMessageId is a TypeError before any call", async () => {
  const fake = new FakeGmail();
  let err: unknown;
  try {
    await fake.writers().writer.createDraft({ to: ["x@away.test"], text: "x", replyAll: true });
  } catch (e) {
    err = e;
  }
  assert(err instanceof TypeError);
  assertEquals(fake.calls.length, 0);
});

Deno.test("signature scrub: scripts, styles, handlers and script URLs out; images kept", () => {
  const cases: [string, string][] = [
    [
      '<b>Jo</b><img src="data:image/png;base64,AA" alt="logo" ONLOAD="x()"/>',
      '<b>Jo</b><img src="data:image/png;base64,AA" alt="logo"/>',
    ],
    [
      '<img src="https://cdn.test/logo.png" width=80>',
      '<img src="https://cdn.test/logo.png" width=80>',
    ],
    [
      '<a href=" jav&#x61;script:alert(1)">l</a><a href="https://e.test">ok</a>',
      '<a>l</a><a href="https://e.test">ok</a>',
    ],
    ['<a href="&#106;avascript:1">l</a><a href=VBScript:x>v</a>', "<a>l</a><a>v</a>"],
    ["<sc<script>x</script>ript>alert(1)</script>after", "after"],
    ["<style>p{}</style><div onclick=x>d</div><script src=x.js>", "<div>d</div>"],
    [`<p title='a onerror=b'>t</p>`, `<p title='a onerror=b'>t</p>`],
    ['<img alt="x>" onerror=y', '&lt;img alt="x>" onerror=y'],
    ["a < b and <c", "a &lt; b and &lt;c"],
  ];
  for (const [input, want] of cases) assertEquals(scrubSignatureHtml(input), want, input);
  assertEquals(signatureBlock("<div>Jo Bloggs<br>Desk</div>"), {
    html: "<div>Jo Bloggs<br>Desk</div>",
    text: "Jo Bloggs\nDesk",
  });
  assertEquals(signatureBlock(""), null);
  assertEquals(signatureBlock("<script>x</script>"), null);
});

Deno.test("createDraft signature: the default send-as's, above the quote; none; off", async () => {
  const fake = new FakeGmail([ORIGINAL]);
  fake.sendAs = [
    { sendAsEmail: OWNER, isPrimary: true, signature: "<b>Primary</b>" },
    {
      sendAsEmail: "alias@home.test",
      isDefault: true,
      signature: '<b>Alias</b><img src="cid:x" onerror="y">',
    },
  ];
  const { writer } = fake.writers();
  const p = await writer.buildDraft({
    replyToMessageId: "orig",
    text: "hi",
    signature: true,
    replyAll: true,
  });
  assertEquals(p.signature, "added");
  assertEquals(fake.calls.filter((c) => c.path.includes("sendAs")).length, 1, "send-as read once");
  const m = readRaw(p.message.raw);
  const h = textOf(m, "text/html")!;
  assert(h.includes('<div class="gmail_signature"><b>Alias</b><img src="cid:x"></div>'), h);
  assert(h.indexOf("gmail_signature") < h.indexOf("gmail_quote"));
  assert(textOf(m, "text/plain")!.startsWith("hi\n\n-- \nAlias\n\nOn "));

  fake.sendAs = [{ sendAsEmail: OWNER, isPrimary: true, signature: "<i>P</i>" }];
  const primary = await writer.buildDraft({ to: ["x@away.test"], text: "t", signature: true });
  assert(
    textOf(readRaw(primary.message.raw), "text/html")!.includes("<i>P</i>"),
    "falls back to the primary",
  );

  fake.sendAs = [{ sendAsEmail: OWNER, isPrimary: true, isDefault: true }];
  const none = await writer.buildDraft({ to: ["x@away.test"], text: "t", signature: true });
  assertEquals(none.signature, "none");
  assertEquals(shape(readRaw(none.message.raw)), "text/plain");

  const off = await writer.buildDraft({ to: ["x@away.test"], text: "t" });
  assertEquals(off.signature, "off");
});

Deno.test("listDrafts: newest first, bounded, filtered, metadata only, on the read grant", async () => {
  const fake = new FakeGmail([ORIGINAL]);
  const { writer } = fake.writers();
  await writer.createDraft({ to: ["a@away.test"], subject: "First", text: "1" });
  await writer.createDraft({ replyToMessageId: "orig", text: "2", quote: false });

  const reader = fake.client(SCOPE_READONLY);
  const all = await reader.listDrafts();
  assertEquals(all.map((d) => [d.id, d.subject, d.to]), [
    ["d2", "Re: Quote request", "Desk <desk@away.test>"],
    ["d1", "First", "a@away.test"],
  ]);
  assertEquals(all[0].threadId, "t1");
  assertEquals(all[0].messageId, "m-d2-1");
  assertEquals(typeof all[0].date, "string", "Date is added by Gmail on save; the fake has none");
  assertEquals((await reader.listDrafts({ max: 1 })).length, 1);
  assertEquals((await reader.listDrafts({ q: "First" })).map((d) => d.id), ["d1"]);
  const reads = fake.calls.filter((c) => c.path.startsWith("/messages/m-d"));
  assert(reads.length > 0 && reads.every((c) => c.path.includes("format=metadata")));
  assertEquals(fake.writes().length, 2, "listing writes nothing");

  assertEquals(await new FakeGmail().client(WRITE).listDrafts(), [], "no drafts");
});

Deno.test("guard createDraft: result carries recipients, quoted and signature; log has counts only", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const log = `${dir}/writes.log`;
    const fake = new FakeGmail([GROUP]);
    fake.sendAs = [
      { sendAsEmail: OWNER, isPrimary: true, isDefault: true, signature: "<b>S</b>" },
      { sendAsEmail: "alias@home.test" },
    ];
    const r = await fake.writers(log).guard.createDraft({
      replyToMessageId: "orig",
      text: "hi",
      replyAll: true,
      signature: true,
      bcc: ["hidden@away.test"],
    });
    assertEquals(r.sent, false);
    assertEquals(r.recipients, {
      to: ["Sender Name <sender@away.test>"],
      cc: ["Jo <jo@away.test>", "Kim <kim@away.test>"],
      bcc: ["hidden@away.test"],
    });
    assertEquals([r.quoted, r.signature], [true, "added"]);
    const text = await Deno.readTextFile(log);
    const line = JSON.parse(text.trim());
    assertEquals(line.op, "draft.create");
    assertEquals(line.recipients, { to: 1, cc: 2, bcc: 1 });
    assertEquals([line.quoted, line.signature], [true, "added"]);
    assertEquals(line.account, OWNER, "the log names the mailbox, as for every write");
    assert(!text.includes("away.test") && !text.includes("alias@"), "no recipient is ever logged");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

const bytes = (...b: number[]) => new Uint8Array(b);
const WITH_FILES: FixtureMessage = {
  ...ORIGINAL,
  id: "files",
  files: [
    { filename: "invoice.pdf", mimeType: "application/pdf", bytes: bytes(37, 80, 68, 70, 0, 255) },
    { filename: "logo.png", mimeType: "image/png", bytes: bytes(137, 80), inline: true },
    { filename: "rates.xlsx", mimeType: "application/vnd.ms-excel", bytes: bytes(80, 75, 3, 4) },
    { filename: "tiny.txt", mimeType: "text/plain", bytes: bytes(104, 105), embedded: true },
  ],
};

Deno.test("carry: regular files exact with sha256; inline counted, not carried; embedded kept", async () => {
  const fake = new FakeGmail([WITH_FILES]);
  const r = await carryAttachments(fake.client(), "files");
  assertEquals(r.files.map((f) => [f.filename, f.mimeType, [...f.content]]), [
    ["invoice.pdf", "application/pdf", [37, 80, 68, 70, 0, 255]],
    ["rates.xlsx", "application/vnd.ms-excel", [80, 75, 3, 4]],
    ["tiny.txt", "text/plain", [104, 105]],
  ]);
  assertEquals(r.sha256, await Promise.all(r.files.map((f) => sha256Hex(f.content))));
  assertEquals(r.sha256[0], await sha256Hex(bytes(37, 80, 68, 70, 0, 255)));
  assertEquals([r.skippedInline, r.totalBytes], [1, 12]);
  assertEquals(
    fake.downloads,
    ["files-att-0", "files-att-2"],
    "inline and embedded need no download",
  );
});

Deno.test("carry: selector, and a message already read", async () => {
  const fake = new FakeGmail([WITH_FILES]);
  const c = fake.client();
  const msg = await c.getMessage("files", "full");
  const before = fake.calls.length;
  const r = await carryAttachments(c, msg, { select: (f) => f.filename === "rates.xlsx" });
  assertEquals(r.files.map((f) => f.filename), ["rates.xlsx"]);
  assertEquals(fake.calls.slice(before).map((c) => c.path), [
    "/messages/files/attachments/files-att-2",
  ]);
});

Deno.test("carry: the size check runs before any download", async () => {
  const fake = new FakeGmail([WITH_FILES]);
  fake.failDownloads = true; // a download would fail loudly; the limit must fire first
  let err: unknown;
  try {
    await carryAttachments(fake.client(), "files", { limit: 11 });
  } catch (e) {
    err = e;
  }
  assert(err instanceof AttachmentLimitError, String(err));
  assertEquals([err.totalBytes, err.limit], [12, 11]);
  assertEquals(fake.downloads, []);

  let err2: unknown;
  try {
    await carryAttachments(fake.client(), "files", { limit: 20, addedBytes: 9 });
  } catch (e) {
    err2 = e;
  }
  assert(err2 instanceof AttachmentLimitError, "added files count toward the limit");
  assertEquals(fake.downloads, []);
});

Deno.test("forward block: Gmail's marker and header lines, unprefixed text, escaped HTML", () => {
  const b = forwardBlock({
    from: "A <a@x.test>",
    date: "Tue, 10 Nov 2026 09:15:00 +0000",
    subject: "Q & A",
    to: "b@x.test",
    text: "line <one>\n\nline two",
  });
  assertEquals(
    b.text,
    `${FORWARD_MARKER}\nFrom: A <a@x.test>\nDate: Tue, 10 Nov 2026 09:15:00 +0000\n` +
      "Subject: Q & A\nTo: b@x.test\n\nline <one>\n\nline two",
    "no Cc line when the original had none; text not > prefixed",
  );
  assert(b.html.startsWith('<div class="gmail_quote"><div dir="ltr" class="gmail_attr">-'));
  assert(b.html.includes("From: A &lt;a@x.test&gt;<br>"));
  assert(b.html.includes("Subject: Q &amp; A<br>"));
  assert(b.html.includes("line &lt;one&gt;<br><br>line two</div>"));
  assert(forwardBlock({ from: "a", cc: "c@x.test", text: "" }).text.includes("\nCc: c@x.test\n"));
  const evil = forwardBlock({
    from: "e",
    text: `<script>x</script><img src=http://t.test/p onerror="y">`,
  });
  for (const bad of ["<script", "<img", 'onerror="']) assert(!evil.html.includes(bad), bad);
});

Deno.test("forward subject: one Fwd: prefix, whatever case or form the original has", () => {
  assertEquals(forwardSubject("Quote"), "Fwd: Quote");
  assertEquals(forwardSubject("Fwd: Quote"), "Fwd: Quote");
  assertEquals(forwardSubject("Fw: Quote"), "Fw: Quote");
  assertEquals(forwardSubject("FW: Quote"), "FW: Quote");
  assertEquals(forwardSubject("fwd:Quote"), "fwd:Quote");
  assertEquals(forwardSubject("Re: Quote"), "Fwd: Re: Quote");
  assertEquals(forwardSubject(""), "Fwd: ");
});

const FWD_ORIGINAL: FixtureMessage = {
  ...WITH_FILES,
  headers: { ...WITH_FILES.headers, "Cc": "Kim <kim@away.test>" },
};

Deno.test("forwardDraft: caller's recipients only, Gmail's threading, all files, block in body", async () => {
  const fake = new FakeGmail([FWD_ORIGINAL]);
  const { writer } = fake.writers();
  const p = await writer.buildForward({ messageId: "files", to: ["me@home.test"], text: "FYI" });
  assertEquals(p.recipients, { to: ["me@home.test"], cc: [], bcc: [] });
  assertEquals(p.message.threadId, "t1", "stays in the original's thread, as Gmail's Forward does");
  const m = readRaw(p.message.raw);
  assertEquals(m.headers["subject"], "Fwd: Quote request");
  assertEquals(m.headers["in-reply-to"], "<m2@away.test>");
  assertEquals(m.headers["references"], "<m1@away.test> <m2@away.test>");
  assertEquals(m.headers["to"], "me@home.test");
  assertEquals(m.headers["cc"], undefined, "nothing computed from the original");
  assertEquals(m.headers["bcc"], undefined);
  assertEquals(
    shape(m),
    "multipart/mixed[multipart/alternative[text/plain,text/html],application/pdf,application/vnd.ms-excel,text/plain]",
  );
  const t = textOf(m, "text/plain")!;
  assert(t.startsWith(`FYI\n\n${FORWARD_MARKER}\nFrom: Sender Name <sender@away.test>\n`), t);
  assert(t.includes("\nCc: Kim <kim@away.test>\n\nPlease send the quote."));
  assertEquals(p.carried.count, 3);
  assertEquals(p.skippedInline, 1, "the inline logo is reported, not carried");
  const sent = leaves(m).filter((l) => l.headers["content-disposition"]?.startsWith("attachment"));
  assertEquals(await Promise.all(sent.map((l) => sha256Hex(l.body))), p.carried.sha256);
  assertEquals(p.carried.sha256[0], await sha256Hex(bytes(37, 80, 68, 70, 0, 255)));
  assertEquals(fake.writes().length, 0, "buildForward writes nothing");
});

Deno.test("forwardDraft: none, by name, unknown name thrown before any download", async () => {
  const fake = new FakeGmail([FWD_ORIGINAL]);
  const { writer } = fake.writers();
  const none = await writer.buildForward({
    messageId: "files",
    to: ["me@home.test"],
    attachments: "none",
  });
  assertEquals([none.carried.count, none.skippedInline], [0, 1]);
  assertEquals(shape(readRaw(none.message.raw)), "multipart/alternative[text/plain,text/html]");
  assertEquals(fake.downloads, []);

  const one = await writer.buildForward({
    messageId: "files",
    to: ["me@home.test"],
    attachments: ["rates.xlsx"],
  });
  assertEquals(one.carried.count, 1);
  assertEquals(fake.downloads, ["files-att-2"]);

  let err: unknown;
  try {
    await writer.buildForward({
      messageId: "files",
      to: ["me@home.test"],
      attachments: ["rates.xlsx", "logo.png", "nope.doc"],
    });
  } catch (e) {
    err = e;
  }
  assert(err instanceof TypeError && /logo\.png.*nope\.doc/.test(err.message), String(err));
  assertEquals(fake.downloads, ["files-att-2"], "nothing more downloaded");
});

Deno.test("forwardDraft: no to is refused before any request; oversize before any download", async () => {
  const fake = new FakeGmail([FWD_ORIGINAL]);
  const { writer } = fake.writers();
  let err: unknown;
  try {
    await writer.buildForward({ messageId: "files", to: [] });
  } catch (e) {
    err = e;
  }
  assert(err instanceof TypeError);
  assertEquals(fake.calls.length, 0);

  const big = new FakeGmail([{
    ...FWD_ORIGINAL,
    files: [{
      filename: "huge.bin",
      mimeType: "application/octet-stream",
      bytes: bytes(1),
      declaredSize: MAX_ATTACHMENT_BYTES + 1,
    }],
  }]);
  big.failDownloads = true;
  let err2: unknown;
  try {
    await big.writers().writer.buildForward({ messageId: "files", to: ["me@home.test"] });
  } catch (e) {
    err2 = e;
  }
  assert(err2 instanceof AttachmentLimitError, String(err2));
  assertEquals(big.downloads, []);
  assertEquals(big.writes().length, 0);
});

Deno.test("guard forwardDraft: result, and a log line with counts and sha256 only", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const log = `${dir}/writes.log`;
    const fake = new FakeGmail([FWD_ORIGINAL]);
    const r = await fake.writers(log).guard.forwardDraft({
      messageId: "files",
      to: ["me@home.test"],
      cc: ["x@away.test"],
    });
    assertEquals(r.sent, false);
    assertEquals(r.recipients.cc, ["x@away.test"]);
    assertEquals([r.carried.count, r.skippedInline, r.signature], [3, 1, "off"]);
    const text = await Deno.readTextFile(log);
    const line = JSON.parse(text.trim());
    assertEquals(line.op, "draft.forward");
    assertEquals(line.recipients, { to: 1, cc: 1, bcc: 0 });
    assertEquals(line.carried.sha256, r.carried.sha256);
    for (const leak of ["away.test", "me@home", "invoice", "rates", "Quote"]) {
      assert(!text.includes(leak), `log holds no names or addresses: ${leak}`);
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

const FILE_A = { filename: "a.pdf", content: bytes(37, 80, 68, 70, 1, 2, 3) };
const FILE_B = { filename: "b.xlsx", content: bytes(80, 75, 3, 4, 9) };

/** sha256 of every attached file in a raw message, in order. */
const fileHashes = (raw: string) =>
  Promise.all(
    leaves(readRaw(raw))
      .filter((l) => l.headers["content-disposition"]?.startsWith("attachment"))
      .map((l) => sha256Hex(l.body)),
  );

/** A fake holding ORIGINAL and one reply draft "d1" with two files, quoted. */
async function replyDraft() {
  const fake = new FakeGmail([ORIGINAL]);
  const { writer, guard } = fake.writers();
  await writer.createDraft({
    replyToMessageId: "orig",
    text: "First version.",
    replyAll: true,
    bcc: ["hidden@away.test"],
    attachments: [FILE_A, FILE_B],
  });
  const raw = fake.drafts.get("d1")!.message.raw!;
  return { fake, writer, guard, raw };
}

Deno.test("updateDraft with nothing given keeps everything: headers, body parts, files", async () => {
  const { fake, writer, raw } = await replyDraft();
  const plan = await writer.buildUpdate({ draftId: "d1" });
  assertEquals(plan.body, "kept");
  const [a, b] = [readRaw(raw), readRaw(plan.message.raw)];
  for (const k of ["to", "cc", "bcc", "subject", "in-reply-to", "references"]) {
    assertEquals(b.headers[k], a.headers[k], k);
  }
  assertEquals(plan.message.threadId, "t1");
  assertEquals(textOf(b, "text/plain"), textOf(a, "text/plain"), "text part identical");
  assertEquals(textOf(b, "text/html"), textOf(a, "text/html"), "HTML part identical");
  assertEquals(shape(b), shape(a));
  assertEquals(plan.kept.sha256, await fileHashes(raw));
  assertEquals(
    await fileHashes(plan.message.raw),
    await fileHashes(raw),
    "every file byte-identical",
  );
  assertEquals([plan.kept.count, plan.added, plan.removed, plan.quoted], [2, 0, 0, true]);
  assertEquals(fake.writes().length, 1, "buildUpdate writes nothing");
});

Deno.test("updateDraft text change: new text, quote regenerated from the thread, files kept", async () => {
  const { fake, guard, raw } = await replyDraft();
  const before = await fileHashes(raw);
  const r = await guard.updateDraft({ draftId: "d1", text: "Second version." });
  assertEquals([r.body, r.quoted, r.draft.id, r.previousMessageId], [
    "rebuilt",
    true,
    "d1",
    "m-d1-1",
  ]);
  assertEquals(r.draft.message.id, "m-d1-2", "same draft, new message id");
  const now = fake.drafts.get("d1")!.message.raw!;
  const t = textOf(readRaw(now), "text/plain")!;
  assert(t.startsWith("Second version.\n\nOn Tue, 10 Nov 2026"), t);
  assert(!t.includes("First version."), "old text replaced, not kept above the new");
  assertEquals(t.split("> Please send the quote.").length, 2, "one quote, not two");
  assertEquals(await fileHashes(now), before, "sha256 of every kept file equal before and after");
  const m = readRaw(now);
  assertEquals(m.headers["in-reply-to"], "<m2@away.test>");
  assertEquals(m.headers["references"], "<m1@away.test> <m2@away.test>");
  assertEquals(m.headers["bcc"], "hidden@away.test");
  assertEquals(fake.drafts.get("d1")!.message.threadId, "t1");
  const put = fake.writes().at(-1)!;
  assertEquals([put.method, put.path], ["PUT", "/drafts/d1"]);
});

Deno.test("updateDraft: quote:false, and no quote when the original is not in the thread", async () => {
  const { writer } = await replyDraft();
  const p = await writer.buildUpdate({ draftId: "d1", text: "x", quote: false });
  assertEquals([p.quoted, shape(readRaw(p.message.raw)).startsWith("multipart/mixed[text/plain")], [
    false,
    true,
  ]);

  const fake = new FakeGmail([ORIGINAL]);
  fake.seedDraft("d9", {
    id: "m-d9-1",
    threadId: "t1",
    headers: { "To": "a@away.test", "Subject": "Re: ?", "In-Reply-To": "<gone@away.test>" },
    text: "old",
  });
  const lost = await fake.writers().writer.buildUpdate({ draftId: "d9", text: "new" });
  assertEquals(lost.quoted, false, "never guess an original");
  assertEquals(textOf(readRaw(lost.message.raw), "text/plain"), "new");
});

Deno.test("updateDraft: add and remove files; removing an unknown name writes nothing", async () => {
  const { fake, writer, raw } = await replyDraft();
  const [hashA] = await fileHashes(raw);
  const p = await writer.buildUpdate({
    draftId: "d1",
    removeAttachments: ["b.xlsx"],
    addAttachments: [{ filename: "c.txt", content: bytes(99) }],
  });
  const names = leaves(readRaw(p.message.raw))
    .filter((l) => l.headers["content-disposition"]?.startsWith("attachment"))
    .map((l) => /filename="([^"]+)"/.exec(l.headers["content-disposition"])![1]);
  assertEquals(names, ["a.pdf", "c.txt"]);
  assertEquals(p.kept.sha256, [hashA]);
  assertEquals([p.kept.count, p.added, p.removed], [1, 1, 1]);

  let err: unknown;
  try {
    await writer.buildUpdate({ draftId: "d1", removeAttachments: ["nope.doc"] });
  } catch (e) {
    err = e;
  }
  assert(err instanceof TypeError && err.message.includes("nope.doc"));
  assertEquals(fake.writes().length, 1, "only the original create");
});

Deno.test("updateDraft refuses drafts with inline images, and unreadable files; nothing written", async () => {
  const fake = new FakeGmail([ORIGINAL]);
  fake.seedDraft("d7", {
    id: "m-d7-1",
    threadId: "t1",
    headers: { "To": "a@away.test", "Subject": "S" },
    html: '<p>see <img src="cid:img0@fake"></p>',
    files: [{ filename: "shot.png", mimeType: "image/png", bytes: bytes(1, 2), inline: true }],
  });
  const { guard } = fake.writers();
  let err: unknown;
  try {
    await guard.updateDraft({ draftId: "d7", text: "edit" });
  } catch (e) {
    err = e;
  }
  assert(err instanceof DraftNotEditableError && err.reason === "inline_parts", String(err));
  assertEquals(err.draftId, "d7");

  const { fake: f2, guard: g2 } = await replyDraft();
  f2.failDownloads = true;
  let err2: unknown;
  try {
    await g2.updateDraft({ draftId: "d1", text: "edit" });
  } catch (e) {
    err2 = e;
  }
  assert(err2 instanceof DraftNotEditableError && err2.reason === "download_failed", String(err2));
  assertEquals(fake.writes().length + f2.writes().length, 1, "no PUT in either case");
});

Deno.test("updateDraft refuses a draft edited elsewhere: expectMessageId, and the re-read before the write", async () => {
  const { fake, writer } = await replyDraft();
  let err: unknown;
  try {
    await writer.buildUpdate({ draftId: "d1", text: "x", expectMessageId: "m-stale" });
  } catch (e) {
    err = e;
  }
  assert(err instanceof DraftChangedError);
  assertEquals([err.expected, err.actual], ["m-stale", "m-d1-1"]);

  const plan = await writer.buildUpdate({ draftId: "d1", text: "x", expectMessageId: "m-d1-1" });
  fake.touchDraft("d1"); // someone edits it in Gmail between our read and our write
  let err2: unknown;
  try {
    await writer.putDraft(plan);
  } catch (e) {
    err2 = e;
  }
  assert(err2 instanceof DraftChangedError, String(err2));
  assertEquals(fake.writes().filter((w) => w.method === "PUT").length, 0);
});

Deno.test("guard updateDraft: result and a log line with counts and sha256 only", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const log = `${dir}/writes.log`;
    const fake = new FakeGmail([ORIGINAL]);
    const { writer, guard } = fake.writers(log);
    await writer.createDraft({ replyToMessageId: "orig", text: "v1", attachments: [FILE_A] });
    const r = await guard.updateDraft({ draftId: "d1", text: "v2", cc: ["new@away.test"] });
    assertEquals(r.sent, false);
    assertEquals(r.recipients.cc, ["new@away.test"], "a given cc replaces the old one whole");
    const text = await Deno.readTextFile(log);
    const line = JSON.parse(text.trim().split("\n").at(-1)!);
    assertEquals(line.op, "draft.update");
    assertEquals(line.recipients, { to: 1, cc: 1, bcc: 0 });
    assertEquals(line.kept.sha256, [await sha256Hex(FILE_A.content)]);
    assertEquals([line.previousMessageId, line.messageId], ["m-d1-1", "m-d1-2"]);
    for (const leak of ["away.test", "a.pdf", "Quote"]) assert(!text.includes(leak), leak);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("one composer: create, update and forward give identical bodies for identical input", async () => {
  const fake = new FakeGmail([ORIGINAL]);
  fake.sendAs = [{ sendAsEmail: OWNER, isDefault: true, signature: "<b>Sig</b>" }];
  const { writer } = fake.writers();
  const created = await writer.buildDraft({
    to: ["x@away.test"],
    subject: "S",
    text: "Body",
    signature: true,
  });
  await writer.createDraft({ to: ["x@away.test"], subject: "S", text: "old" });
  const updated = await writer.buildUpdate({ draftId: "d1", text: "Body", signature: true });
  const want = composeBody({ text: "Body", signature: signatureBlock("<b>Sig</b>") });
  for (const p of [created, updated]) {
    const m = readRaw(p.message.raw);
    assertEquals([textOf(m, "text/plain"), textOf(m, "text/html")], [want.text, want.html]);
  }
  const fwd = await writer.buildForward({
    messageId: "orig",
    to: ["x@away.test"],
    text: "Body",
    signature: true,
  });
  const fm = readRaw(fwd.message.raw);
  const wantF = composeBody({
    text: "Body",
    signature: signatureBlock("<b>Sig</b>"),
    tail: forwardBlock({
      from: ORIGINAL.headers["From"],
      date: ORIGINAL.headers["Date"],
      subject: ORIGINAL.headers["Subject"],
      to: ORIGINAL.headers["To"],
      text: ORIGINAL.text!,
    }),
  });
  assertEquals([textOf(fm, "text/plain"), textOf(fm, "text/html")], [wantF.text, wantF.html]);
});
