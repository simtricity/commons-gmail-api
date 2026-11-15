import { assertEquals } from "@std/assert";
import { isSharedProvider, Relationships } from "../../lib/organise/relationships.ts";
import type { Correspondent } from "../../lib/organise/types.ts";

function person(
  address: string,
  genuine: number,
  firstSeen: string,
  lastSeen: string,
): Correspondent {
  return {
    address,
    domain: address.split("@")[1],
    kind: "person",
    genuine,
    incidental: 0,
    firstSeen,
    lastSeen,
  };
}

const rel = new Relationships({
  selfAddresses: ["me@home.test"],
  correspondents: [
    person("jo@partner.test", 40, "2019-01-01T00:00:00Z", "2024-01-01T00:00:00Z"),
    // Many messages, all in one week: a burst, not a relationship.
    person("sam@partner.test", 12, "2020-03-01T00:00:00Z", "2020-03-06T00:00:00Z"),
    person("once@elsewhere.test", 1, "2021-05-05T00:00:00Z", "2021-05-05T00:00:00Z"),
    {
      ...person("list@lists.test", 90, "2015-01-01T00:00:00Z", "2025-01-01T00:00:00Z"),
      kind: "list",
    },
  ],
});

Deno.test("sustained genuine correspondence is strong", () => {
  assertEquals(rel.strength("Jo@Partner.test"), "strong");
});

Deno.test("volume alone is not strong; it has to span time", () => {
  assertEquals(rel.strength("sam@partner.test"), "known");
});

Deno.test("one genuine message makes a sender known, and none makes them nobody", () => {
  assertEquals(rel.strength("once@elsewhere.test"), "known");
  assertEquals(rel.strength("stranger@nowhere.test"), "none");
});

Deno.test("a mailing list is never a relationship", () => {
  assertEquals(rel.strength("list@lists.test"), "none");
  assertEquals(rel.trustedDomain("lists.test"), false);
});

Deno.test("a domain is trusted after enough mail to enough of its people", () => {
  assertEquals(rel.trustedDomain("partner.test"), true);
  assertEquals(rel.trustedDomain("elsewhere.test"), false);
});

Deno.test("a public mailbox provider never passes trust between its users", () => {
  const webmail = new Relationships({
    correspondents: [
      person("friend.one@yahoo.test", 30, "2018-01-01T00:00:00Z", "2024-01-01T00:00:00Z"),
      person("friend.two@yahoo.test", 30, "2018-01-01T00:00:00Z", "2024-01-01T00:00:00Z"),
    ],
  });
  assertEquals(webmail.trustedDomain("yahoo.test"), false);
  // Each friend is still known in their own right.
  assertEquals(webmail.strength("friend.one@yahoo.test"), "strong");
  assertEquals(isSharedProvider("gmail.com"), true);
  assertEquals(isSharedProvider("partner.test"), false);
});

Deno.test("the operator's own domains are recognised", () => {
  assertEquals(rel.isSelfDomain("home.test"), true);
  assertEquals(rel.isSelfDomain("partner.test"), false);
});
