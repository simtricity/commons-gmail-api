/**
 * The organise contract's unit tests, lifted verbatim from the contract test (G3).
 * Only the imports differ. The pipeline, scoped-writer and package-shape tests
 * arrive with the full contract install.
 *
 * @module
 */

import { assert, assertEquals, assertNotEquals, assertRejects, assertThrows } from "@std/assert";
import {
  choiceScheme,
  type GoldenCase,
  type OrganiseMessage,
  parseGolden,
  parseProfile,
  pendingQuestions,
  ProfileError,
  type ProfileFile,
  type Question,
  questionHash,
  questionsFor,
  relabelPlan,
  type SchemeDecision,
  score,
  senderOf,
  SystemOneError,
  SystemOneJudge,
  TRIAGE_DEFAULT_QUESTIONS,
  triageScheme,
  withRuling,
  withSenderRuling,
} from "../../../organise.ts";
import { FakeJev } from "./fakes.ts";
import { NOW, TRIAGE_IDS, TRIAGE_SENDERS } from "./fixtures.ts";

const KEY = "test-key";

const PROJECT_QUESTION = {
  id: "project",
  instructions: "Which project does this message concern?",
  options: { alpha: "Project Alpha", beta: "Project Beta", none: "Neither project" },
};

const PROFILE: ProfileFile = {
  model: "jev-latest",
  bodyChars: 2000,
  context: { about_me: "A synthetic mailbox owner." },
  schemes: {
    triage: { kind: "triage", labels: { pattern: "organiser/{year}/{verdict}" } },
    project: {
      kind: "choice",
      question: PROJECT_QUESTION,
      labels: { pattern: "project/{category}" },
      unlabelled: ["none"],
    },
  },
};

const GOLDEN: GoldenCase[] = [
  { id: "r3", expect: "important", never: ["delete"] },
  { id: "r1", expect: "delete" },
  { id: "r12", scheme: "triage", expect: ["defer", "delete"] },
  { id: "r2", scheme: "project", expect: "alpha" },
];

/** Drops keys whose value is undefined, so "absent" and "undefined" compare equal. */
const plain = <T>(x: T): T => JSON.parse(JSON.stringify(x));

// ── schemes and profile ─────────────────────────────────────────────────────

Deno.test("profile: refuses what would make labels or questions ambiguous", () => {
  const p = (schemes: unknown) => () => parseProfile({ schemes });
  const triage = { kind: "triage", labels: { pattern: "organiser/{year}/{verdict}" } };
  const choice = (pattern: string) => ({
    kind: "choice",
    question: PROJECT_QUESTION,
    labels: { pattern },
    unlabelled: ["none"],
  });

  assertThrows(
    p({ triage, project: choice("organiser/project/{category}") }),
    ProfileError,
    undefined,
    "nested prefixes",
  );
  assertThrows(p({ a: triage, b: { ...triage } }), ProfileError, undefined, "equal prefixes");
  assertThrows(p({ project: choice("project/fixed") }), ProfileError, undefined, "no category placeholder");
  assertThrows(p({ project: choice("{category}") }), ProfileError, undefined, "empty prefix");
  assertThrows(p({ x: { kind: "regex" } }), ProfileError, undefined, "unknown kind");
  assertThrows(
    p({
      triage,
      other: {
        kind: "choice",
        question: { ...PROJECT_QUESTION, id: "is_personal" },
        labels: { pattern: "other/{category}" },
        unlabelled: ["none"],
      },
    }),
    ProfileError,
    undefined,
    "one question id defined two ways",
  );
  assertThrows(
    () => parseProfile({ schemes: { triage } }, { triage: { archive: { "a@x.test": "n" } } }),
    ProfileError,
  );
  assertThrows(
    () =>
      parseProfile({ schemes: { triage } }, {
        triage: { delete: { "a@x.test": "n" }, keep: { "a@x.test": "n" } },
      }),
    ProfileError,
  );
  assertThrows(() => parseProfile({ schemes: { triage } }, { nosuch: {} }), ProfileError);

  const ok = parseProfile(PROFILE, { triage: TRIAGE_SENDERS });
  assertEquals(ok.model, "jev-latest");
  assertEquals(ok.bodyChars, 2000);
  assertEquals(ok.corpus, "derived/corpus.json");
  assertEquals(ok.schemes.map((s) => [s.id, s.kind, s.labelPrefix]), [
    ["triage", "triage", "organiser/"],
    ["project", "choice", "project/"],
  ]);
});

Deno.test("triage: defaults, labels by the message's own year, and the generic wording", () => {
  const s = triageScheme();
  assertEquals(s.id, "triage");
  assertEquals([...s.categories], ["delete", "defer", "keep", "important"]);
  assertEquals(s.unlabelled.length, 0);
  assertEquals(Object.keys(s.questions).sort(), [...TRIAGE_IDS].sort());
  assertEquals(s.questions, TRIAGE_DEFAULT_QUESTIONS);
  assertEquals(s.label("keep", String(Date.UTC(2020, 11, 31, 23, 30))), "organiser/2020/keep");
  assertEquals(s.label("keep", String(Date.UTC(2021, 0, 1, 0, 30))), "organiser/2021/keep");
  assertEquals(triageScheme({ labelPattern: "triage/{category}" }).label("defer", "0"), "triage/defer");
  assertThrows(() => triageScheme({ questions: { not_a_triage_id: { type: "noul", instructions: "x" } } }));

  for (const q of Object.values(TRIAGE_DEFAULT_QUESTIONS)) {
    assertEquals(q.type, "noul");
    assert(!/\b(he|him|his|she|her)\b/i.test(JSON.stringify(q.instructions)), "default wording names nobody");
  }
});

Deno.test("choice scheme: sender ruling, then the chosen option; never gated on confidence", () => {
  const s = choiceScheme({
    id: "project",
    question: PROJECT_QUESTION,
    labelPattern: "project/{category}",
    unlabelled: ["none"],
    senders: { beta: { "boss@vendor.test": "always beta" } },
  });
  const rel = { strength: () => "none", trustedDomain: () => false, isSelfDomain: () => false };
  // deno-lint-ignore no-explicit-any
  const ctx = { now: NOW, relationships: rel as any };
  const msg = (from: string): OrganiseMessage => ({
    id: "x",
    threadId: "x",
    internalDate: String(Date.UTC(2020, 5, 1)),
    state: { from, to: "", subject: "s", date: "", is_reply: false, has_list_unsubscribe: false, body: "" },
    envelope: {
      from,
      returnPath: "",
      sender: "",
      originalSender: "",
      listUnsubscribe: "",
      listId: "",
      listPost: "",
      precedence: "",
      autoSubmitted: "",
    },
  });
  const low = { project: { type: "choice" as const, choice: "alpha", confidence: 0.2 } };

  assertEquals(s.decide(msg("A <a@x.test>"), low, ctx).category, "alpha", "low confidence still counts");
  assertEquals(s.decide(msg("A <a@x.test>"), low, ctx).route, "choice");
  assertEquals(s.decide(msg("Boss <boss@vendor.test>"), low, ctx).route, "policy");
  assertEquals(s.decide(msg("Boss <boss@vendor.test>"), low, ctx).category, "beta");
  const unanswered = s.decide(msg("A <a@x.test>"), {}, ctx);
  assertEquals([unanswered.category, unanswered.route], ["none", "incomplete"]);
  const odd = { project: { type: "choice" as const, choice: "gamma", confidence: 0.9 } };
  assertEquals(s.decide(msg("A <a@x.test>"), odd, ctx).route, "incomplete");
  assertEquals(s.label("none", "0"), undefined);
  assertEquals(s.label("alpha", "0"), "project/alpha");
  assertThrows(() =>
    choiceScheme({ id: "p", question: PROJECT_QUESTION, labelPattern: "p/{category}", unlabelled: [] })
  );
});

// ── questions ───────────────────────────────────────────────────────────────

Deno.test("questions: one call's worth, hashed by what changes the answer", async () => {
  const profile = parseProfile(PROFILE);
  const all = questionsFor(profile.schemes);
  assertEquals(Object.keys(all).sort(), [...TRIAGE_IDS, "project"].sort());

  const q: Question = { type: "noul", instructions: { b: 1, a: 2 } };
  const reordered: Question = { type: "noul", instructions: { a: 2, b: 1 } };
  const shape = { context: { about_me: "x" }, bodyChars: 2000 };
  const h = await questionHash(q, shape);
  assertEquals(h.length, 16);
  assertEquals(await questionHash(reordered, shape), h, "key order does not matter");
  assertNotEquals(await questionHash({ type: "noul", instructions: { a: 3, b: 1 } }, shape), h);
  assertNotEquals(await questionHash(q, { ...shape, context: { about_me: "y" } }), h);
  assertNotEquals(await questionHash(q, { ...shape, bodyChars: 4000 }), h);

  const stored = { id: "m", answers: { a: { type: "noul" as const, noul: 0.1 } }, asked: { a: "h1" } };
  assertEquals(pendingQuestions(undefined, { a: "h1" }), ["a"]);
  assertEquals(pendingQuestions(stored, { a: "h1" }), []);
  assertEquals(pendingQuestions(stored, { a: "h2" }), ["a"]);
  assertEquals(pendingQuestions(stored, { a: "h1", b: "h3" }), ["b"]);
});

// ── golden set and rulings ──────────────────────────────────────────────────

Deno.test("golden: per-scheme cases, scoring and rulings", () => {
  const cases = parseGolden({ cases: GOLDEN }, {
    triage: ["delete", "defer", "keep", "important"],
    project: ["alpha", "beta", "none"],
  });
  assertEquals(cases.map((c) => c.scheme), ["triage", "triage", "triage", "project"]);
  assertThrows(
    () => parseGolden({ cases: [{ id: "a", expect: "archive" }] }),
    Error,
    undefined,
    "triage checked by default",
  );
  assertThrows(() =>
    parseGolden({ cases: [{ id: "a", scheme: "project", expect: "gamma" }] }, { project: ["alpha"] })
  );
  assertThrows(() => parseGolden({ cases: [{ id: "a", expect: "keep", never: ["keep"] }] }));

  const d = (id: string, scheme: string, category: string): SchemeDecision => ({
    id,
    scheme,
    category,
    route: "r",
    why: "w",
    sender: "s@x.test",
    subject: "s",
  });
  const r = score(cases, [
    d("r3", "triage", "delete"),
    d("r1", "triage", "delete"),
    d("r2", "project", "beta"),
  ], "triage");
  assertEquals([r.scheme, r.evaluated, r.passed, r.criticalFailures], ["triage", 2, 1, 1]);
  assertEquals(r.notInRun, ["r12"]);

  const replaced = withRuling(cases, { id: "r1", scheme: "triage", expect: "keep" });
  assertEquals(replaced.filter((c) => c.id === "r1" && c.scheme === "triage").map((c) => c.expect), ["keep"]);
  assertEquals(replaced.length, cases.length);
  assertEquals(withRuling(cases, { id: "r1", scheme: "project", expect: "none" }).length, cases.length + 1);
  assertThrows(() => withRuling(cases, { id: "z", expect: "keep", never: ["keep"] }));

  const cats = ["delete", "defer", "keep", "important"];
  const moved = withSenderRuling({ delete: { "a@x.test": "old" } }, "A@X.test", "keep", "new", cats);
  assertEquals(moved.keep, { "a@x.test": "new" });
  assertEquals(moved.delete?.["a@x.test"], undefined, "an address is never ruled twice");
  assertThrows(() => withSenderRuling({}, "a@x.test", "archive", "n", cats), ProfileError);
});

// ── labelling plan and the scoped writer ────────────────────────────────────

Deno.test("relabelPlan: one group per year and category, removing the scheme's other labels", () => {
  const s = triageScheme();
  const at = (y: number) => String(Date.UTC(y, 5, 1));
  const msgs = [{ id: "a", internalDate: at(2020) }, { id: "b", internalDate: at(2020) }, {
    id: "c",
    internalDate: at(2021),
  }];
  const dec = (id: string, category: string): SchemeDecision => ({
    id,
    scheme: "triage",
    category,
    route: "r",
    why: "",
    sender: "",
    subject: "",
  });
  const plan = plain(relabelPlan(s, [dec("a", "delete"), dec("b", "delete"), dec("c", "keep")], msgs));
  assertEquals(plan, [
    {
      add: "organiser/2020/delete",
      remove: ["organiser/2020/defer", "organiser/2020/important", "organiser/2020/keep"],
      ids: ["a", "b"],
    },
    {
      add: "organiser/2021/keep",
      remove: ["organiser/2021/defer", "organiser/2021/delete", "organiser/2021/important"],
      ids: ["c"],
    },
  ]);

  const p = choiceScheme({
    id: "project",
    question: PROJECT_QUESTION,
    labelPattern: "project/{category}",
    unlabelled: ["none"],
  });
  const none = plain(relabelPlan(p, [{ ...dec("a", "none"), scheme: "project" }], msgs));
  assertEquals(none, [{ remove: ["project/alpha", "project/beta"], ids: ["a"] }]);
});

// ── the decision model client ───────────────────────────────────────────────

Deno.test("SystemOneJudge: wire format, retries, typed errors", async () => {
  const jev = new FakeJev();
  const judge = new SystemOneJudge({ apiKey: KEY, fetch: jev.fetch, retryBaseMs: 1, model: "jev-latest" });
  jev.throttleNext = 2;
  const r = await judge.ask({ subject: "Weekly digest #12" }, {
    is_personal: { type: "noul", instructions: "x" },
  });
  assertEquals(r.model, "jev-test-1");
  assertEquals(r.answers.is_personal?.noul, 0.05);
  assert(r.inputTokens > 0);
  assertEquals(jev.calls[0].authorization, `Bearer ${KEY}`);

  const e = await assertRejects(
    () => judge.ask({ subject: "unknown" }, { q: { type: "noul", instructions: "x" } }),
    SystemOneError,
  );
  assertEquals((e as SystemOneError).status, 400);
  assertThrows(() => new SystemOneJudge({ apiKey: "" }));
});

// ── facts that must survive the port ────────────────────────────────────────

Deno.test("senderOf reads the angle brackets, never the display name", () => {
  assertEquals(senderOf(`"'no-reply@vendor.test' via redirect" <real@sender.test>`), "real@sender.test");
  assertEquals(senderOf(`"jo jo@old.test" <jo@new.test>`), "jo@new.test");
});
