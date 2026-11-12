/**
 * Offline tests for drafting: threaded replies, HTML bodies, quoted history, reply-all, signatures,
 * listing, forwarding and updating drafts. Synthetic mailbox only.
 */
import { assert, assertEquals } from "@std/assert";
import { buildRawMessage } from "../mod.ts";
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
  await noReplyTo.writers().writer.createDraft({ replyToMessageId: "orig", text: "x" });
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
