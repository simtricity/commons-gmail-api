import { assertEquals, assertThrows } from "@std/assert";
import { parseProfile } from "../../lib/organise/profile.ts";
import { questionsFor } from "../../lib/organise/questions.ts";
import { ProfileError } from "../../lib/organise/scheme.ts";
import { TRIAGE_DEFAULT_QUESTIONS } from "../../lib/organise/triage/questions.ts";

const TOPIC = {
  kind: "choice",
  question: {
    id: "topic",
    instructions: "Which topic?",
    options: { garden: "Garden", none: "Neither" },
  },
  labels: { pattern: "topic/{category}" },
  unlabelled: ["none"],
};

Deno.test("profile: an absent schemes key is generic triage, with every default", () => {
  const p = parseProfile({});
  assertEquals([p.model, p.bodyChars, p.corpus, p.context, p.pricePerMTok], [
    "jev-latest",
    2000,
    "derived/corpus.json",
    undefined,
    undefined,
  ]);
  assertEquals(p.schemes.map((s) => [s.id, s.kind, s.labelPattern]), [
    ["triage", "triage", "organiser/{year}/{verdict}"],
  ]);
  assertEquals(p.schemes[0].questions, TRIAGE_DEFAULT_QUESTIONS);
});

Deno.test("profile: an explicit empty schemes is a mistake, not a default", () => {
  assertThrows(() => parseProfile({ schemes: {} }), ProfileError, "at least one scheme");
});

Deno.test("profile: schemes keep file order and their own options", () => {
  const p = parseProfile({
    model: "jev-1",
    bodyChars: 500,
    context: { about_me: "A synthetic account holder." },
    pricePerMTok: 0.05,
    schemes: {
      topic: TOPIC,
      triage: { kind: "triage", labels: { pattern: "triage/{year}/{verdict}" } },
    },
  }, { triage: { delete: { "noise@x.test": "noise" } } });
  assertEquals(p.schemes.map((s) => [s.id, s.labelPrefix]), [["topic", "topic/"], [
    "triage",
    "triage/",
  ]]);
  assertEquals([p.model, p.bodyChars, p.pricePerMTok], ["jev-1", 500, 0.05]);
});

Deno.test("profile: refusals are ProfileErrors", () => {
  const refuse = (raw: unknown, msg?: string, senders = {}) =>
    assertThrows(() => parseProfile(raw, senders), ProfileError, msg);
  refuse(null, "object");
  refuse([], "object");
  refuse({ schemes: { x: { kind: "regex" } } }, "unknown kind");
  refuse({ schemes: { x: "triage" } }, "must be an object");
  refuse({ schemes: { a: { kind: "triage" }, b: { kind: "triage" } } }, "share label space");
  refuse({
    schemes: {
      triage: { kind: "triage" },
      sub: { ...TOPIC, labels: { pattern: "organiser/sub/{category}" } },
    },
  }, "share label space");
  refuse({ schemes: { topic: { ...TOPIC, labels: undefined } } }, "labels.pattern");
  refuse({ schemes: { topic: { ...TOPIC, unlabelled: undefined } } }, "unlabelled");
  refuse({ schemes: { topic: { ...TOPIC, question: { id: "t" } } } }, "question");
  refuse({ bodyChars: 0 }, "bodyChars");
  refuse({ bodyChars: 1.5 }, "bodyChars");
  refuse({ pricePerMTok: -1 }, "pricePerMTok");
  refuse({ context: "about me" }, "context");
  refuse({}, "unknown scheme", { nosuch: {} });
  refuse({}, undefined, { triage: { archive: { "a@x.test": "n" } } });
});

Deno.test("questionsFor: one call's questions; one id defined two ways is refused", () => {
  const p = parseProfile({ schemes: { triage: { kind: "triage" }, topic: TOPIC } });
  assertEquals(Object.keys(questionsFor(p.schemes)).length, 9);
  const clash = { ...TOPIC, question: { ...TOPIC.question, id: "is_personal" } };
  assertThrows(
    () => parseProfile({ schemes: { triage: { kind: "triage" }, topic: clash } }),
    ProfileError,
    "is_personal",
  );
  const same = { kind: "triage", labels: { pattern: "other/{verdict}" } };
  assertEquals(
    Object.keys(questionsFor(parseProfile({ schemes: { a: { kind: "triage" }, b: same } }).schemes))
      .length,
    8,
    "identical definitions merge",
  );
});
