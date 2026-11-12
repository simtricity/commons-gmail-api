/**
 * Offline tests for drafting: threaded replies, HTML bodies, quoted history, reply-all, signatures,
 * listing, forwarding and updating drafts. Synthetic mailbox only.
 */
import { assertEquals } from "@std/assert";
import { FakeGmail, type FixtureMessage } from "./replies-fake.ts";
import { leaves, readRaw, shape } from "./mime-read.ts";

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
