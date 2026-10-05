import { assertEquals, assertThrows } from "@std/assert";
import { choiceScheme } from "../../lib/organise/choice.ts";
import type { OrganiseMessage } from "../../lib/organise/message.ts";
import { Relationships } from "../../lib/organise/relationships.ts";
import { ProfileError } from "../../lib/organise/scheme.ts";

const QUESTION = {
  id: "topic",
  instructions: "Which topic is this message about?",
  options: { garden: "The garden", house: "The house", none: "Neither" },
};
const ctx = { now: 0, relationships: new Relationships({ correspondents: [] }) };

const msg = (from: string, originalSender = ""): OrganiseMessage => ({
  id: "m",
  threadId: "t",
  internalDate: String(Date.UTC(2022, 2, 1)),
  state: {
    from,
    to: "",
    subject: "s",
    date: "",
    is_reply: false,
    has_list_unsubscribe: false,
    body: "",
  },
  envelope: {
    from,
    returnPath: "",
    sender: "",
    originalSender,
    listUnsubscribe: "",
    listId: "",
    listPost: "",
    precedence: "",
    autoSubmitted: "",
  },
});

const scheme = (senders = {}) =>
  choiceScheme({
    id: "topic",
    question: QUESTION,
    labelPattern: "topic/{year}/{category}",
    unlabelled: ["none"],
    senders,
  });

Deno.test("choice: categories and the one question, in file order", () => {
  const s = scheme();
  assertEquals([...s.categories], ["garden", "house", "none"]);
  assertEquals(s.questions, {
    topic: { type: "choice", instructions: QUESTION.instructions, criteria: QUESTION.options },
  });
  assertEquals([s.kind, s.labelPrefix], ["choice", "topic/"]);
});

Deno.test("choice: confidence is reported, never a gate", () => {
  const d = scheme().decide(msg("a@x.test"), {
    topic: { type: "choice", choice: "house", confidence: 0.12 },
  }, ctx);
  assertEquals([d.category, d.route, d.why], ["house", "choice", "chose house (confidence 0.12)"]);
  const bare = scheme().decide(
    msg("a@x.test"),
    { topic: { type: "choice", choice: "house" } },
    ctx,
  );
  assertEquals(bare.why, "chose house");
});

Deno.test("choice: a ruling reads the true author and outranks the answer", () => {
  const s = scheme({ garden: { "Author@Group.test": "always the garden" } });
  const answers = { topic: { type: "choice" as const, choice: "house", confidence: 0.99 } };
  const viaGroup = s.decide(msg("Group <list@group.test>", "author@group.test"), answers, ctx);
  assertEquals([viaGroup.category, viaGroup.route, viaGroup.sender], [
    "garden",
    "policy",
    "author@group.test",
  ]);
});

Deno.test("choice: unanswered or off-list goes to the first unlabelled category", () => {
  assertEquals(scheme().decide(msg("a@x.test"), {}, ctx).why, "unanswered");
  const odd = scheme().decide(msg("a@x.test"), { topic: { type: "choice", choice: "car" } }, ctx);
  assertEquals([odd.category, odd.route, odd.why], [
    "none",
    "incomplete",
    `"car" is not an option`,
  ]);
});

Deno.test("choice: labels by year, none for an unlabelled category", () => {
  assertEquals(scheme().label("garden", String(Date.UTC(2022, 2, 1))), "topic/2022/garden");
  assertEquals(scheme().label("none", "0"), undefined);
});

Deno.test("choice: refusals are ProfileErrors", () => {
  const make = (o: Partial<Parameters<typeof choiceScheme>[0]>) => () =>
    choiceScheme({
      id: "topic",
      question: QUESTION,
      labelPattern: "topic/{category}",
      unlabelled: ["none"],
      ...o,
    });
  assertThrows(make({ unlabelled: [] }), ProfileError, "unlabelled");
  assertThrows(make({ unlabelled: ["other"] }), ProfileError, "not an option");
  assertThrows(make({ question: { ...QUESTION, options: {} } }), ProfileError, "no options");
  assertThrows(make({ labelPattern: "topic" }), ProfileError);
  assertThrows(make({ senders: { car: { "a@x.test": "n" } } }), ProfileError, "unknown category");
  assertThrows(
    make({ senders: { garden: { "a@x.test": "n" }, house: { "A@X.test": "n" } } }),
    ProfileError,
    "ruled both",
  );
  make({ senders: { _comment: { note: "ignored" } } })();
});
