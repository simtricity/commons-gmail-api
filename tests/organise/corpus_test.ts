import { assertEquals } from "@std/assert";
import type { Message } from "../../mod.ts";
import {
  classifySend,
  CorpusBuilder,
  domainsOf,
  listsOf,
  lookups,
  selfAddressesFrom,
} from "../../lib/organise/corpus.ts";
import {
  addressesIn,
  addressOf,
  domainOf,
  isAutoReply,
  isListMail,
  senderOf,
} from "../../lib/organise/mail.ts";

/** Synthetic message. No real addresses appear in these fixtures. */
function msg(headers: Record<string, string>, when = "1767225600000"): Message {
  return {
    id: crypto.randomUUID(),
    threadId: "t",
    internalDate: when,
    payload: { headers: Object.entries(headers).map(([name, value]) => ({ name, value })) },
  };
}

Deno.test("address and domain extraction", () => {
  assertEquals(addressOf("Jo Bloggs <Jo@Example.COM>"), "jo@example.com");
  assertEquals(addressOf("bare@example.org"), "bare@example.org");
  assertEquals(domainOf("Jo <jo@mail.example.com>"), "mail.example.com");
  assertEquals(addressesIn("a@x.example, B@Y.test <b@y.test>"), [
    "a@x.example",
    "b@y.test",
    "b@y.test",
  ]);
});

Deno.test("auto-replies are detected by subject", () => {
  for (
    const s of [
      "Out of office",
      "Re: Out of Office",
      "Automatic reply: your enquiry",
      "Auto-Reply: away",
      "Undeliverable: message",
    ]
  ) {
    assertEquals(isAutoReply(msg({ Subject: s })), true, s);
  }
  assertEquals(isAutoReply(msg({ Subject: "Out of scope for this sprint" })), false);
  assertEquals(isAutoReply(msg({ Subject: "Quarterly review" })), false);
});

Deno.test("auto-replies are detected by header", () => {
  assertEquals(isAutoReply(msg({ Subject: "x", "Auto-Submitted": "auto-replied" })), true);
  assertEquals(isAutoReply(msg({ Subject: "x", "X-Autoreply": "yes" })), true);
  assertEquals(isAutoReply(msg({ Subject: "x", Precedence: "bulk" })), true);
  assertEquals(isAutoReply(msg({ Subject: "x", "Auto-Submitted": "no" })), false);
});

Deno.test("List-Post separates discussion lists from broadcast newsletters", () => {
  // A newsletter: unsubscribe only.
  assertEquals(isListMail(msg({ "List-Unsubscribe": "<mailto:x@y.example>" })), false);
  // A list you can post into.
  assertEquals(
    isListMail(msg({ "List-Id": "<l.example.org>", "List-Post": "<mailto:l@x>" })),
    true,
  );
});

Deno.test("classifySend prefers auto-reply over list-post", () => {
  assertEquals(classifySend(msg({ Subject: "Hello" })), "genuine");
  assertEquals(classifySend(msg({ Subject: "Out of office", "List-Id": "<l>" })), "auto-reply");
  assertEquals(classifySend(msg({ Subject: "Hello", "List-Id": "<l>" })), "list-post");
});

Deno.test("a sent copy carries no List-* headers, so the address decides", () => {
  // Exactly the header set observed on real outgoing list mail.
  const sent = msg({
    Subject: "Re: [board] the quarterly numbers",
    To: "board@lists.example",
    "In-Reply-To": "<abc@lists.example>",
    References: "<abc@lists.example>",
  });
  // Header inspection alone cannot tell: it looks like ordinary correspondence.
  assertEquals(classifySend(sent), "genuine");
  // Knowing the posting address settles it.
  assertEquals(classifySend(sent, new Set(["board@lists.example"])), "list-post");
});

Deno.test("a known list address is not counted as a person", () => {
  const listAddresses = new Set(["board@lists.example"]);
  const b = new CorpusBuilder({ listAddresses });
  b.add(msg({ Subject: "Quarterly numbers", To: "board@lists.example" }));
  b.add(msg({ Subject: "Contract", To: "jo@partner.example" }));

  const corpus = b.finish("in:sent");
  assertEquals(corpus.listPosts, 1);
  assertEquals(listsOf(corpus).map((c) => c.address), ["board@lists.example"]);
  // The whitelist must contain people only, never a list.
  assertEquals([...lookups(corpus).addresses], ["jo@partner.example"]);
  // A list host must not appear as a domain you correspond with.
  assertEquals(domainsOf(corpus).map((d) => d.domain), ["partner.example"]);
});

Deno.test("the operator's own addresses are never correspondents", () => {
  const b = new CorpusBuilder({ selfAddresses: new Set(["me@mine.example"]) });
  b.add(msg({ Subject: "Fwd: receipt", To: "me@mine.example" }));
  b.add(msg({ Subject: "Hello", To: "jo@partner.example", Cc: "me@mine.example" }));

  const corpus = b.finish("in:sent");
  assertEquals(corpus.correspondents.map((c) => c.address), ["jo@partner.example"]);
  assertEquals(corpus.selfAddresses, ["me@mine.example"]);
});

Deno.test("an auto-reply never creates a genuine correspondent", () => {
  const b = new CorpusBuilder();
  b.add(msg({ Subject: "Hello there", To: "real@partner.example" }));
  b.add(msg({ Subject: "Out of office", To: "newsletter@bounce.example.com" }));

  const corpus = b.finish("in:sent");
  assertEquals(corpus.scanned, 2);
  assertEquals(corpus.autoReplies, 1);
  assertEquals(corpus.correspondents.map((c) => c.address), ["real@partner.example"]);
  assertEquals(corpus.correspondents[0].kind, "person");
  assertEquals(b.incidentalOnly(), ["newsletter@bounce.example.com"]);
});

Deno.test("a contact reached both ways keeps its genuine count", () => {
  const b = new CorpusBuilder();
  b.add(msg({ Subject: "Contract draft", To: "jo@partner.example" }));
  b.add(msg({ Subject: "Out of office", To: "jo@partner.example" }));

  const c = b.finish("in:sent").correspondents[0];
  assertEquals(c.genuine, 1);
  assertEquals(c.incidental, 1);
});

Deno.test("recipients are counted once per message even if repeated", () => {
  const b = new CorpusBuilder();
  b.add(msg({ Subject: "Hi", To: "jo@partner.example", Cc: "Jo <jo@partner.example>" }));
  assertEquals(b.finish("in:sent").correspondents[0].genuine, 1);
});

Deno.test("minGenuine drops one-off contacts", () => {
  const b = new CorpusBuilder();
  b.add(msg({ Subject: "a", To: "often@partner.example" }));
  b.add(msg({ Subject: "b", To: "often@partner.example" }));
  b.add(msg({ Subject: "c", To: "once@other.example" }));

  assertEquals(b.finish("q", 1).correspondents.length, 2);
  assertEquals(b.finish("q", 2).correspondents.map((c) => c.address), ["often@partner.example"]);
});

Deno.test("domain rollup aggregates people and messages", () => {
  const b = new CorpusBuilder();
  b.add(msg({ Subject: "a", To: "one@partner.example" }));
  b.add(msg({ Subject: "b", To: "two@partner.example" }));
  b.add(msg({ Subject: "c", To: "two@partner.example" }));
  b.add(msg({ Subject: "d", To: "solo@other.test" }));

  const domains = domainsOf(b.finish("q"));
  assertEquals(domains[0], { domain: "partner.example", people: 2, messages: 3 });
  assertEquals(domains[1], { domain: "other.test", people: 1, messages: 1 });
});

Deno.test("lookups give O(1) whitelist membership", () => {
  const b = new CorpusBuilder();
  b.add(msg({ Subject: "a", To: "jo@partner.example" }));
  const { addresses, domains } = lookups(b.finish("q"));
  assertEquals(addresses.has("jo@partner.example"), true);
  assertEquals(domains.has("partner.example"), true);
  assertEquals(addresses.has("someone@partner.example"), false);
});

Deno.test("first and last seen span the messages", () => {
  const b = new CorpusBuilder();
  b.add(msg({ Subject: "a", To: "jo@partner.example" }, "1000000000000"));
  b.add(msg({ Subject: "b", To: "jo@partner.example" }, "2000000000000"));
  const c = b.finish("q").correspondents[0];
  assertEquals(c.firstSeen, new Date(1000000000000).toISOString());
  assertEquals(c.lastSeen, new Date(2000000000000).toISOString());
});

Deno.test("senderOf reads the mailbox, never the display name", () => {
  assertEquals(senderOf("Jo Bloggs <Jo@Example.COM>"), "jo@example.com");
  assertEquals(senderOf("bare@example.org"), "bare@example.org");
  assertEquals(senderOf(""), "");
  assertEquals(senderOf(undefined), "");
});

Deno.test("an address inside the display name is not the sender", () => {
  // A mailing-list or group forward. The vendor address is free text; the
  // mailbox that actually sent it is in the angle brackets.
  assertEquals(
    senderOf("\"'no-reply@vendor.example' via redirect\" <real@sender.example>"),
    "real@sender.example",
  );
  // An address book that stringified a contact into the display name.
  assertEquals(
    senderOf('"jo jo@old.example" <jo@new.example>'),
    "jo@new.example",
  );
  // The degenerate case: the same address twice, which must not become two.
  assertEquals(senderOf('"jo@x.example" <jo@x.example>'), "jo@x.example");
});

Deno.test("a repeated sender is an alias, a one-off is not", () => {
  const senders = [
    "Op <op@one.example>",
    "Op <op@one.example>",
    "Op <op@two.example>",
    "Op <op@two.example>",
    "Op <op@two.example>",
    // Sent from someone else's machine, or imported from another provider.
    '"op op@one.example" <someone@else.example>',
  ];
  const self = selfAddressesFrom(senders);
  assertEquals([...self].sort(), ["op@one.example", "op@two.example"]);
  assertEquals(self.has("someone@else.example"), false);
});

Deno.test("the account's own address is self however rarely it sends", () => {
  const self = selfAddressesFrom(["Op <rare@mine.example>"], {
    profile: "Rare@Mine.Example",
  });
  assertEquals([...self], ["rare@mine.example"]);
});

Deno.test("minSends is adjustable, and 1 trusts every sighting", () => {
  const senders = ["a <a@x.example>", "b <b@x.example>", "b <b@x.example>"];
  assertEquals([...selfAddressesFrom(senders, { minSends: 1 })].sort(), [
    "a@x.example",
    "b@x.example",
  ]);
  assertEquals([...selfAddressesFrom(senders, { minSends: 3 })], []);
});

Deno.test("a correspondent is not excluded by a display name that names the operator", () => {
  // The regression this guards: reading every address in From promoted the
  // display name to a sender, and the real correspondent was dropped as self.
  const self = selfAddressesFrom([
    '"op op@mine.example" <colleague@partner.example>',
  ], { profile: "op@mine.example" });

  const b = new CorpusBuilder({ selfAddresses: self });
  b.add(msg({ Subject: "Proposal", To: "colleague@partner.example" }));

  const corpus = b.finish("in:sent");
  assertEquals(corpus.correspondents.map((c) => c.address), ["colleague@partner.example"]);
});
