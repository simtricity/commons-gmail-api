import { assertEquals, assertMatch, assertNotEquals, assertThrows } from "@std/assert";
import { parseProfile } from "../../lib/organise/profile.ts";
import { pendingQuestions, questionHash, questionsFor } from "../../lib/organise/questions.ts";
import { ProfileError } from "../../lib/organise/scheme.ts";
import { TRIAGE_DEFAULT_QUESTIONS } from "../../lib/organise/triage/questions.ts";

/** The default wording's hashes at 2000 body characters and no context. A change here re-asks every
 * stored triage answer, so it must be deliberate. */
const PINNED_DEFAULT_HASHES: Record<string, string> = {
  "is_personal": "c7bba4373f6ade89",
  "is_a_record": "4cd377fbc61810aa",
  "is_perishable": "a4bfd4e9d9b88d56",
  "needs_personal_response": "f40d355f16826d58",
  "bulk_automated": "2faaada0503b0e5d",
  "record_lives_elsewhere": "7a12f5d12420b9bd",
  "carries_private_data": "c53d4aad68ec33d5",
  "concerns_my_operations": "b2132602d6b00a2f",
};

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

Deno.test("questionHash: 16 hex, key order ignored, context and body cap included", async () => {
  const q = { type: "noul" as const, instructions: { b: 1, a: 2 } };
  const shape = { context: { about_me: "x" }, bodyChars: 2000 };
  const h = await questionHash(q, shape);
  assertMatch(h, /^[0-9a-f]{16}$/);
  assertEquals(await questionHash({ type: "noul", instructions: { a: 2, b: 1 } }, shape), h);
  assertNotEquals(await questionHash(q, { ...shape, context: { about_me: "y" } }), h);
  assertNotEquals(await questionHash(q, { ...shape, bodyChars: 4000 }), h);
  assertNotEquals(await questionHash(q, { bodyChars: 2000 }), h, "no context differs from some");
});

Deno.test("questionHash: the default wording's hashes are pinned", async () => {
  const shape = { bodyChars: 2000 };
  const hashes = Object.fromEntries(
    await Promise.all(
      Object.entries(TRIAGE_DEFAULT_QUESTIONS).map(async (
        [id, q],
      ) => [id, await questionHash(q, shape)]),
    ),
  );
  assertEquals(hashes, PINNED_DEFAULT_HASHES);
});

Deno.test("pendingQuestions: unanswered, or asked under another hash", () => {
  const stored = {
    id: "m",
    answers: { a: { type: "noul" as const, noul: 0.1 } },
    asked: { a: "h1" },
  };
  assertEquals(pendingQuestions(undefined, { a: "h1" }), ["a"]);
  assertEquals(pendingQuestions(stored, { a: "h1" }), []);
  assertEquals(pendingQuestions(stored, { a: "h2" }), ["a"]);
  assertEquals(pendingQuestions(stored, { a: "h1", b: "h3" }), ["b"]);
  assertEquals(
    pendingQuestions({ ...stored, answers: {} }, { a: "h1" }),
    ["a"],
    "a hash without an answer",
  );
});
