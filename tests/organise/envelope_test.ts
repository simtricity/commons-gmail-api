import { assertEquals } from "@std/assert";
import {
  type Envelope,
  envelopeOf,
  headerLookup,
  isAutoReplied,
  isCalendarNotice,
  isCampaign,
  isDiscussionList,
  senderIdentity,
  sentViaPlatform,
} from "../../lib/organise/envelope.ts";

const env = (over: Partial<Envelope> = {}): Envelope => ({
  ...envelopeOf(() => undefined),
  from: "Jo <jo@partner.test>",
  ...over,
});

Deno.test("envelopeOf reads each delivery header and blanks the absent ones", () => {
  const e = envelopeOf(headerLookup({ from: "a@x.test", "LIST-POST": "<mailto:l@x.test>" }));
  assertEquals(e.from, "a@x.test");
  assertEquals(e.listPost, "<mailto:l@x.test>");
  assertEquals(e.returnPath, "");
});

Deno.test("a VERP return path on another domain is a mailing platform", () => {
  assertEquals(
    sentViaPlatform(env({ returnPath: "<782-4823-me=example.test@bounce.platform.test>" })),
    true,
  );
});

Deno.test("an ordinary bounce address is not VERP, and neither is your own domain's", () => {
  assertEquals(sentViaPlatform(env({ returnPath: "<bounce@mail.platform.test>" })), false);
  assertEquals(sentViaPlatform(env({ returnPath: "<jo=x@partner.test>" })), false);
  assertEquals(sentViaPlatform(env({ returnPath: "" })), false);
});

Deno.test("a campaign is an unsubscribe link or a platform envelope", () => {
  assertEquals(isCampaign(env({ listUnsubscribe: "<mailto:u@x.test>" })), true);
  assertEquals(isCampaign(env()), false);
  assertEquals(isCampaign(undefined), false);
});

Deno.test("a discussion list carries List-Post, or bounces to its owner", () => {
  assertEquals(isDiscussionList(env({ listPost: "<mailto:wg@lists.test>" })), true);
  assertEquals(isDiscussionList(env({ returnPath: "<owner-wg@listserv.lists.test>" })), true);
  // A newsletter has an unsubscribe link and no way back in.
  assertEquals(isDiscussionList(env({ listUnsubscribe: "<mailto:u@news.test>" })), false);
  assertEquals(isDiscussionList(env({ returnPath: "<bounce-owner@news.test>" })), false);
});

Deno.test("a Google Group post is attributed to its author, not the group", () => {
  const e = env({ from: "'Jo' via Group <group@groups.test>", originalSender: "jo@partner.test" });
  assertEquals(senderIdentity(e), "jo@partner.test");
  assertEquals(senderIdentity(env()), "jo@partner.test");
});

Deno.test("sender identity ignores addresses inside a display name", () => {
  assertEquals(senderIdentity(env({ from: `"no-reply@vendor.test" <real@sender.test>` })), "real@sender.test");
});

Deno.test("only auto-replied is an auto-reply; auto-generated is ordinary machine mail", () => {
  assertEquals(isAutoReplied("Status", env({ autoSubmitted: "auto-replied" })), true);
  assertEquals(isAutoReplied("Alert: disk full", env({ autoSubmitted: "auto-generated" })), false);
  assertEquals(isAutoReplied("Automatic reply: Lunch?", env()), true);
  assertEquals(isAutoReplied("Out of office until Monday", undefined), true);
});

Deno.test("iCalendar method subjects are calendar notices from anyone", () => {
  assertEquals(isCalendarNotice("jo@partner.test", "Accepted: Site meeting"), true);
  assertEquals(isCalendarNotice("jo@partner.test", "Declined: Site meeting"), true);
});

Deno.test("an ambiguous subject is a calendar notice only from the calendar", () => {
  assertEquals(isCalendarNotice("calendar-notification@google.com", "Notification: Bid deadline"), true);
  assertEquals(isCalendarNotice("jo@partner.test", "Notification: your order shipped"), false);
});
