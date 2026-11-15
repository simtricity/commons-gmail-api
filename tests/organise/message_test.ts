import { assertEquals } from "@std/assert";
import type { Message } from "../../mod.ts";
import { toOrganiseMessage } from "../../lib/organise/message.ts";
import { gmailMessage, RECEIVED } from "./fixtures.ts";

const fixture = (id: string) => gmailMessage(RECEIVED.find((m) => m.id === id)!) as Message;

Deno.test("toOrganiseMessage: state from the body, envelope from the headers", () => {
  const m = toOrganiseMessage(fixture("r12"));
  assertEquals([m.id, m.threadId], ["r12", "t-r12"]);
  assertEquals(m.internalDate, String(Date.parse("2020-11-11T11:00:00Z")));
  assertEquals(m.state.subject, "[forum] Thread about inverters");
  assertEquals(m.state.body, "Body of [forum] Thread about inverters.");
  assertEquals(m.envelope.listPost, "<mailto:list@forum.test>");
  assertEquals(m.envelope.autoSubmitted, "", "an absent header is empty");
  assertEquals(m.labelIds, ["INBOX", "UNREAD", "CATEGORY_UPDATES"]);
});

Deno.test("toOrganiseMessage: bodyChars caps what the model is shown", () => {
  assertEquals(toOrganiseMessage(fixture("r1"), 4).state.body.startsWith("Body\n…"), true);
});
