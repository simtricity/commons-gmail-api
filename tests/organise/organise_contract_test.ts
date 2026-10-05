/**
 * Contract test for `@simtricity-commons/gmail-api/organise`, written by its
 * first user (the gmail-organiser session) before it is built.
 *
 * Offline. Gmail is `FakeMailbox` behind a real `GmailClient`; the decision
 * model is `FakeJev` behind a real `SystemOneJudge`. Every expected verdict was
 * checked against the gmail-organiser engine this is ported from.
 *
 * To run in gmail-api: copy `contract/` to `tests/organise/`, point `deps.ts` at
 * `../../mod.ts`, and change the `./organise_api.ts` import below to
 * `../../organise.ts`. Permissions: --allow-read --allow-write (temp dirs, and
 * the isolation check reads the repo's own sources).
 *
 * @module
 */

import { assert, assertEquals, assertNotEquals, assertRejects, assertThrows } from "@std/assert";
import {
  type ApplySummary,
  choiceScheme,
  type DecisionsFile,
  type GoldenCase,
  type Manifest,
  type OrganiseMessage,
  Organiser,
  type OrganiserIO,
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
} from "../../organise.ts";
import {
  GmailWriter,
  GuardedWriter,
  SCOPE_COMPOSE,
  SCOPE_MODIFY,
  SCOPE_READONLY,
  WriteGuardError,
} from "./deps.ts";
import { FakeJev, FakeMailbox } from "./fakes.ts";
import {
  FLAKY,
  NOW,
  PROJECT_EXPECTED,
  RECEIVED,
  REJECTED_2020,
  SAMPLED_2020,
  SENT,
  TRIAGE_EXPECTED,
  TRIAGE_IDS,
  TRIAGE_SENDERS,
} from "./fixtures.ts";

const WRITE = `${SCOPE_READONLY} ${SCOPE_MODIFY} ${SCOPE_COMPOSE}`;
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

async function writeJson(path: string, value: unknown): Promise<void> {
  await Deno.mkdir(path.replace(/\/[^/]+$/, ""), { recursive: true });
  await Deno.writeTextFile(path, JSON.stringify(value, null, 2));
}

const readJson = async <T>(path: string): Promise<T> => JSON.parse(await Deno.readTextFile(path)) as T;

/** A data directory holding the profile and rulings, nothing else. */
async function dataDir(profile: ProfileFile = PROFILE): Promise<string> {
  const dir = await Deno.makeTempDir({ prefix: "organise-contract-" });
  await writeJson(`${dir}/profile.json`, profile);
  await writeJson(`${dir}/rulings/senders.json`, { triage: TRIAGE_SENDERS });
  await writeJson(`${dir}/rulings/golden.json`, { cases: GOLDEN });
  return dir;
}

async function world() {
  const mailbox = new FakeMailbox([...SENT, ...RECEIVED], FLAKY);
  const receipts = mailbox.addUserLabel("receipts", ["r3"]);
  const jev = new FakeJev();
  const guardLog = await Deno.makeTempFile({ prefix: "organise-guard-" });
  const io: OrganiserIO = {
    gmail: mailbox.client(SCOPE_READONLY),
    judge: new SystemOneJudge({ apiKey: KEY, fetch: jev.fetch, retryBaseMs: 1 }),
    writer: new GuardedWriter(new GmailWriter(mailbox.client(WRITE)), {
      log: { path: guardLog, via: "contract" },
    }),
    now: () => NOW,
    pacing: { readsPerSecond: 1000, concurrency: 4, quotaRetryMs: 5 },
  };
  return { mailbox, jev, io, receipts, guardLog };
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const jsonLines = async (path: string) =>
  (await Deno.readTextFile(path)).split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));

const ids = (xs: { id: string }[]) => xs.map((x) => x.id).sort();
/** Drops keys whose value is undefined, so "absent" and "undefined" compare equal. */
const plain = <T>(x: T): T => JSON.parse(JSON.stringify(x));
const orgLabels = (names: string[], prefix: string) => names.filter((n) => n.startsWith(prefix));

// ── the whole pipeline, as the skill drives it ──────────────────────────────

Deno.test("organise: capture → corpus → sample → fetch → judge → decide → score → apply → reconcile", async (t) => {
  const { mailbox, jev, io, receipts, guardLog } = await world();
  const dir = await dataDir();
  let org = await Organiser.open(dir, io);
  const run = "t2020";

  await t.step("open builds the profile's schemes in file order", () => {
    assertEquals(org.profile.schemes.map((s) => s.id), ["triage", "project"]);
    assertEquals(org.golden.length, GOLDEN.length);
    assert(org.golden.every((c) => typeof c.scheme === "string"));
  });

  await t.step("capture stores sent metadata in yearly shards", async () => {
    const c = await org.capture({ source: "sent" });
    assertEquals(c.captured, SENT.length);
    assertEquals(c.shards, ["2019", "2020"]);
    const again = await org.capture({ source: "sent" });
    assertEquals(again.captured, 0, "a second capture finds nothing new");
  });

  await t.step("corpus makes a six-message correspondent strong", async () => {
    const c = await org.corpus();
    assert(c.strong >= 1);
    assert(c.path.endsWith("/derived/corpus.json"));
  });

  await t.step("sample skips replied-into threads and multi-message threads", async () => {
    const m = await org.sample({ run, year: 2020, size: 100, singleMessage: true });
    assertEquals(m.year, 2020);
    assertEquals(m.sample?.candidates, SAMPLED_2020.length);
    const sample = await readJson<{ id: string }[]>(`${dir}/runs/${run}/sample.json`);
    assertEquals(ids(sample), [...SAMPLED_2020].sort());
    await assertRejects(() => org.sample({ run, year: 2020, size: 100, singleMessage: true }), Error);
    const redraw = await org.sample({ run, year: 2020, size: 100, singleMessage: true, force: true });
    assertEquals(
      redraw.sample?.candidates,
      SAMPLED_2020.length,
      "a redraw with the same seed is the same draw",
    );
  });

  await t.step("fetch rejects grown threads and survives a quota refusal", async () => {
    const f = await org.fetch({ run });
    assertEquals(f.rejected, REJECTED_2020.length);
    assertEquals(f.fetched, SAMPLED_2020.length - REJECTED_2020.length);
    assertEquals(f.failures, 0);
    assert(f.quotaRetries >= 1, "the 403 rateLimitExceeded was retried, not failed");
    for (const id of REJECTED_2020) {
      assertEquals(mailbox.reads.get(id), undefined, "a rejected message is never read");
    }
    const again = await org.fetch({ run });
    assertEquals(again.fetched, f.fetched, "resumable: nothing is read twice");
  });

  await t.step("judge asks every scheme's questions in one call per message", async () => {
    const j = await org.judge({ run });
    const fetched = SAMPLED_2020.length - REJECTED_2020.length;
    assertEquals(j.messages, fetched);
    assertEquals(jev.calls.length, fetched);
    const want = [...TRIAGE_IDS, "project"].sort();
    for (const c of jev.calls) {
      assertEquals(c.questions, want);
      assertEquals(c.authorization, `Bearer ${KEY}`);
      assertEquals(c.model, "jev-latest");
      assertEquals(c.context, PROFILE.context);
    }
    assertEquals(j.model, "jev-test-1");
    assertEquals(j.failures, 0);
    assert(j.inputTokens > 0);

    const again = await org.judge({ run });
    assertEquals(again.messages, 0);
    assertEquals(jev.calls.length, fetched, "answered questions are not asked again");
  });

  await t.step("decide gives the triage verdicts and project choices", async () => {
    const out = await org.decide({ run, now: NOW });
    assertEquals(Object.keys(out).sort(), ["project", "triage"]);
    assertEquals(out.triage.counts, { delete: 5, defer: 1, keep: 1, important: 2 });

    const triage = await readJson<DecisionsFile>(`${dir}/runs/${run}/decisions.triage.json`);
    assertEquals(triage.now, new Date(NOW).toISOString());
    for (const d of triage.decisions) {
      assertEquals({ verdict: d.category, route: d.route }, TRIAGE_EXPECTED[d.id], d.id);
    }
    assertEquals(ids(triage.decisions), Object.keys(TRIAGE_EXPECTED).sort());

    const project = await readJson<DecisionsFile>(`${dir}/runs/${run}/decisions.project.json`);
    for (const d of project.decisions) assertEquals(d.category, PROJECT_EXPECTED[d.id], d.id);
    assertEquals(project.decisions.find((d) => d.id === "r2")?.route, "choice");

    const again = await org.decide({ run, now: NOW });
    assertEquals(again.triage.moves, {}, "nothing moves on an unchanged re-decide");
  });

  await t.step("score reads only its own scheme's cases", async () => {
    const triage = await org.score({ run, scheme: "triage" });
    assertEquals([triage.evaluated, triage.passed, triage.criticalFailures], [3, 3, 0]);
    const project = await org.score({ run, scheme: "project" });
    assertEquals([project.evaluated, project.passed], [1, 1]);
  });

  let writesBefore = 0;
  await t.step("apply is a dry run unless told otherwise", async () => {
    writesBefore = mailbox.writes().length;
    const plan = await org.apply({ run, scheme: "triage" });
    assertEquals(plan.dryRun, true);
    assertEquals(plan.calls, 0);
    assertEquals(plan.toCreate.sort(), [
      "organiser/2020/defer",
      "organiser/2020/delete",
      "organiser/2020/important",
      "organiser/2020/keep",
    ]);
    assertEquals(plan.unchanged, 0);
    assertEquals(mailbox.writes().length, writesBefore, "a dry run writes nothing");
  });

  await t.step("apply labels each message once, inside its own prefix only", async () => {
    const done: ApplySummary = await org.apply({ run, scheme: "triage", apply: true });
    assertEquals(done.dryRun, false);
    assert(done.calls >= 1);
    for (const [id, want] of Object.entries(TRIAGE_EXPECTED)) {
      assertEquals(orgLabels(mailbox.labelNames(id), "organiser/"), [`organiser/2020/${want.verdict}`], id);
    }
    for (const id of REJECTED_2020) assertEquals(orgLabels(mailbox.labelNames(id), "organiser/"), []);
    assert(
      mailbox.messages.get("r3")!.labelIds.includes(receipts.id),
      "a label outside the prefix is untouched",
    );
    for (const m of mailbox.messages.values()) {
      const original = [...SENT, ...RECEIVED].find((x) => x.id === m.id)!;
      for (const l of original.labelIds) assert(m.labelIds.includes(l), `${m.id} kept ${l}`);
      assert(!m.labelIds.includes("TRASH") && !m.labelIds.includes("SPAM"));
    }
    for (const w of mailbox.writes()) {
      assert(
        w.method === "POST" && (w.path === "/labels" || w.path === "/messages/batchModify"),
        `only label creation and batchModify: ${w.method} ${w.path}`,
      );
    }
    const manifest = await readJson<Manifest>(`${dir}/runs/${run}/manifest.json`);
    assertEquals(manifest.apply?.triage.calls, done.calls);
  });

  await t.step("every applied id is kept locally, and matches the guard log (R2)", async () => {
    const applied = await jsonLines(`${dir}/runs/${run}/apply.triage.log`);
    const guarded = new Set(
      (await jsonLines(guardLog)).filter((l) => l.op === "label.relabel").map((l) => l.idsSha256),
    );
    assert(applied.length >= 1);
    for (const line of applied) {
      assertEquals(line.scheme, "triage");
      assertEquals(line.ids, [...line.ids].sort(), "ids are stored sorted");
      assertEquals(line.idsSha256, await sha256Hex(line.ids.join("\n")));
      assert(guarded.has(line.idsSha256), "the guard logged the same change");
    }
    assertEquals(applied.flatMap((l) => l.ids).sort(), Object.keys(TRIAGE_EXPECTED).sort());
  });

  await t.step("reconcile agrees, then catches a hand-moved label", async () => {
    assertEquals((await org.reconcile({ run, scheme: "triage" })).ok, true);
    const del = mailbox.labelByName("organiser/2020/delete")!;
    const keep = mailbox.labelByName("organiser/2020/keep")!;
    const r1 = mailbox.messages.get("r1")!;
    r1.labelIds = r1.labelIds.filter((l) => l !== del.id).concat(keep.id);

    const r = await org.reconcile({ run, scheme: "triage" });
    assertEquals(r.ok, false);
    assertEquals(r.wrong, [{ id: "r1", decided: "delete", labelled: "keep" }]);

    const fix = await org.apply({ run, scheme: "triage", apply: true });
    assertEquals(fix.moves, { "keep → delete": 1 });
    assertEquals((await org.reconcile({ run, scheme: "triage" })).ok, true);
  });

  await t.step("a second scheme labels under its own prefix and leaves the first alone", async () => {
    const before = new Map(
      [...mailbox.messages.keys()].map((id) => [id, orgLabels(mailbox.labelNames(id), "organiser/")]),
    );
    await org.apply({ run, scheme: "project", apply: true });
    assertEquals(orgLabels(mailbox.labelNames("r2"), "project/"), ["project/alpha"]);
    assertEquals(orgLabels(mailbox.labelNames("r3"), "project/"), ["project/beta"]);
    for (const id of ["r1", "r4", "r5", "r9", "r10", "r11", "r12"]) {
      assertEquals(orgLabels(mailbox.labelNames(id), "project/"), [], id);
    }
    for (const [id, labels] of before) {
      assertEquals(orgLabels(mailbox.labelNames(id), "organiser/"), labels, id);
    }
    const r = await org.reconcile({ run, scheme: "project" });
    assertEquals(r.ok, true);
    assertEquals(r.counts.none, 7);
  });

  await t.step("rewording one question re-asks only that question", async () => {
    const reworded: ProfileFile = structuredClone(PROFILE);
    const choice = reworded.schemes.project as { question: { instructions: unknown } };
    choice.question.instructions = "Which of the two projects is this about?";
    await writeJson(`${dir}/profile.json`, reworded);
    org = await Organiser.open(dir, io);

    const before = jev.calls.length;
    const j = await org.judge({ run });
    assertEquals(j.questions, ["project"]);
    assertEquals(jev.calls.length - before, SAMPLED_2020.length - REJECTED_2020.length);
    for (const c of jev.calls.slice(before)) assertEquals(c.questions, ["project"]);

    const manifest = await readJson<Manifest>(`${dir}/runs/${run}/manifest.json`);
    assertEquals(manifest.judge?.passes.length, 2, "a pass that asked nothing is not recorded");
    assertEquals(manifest.judge?.inputTokens, manifest.judge!.passes.reduce((a, p) => a + p.inputTokens, 0));
    assertEquals(manifest.judge?.costUsd, undefined, "no price in the profile, so no cost");
  });

  await t.step("explain shows the facts behind a decision", async () => {
    const e = await org.explain({ run, id: "r2", scheme: "triage" });
    assertEquals(e.decision.route, "important-relationship");
    assertEquals(e.facts.sender, "alice@partner.test");
    assertEquals(e.facts.strength, "strong");
    assertEquals(e.facts.protection, "address");
    assertEquals(Object.keys(e.asked).sort(), [...TRIAGE_IDS, "project"].sort());
  });

  await t.step("find locates a message by subject or sender", async () => {
    assertEquals((await org.find({ run, text: "notes from" })).map((m: OrganiseMessage) => m.id), ["r11"]);
    assertEquals((await org.find({ run, text: "ALICE@partner" })).map((m: OrganiseMessage) => m.id), ["r2"]);
  });

  await t.step("rule records a golden case and a sender ruling, then re-decides", async () => {
    const r = await org.rule({
      scheme: "triage",
      id: "r11",
      is: "important",
      note: "synthetic",
      sender: true,
      run,
    });
    assertEquals(plain(r.case), { id: "r11", scheme: "triage", expect: "important", note: "synthetic" });
    assertEquals(r.sender, { address: "person@neutral.test", category: "important" });
    assertEquals(r.decision?.category, "important");
    assertEquals(r.decision?.route, "policy");

    const senders = await readJson<Record<string, Record<string, Record<string, string>>>>(
      `${dir}/rulings/senders.json`,
    );
    assertEquals(senders.triage.important, { "person@neutral.test": "synthetic" });
    assertEquals(senders.triage.delete, TRIAGE_SENDERS.delete, "existing rulings are kept");

    await org.rule({ scheme: "triage", id: "r11", is: "keep" });
    const golden = parseGolden(await readJson(`${dir}/rulings/golden.json`));
    assertEquals(golden.filter((c) => c.id === "r11").map((c) => c.expect), ["keep"], "a re-ruling replaces");
    await assertRejects(
      () => org.rule({ scheme: "triage", id: "r11", is: ["keep", "defer"], sender: true }),
      Error,
    );
  });

  await t.step("runs lists manifests", async () => {
    assertEquals((await org.runs()).map((m) => m.id), [run]);
  });

  await t.step("nothing outside label creation and batchModify was ever written", () => {
    for (const c of mailbox.calls) {
      assert(c.method === "GET" || c.method === "POST", `${c.method} ${c.path}`);
      assert(!/trash|delete|send|drafts|spam/i.test(c.path), c.path);
    }
  });

  await Deno.remove(dir, { recursive: true });
  await Deno.remove(guardLog);
});

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

Deno.test("GuardedWriter scoped relabel: bulk inside a prefix, nothing outside it", async () => {
  const mailbox = new FakeMailbox(RECEIVED);
  const logPath = await Deno.makeTempFile();
  const w = new GuardedWriter(new GmailWriter(mailbox.client(WRITE)), {
    log: { path: logPath, via: "contract" },
  });

  const code = async (fn: () => Promise<unknown>) => {
    const e = await assertRejects(fn, WriteGuardError);
    return (e as WriteGuardError).code as string;
  };
  assertEquals(await code(() => w.createScopedLabel("organiser/", "elsewhere/x")), "outside-scope");
  assertEquals(await code(() => w.createScopedLabel("organiser", "organiser/x")), "bad-scope");
  assertEquals(await code(() => w.createScopedLabel("", "x")), "bad-scope");
  const { label, created } = await w.createScopedLabel("organiser/", "organiser/2020/keep");
  assert(created);
  assertEquals((await w.createScopedLabel("organiser/", "organiser/2020/keep")).created, false);

  assertEquals(
    await code(() => w.scopedRelabel({ prefix: "organiser/", add: "receipts", remove: [], ids: ["r1"] })),
    "outside-scope",
  );
  assertEquals(
    await code(() =>
      w.scopedRelabel({ prefix: "organiser/", add: label.name, remove: ["INBOX"], ids: ["r1"] })
    ),
    "outside-scope",
  );
  assertEquals(
    await code(() =>
      w.scopedRelabel({ prefix: "organiser/", add: "organiser/missing", remove: [], ids: ["r1"] })
    ),
    "no-such-label",
  );

  const many = Array.from({ length: 1500 }, (_, i) => `m${i}`).concat("r1");
  const dry = await w.scopedRelabel({
    prefix: "organiser/",
    add: label.name,
    remove: ["organiser/2020/delete"],
    ids: many,
  });
  assertEquals(dry.dryRun, true);
  assertEquals(dry.count, many.length);
  assertEquals(dry.remove, [], "a label that does not exist yet is skipped");
  assertEquals(mailbox.writes().filter((c) => c.path === "/messages/batchModify").length, 0);

  const done = await w.scopedRelabel({
    prefix: "organiser/",
    add: label.name,
    remove: [],
    ids: many,
    apply: true,
  });
  assertEquals(done.applied, true);
  assertEquals(done.calls, 2, "no 25-id cap: chunked at 1000");
  assert(mailbox.labelNames("r1").includes("organiser/2020/keep"));

  const lines = (await Deno.readTextFile(logPath)).trim().split("\n").map((l) => JSON.parse(l));
  const relabel = lines.find((l) => l.op === "label.relabel");
  assertEquals(relabel.count, many.length);
  assertEquals(relabel.prefix, "organiser/");
  assertEquals(typeof relabel.idsSha256, "string");
  assertEquals(relabel.ids, undefined, "ids are hashed, not logged");
  await Deno.remove(logPath);
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

// ── package shape ───────────────────────────────────────────────────────────

Deno.test("package: the core never imports organise; organise is an entry point, the CLI is not (R3)", async () => {
  const root = new URL("../../", import.meta.url);
  const deno = JSON.parse(await Deno.readTextFile(new URL("deno.json", root)));
  const exports = typeof deno.exports === "string" ? { ".": deno.exports } : deno.exports;
  assertEquals(exports["./organise"], "./organise.ts");
  assertEquals(exports["./cli"], undefined, "cli/ stays unpublished in 0.7.0");
  assert(deno.publish.exclude.includes("cli/"));

  const core = [new URL("mod.ts", root)];
  for await (const e of Deno.readDir(new URL("lib/", root))) {
    if (e.isFile && e.name.endsWith(".ts")) core.push(new URL(`lib/${e.name}`, root));
  }
  for (const f of core) {
    const text = await Deno.readTextFile(f);
    assert(!/from\s+["'][^"']*organise/.test(text), `${f.pathname} imports organise`);
  }
});
