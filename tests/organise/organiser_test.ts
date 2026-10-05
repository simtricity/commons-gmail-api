/**
 * Organiser stages against the contract's synthetic mailbox. The full pipeline is
 * the contract test's; these pin each stage's own edges.
 */
import { assert, assertEquals, assertRejects } from "@std/assert";
import { Organiser, type OrganiserIO } from "../../organise.ts";
import { ProfileError } from "../../lib/organise/scheme.ts";
import { SCOPE_READONLY } from "../../mod.ts";
import { FakeJev, FakeMailbox } from "./contract/fakes.ts";
import { SystemOneJudge } from "../../lib/organise/judge.ts";
import { FLAKY, NOW, RECEIVED, SENT } from "./contract/fixtures.ts";

async function setup(files: Record<string, unknown> = {}) {
  const dir = await Deno.makeTempDir({ prefix: "organiser-test-" });
  for (const [rel, value] of Object.entries(files)) {
    await Deno.mkdir(`${dir}/${rel}`.replace(/\/[^/]+$/, ""), { recursive: true });
    await Deno.writeTextFile(`${dir}/${rel}`, JSON.stringify(value));
  }
  const mailbox = new FakeMailbox([...SENT, ...RECEIVED], FLAKY);
  const lines: string[] = [];
  const io: OrganiserIO = {
    gmail: mailbox.client(SCOPE_READONLY),
    now: () => NOW,
    log: (l) => lines.push(l),
    pacing: { readsPerSecond: 1000, concurrency: 4, quotaRetryMs: 5 },
  };
  return { dir, mailbox, io, lines, done: () => Deno.remove(dir, { recursive: true }) };
}

const mode = async (p: string) => ((await Deno.stat(p)).mode ?? 0) & 0o777;

Deno.test("open: no files at all is generic triage with no rulings", async () => {
  const w = await setup();
  const org = await Organiser.open(w.dir, w.io);
  assertEquals(org.profile.schemes.map((s) => s.id), ["triage"]);
  assertEquals(org.golden, []);
  const listed = [];
  for await (const e of Deno.readDir(w.dir)) listed.push(e.name);
  assertEquals(listed, [], "open writes nothing");
  await w.done();
});

Deno.test("open: refuses a corpus path outside the data directory, and bad rulings", async () => {
  for (const corpus of ["/etc/corpus.json", "../corpus.json", "derived/../../x.json"]) {
    const w = await setup({ "profile.json": { corpus } });
    await assertRejects(
      () => Organiser.open(w.dir, w.io),
      ProfileError,
      "inside the data directory",
    );
    await w.done();
  }
  const w = await setup({ "rulings/golden.json": { cases: [{ id: "a", expect: "archive" }] } });
  await assertRejects(() => Organiser.open(w.dir, w.io), ProfileError, "archive");
  await w.done();
});

Deno.test("capture: yearly shards 0600, incremental, and a capped run keeps the marker", async () => {
  const w = await setup();
  const org = await Organiser.open(w.dir, w.io);
  const capped = await org.capture({ source: "sent", max: 3 });
  assertEquals(capped.captured, 3);
  await assertRejects(
    () => Deno.stat(`${w.dir}/capture/state.json`),
    Deno.errors.NotFound,
    undefined,
    "no marker after a capped run",
  );
  const rest = await org.capture({ source: "sent" });
  assertEquals([rest.captured, rest.total], [SENT.length - 3, SENT.length]);
  assertEquals(await mode(`${w.dir}/capture/sent/2019.jsonl`), 0o600);
  const again = await org.capture({ source: "sent" });
  assertEquals(again.captured, 0);
  assert(again.query.includes("after:2020/"), "incremental from the newest captured date");
  const shardIds = (await Deno.readTextFile(`${w.dir}/capture/sent/2019.jsonl`)).trim().split("\n")
    .map((l) => JSON.parse(l).id);
  assertEquals(new Set(shardIds).size, shardIds.length, "nothing captured twice");
  await w.done();
});

Deno.test("corpus: needs a sent capture; writes under the data directory", async () => {
  const w = await setup();
  const org = await Organiser.open(w.dir, w.io);
  await assertRejects(() => org.corpus(), Error, "no sent capture");
  await org.capture({ source: "sent" });
  const c = await org.corpus();
  assertEquals([c.scanned, c.strong], [SENT.length, 1]);
  assert(c.path.startsWith(await Deno.realPath(w.dir)) || c.path.startsWith(w.dir));
  assert(c.path.endsWith("/derived/corpus.json"));
  const written = JSON.parse(await Deno.readTextFile(c.path));
  assertEquals(
    written.selfAddresses,
    ["me@home.test"],
    "the account's own address is never a correspondent",
  );
  await w.done();
});

Deno.test("sample and fetch: deterministic, replied threads out, grown threads rejected unread, resumable", async () => {
  const w = await setup();
  const org = await Organiser.open(w.dir, w.io);
  await org.capture({ source: "sent" });
  const m = await org.sample({ run: "y2020", year: 2020, size: 100, singleMessage: true });
  assertEquals(m.sample?.seed, 2020 * 10_000 + 100);
  const drawn = JSON.parse(await Deno.readTextFile(`${w.dir}/runs/y2020/sample.json`)).map((
    x: { id: string },
  ) => x.id);
  assert(!drawn.includes("r6"), "a thread you replied into is never sampled");
  await assertRejects(
    () => org.sample({ run: "y2020", year: 2020 }),
    Error,
    "already has a sample",
  );
  await assertRejects(() => org.sample({ run: "x", year: 2020, query: "label:x" }), TypeError);
  await assertRejects(() => org.sample({ run: "../x", year: 2020 }), TypeError);

  const f = await org.fetch({ run: "y2020" });
  assertEquals(f.rejected, 1);
  assertEquals(w.mailbox.reads.get("r7"), undefined, "the grown thread is never read");
  assert(f.quotaRetries >= 1, "the quota refusal was waited out");
  const reads = [...w.mailbox.reads.values()].reduce((a, b) => a + b, 0);
  const again = await org.fetch({ run: "y2020" });
  assertEquals([again.fetched, again.failures], [f.fetched, 0]);
  assertEquals(
    [...w.mailbox.reads.values()].reduce((a, b) => a + b, 0),
    reads,
    "nothing read twice",
  );
  const manifest = JSON.parse(await Deno.readTextFile(`${w.dir}/runs/y2020/manifest.json`));
  assertEquals(
    manifest.fetch.at,
    new Date(NOW).toISOString(),
    "timestamps come from the injected clock",
  );
  await w.done();
});

Deno.test("sample: a query sample, and a redraw clears derived files but never an applied run", async () => {
  const w = await setup();
  const org = await Organiser.open(w.dir, w.io);
  const q = await org.sample({ run: "q", query: "after:2020/06/01", size: 3 });
  assertEquals([q.year, q.sample?.seed, q.sample?.size], [undefined, 3, 3]);
  await org.fetch({ run: "q" });
  await org.sample({ run: "q", query: "after:2020/06/01", size: 3, force: true });
  await assertRejects(() => Deno.stat(`${w.dir}/runs/q/messages.json`), Deno.errors.NotFound);
  await Deno.writeTextFile(`${w.dir}/runs/q/apply.triage.log`, "{}\n");
  await assertRejects(
    () => org.sample({ run: "q", query: "after:2020/06/01", force: true }),
    Error,
    "has been applied",
  );
  await w.done();
});

const JUDGE_PROFILE = {
  pricePerMTok: 0.05,
  context: { about_me: "A synthetic account holder." },
  schemes: {
    triage: { kind: "triage" },
    project: {
      kind: "choice",
      question: {
        id: "project",
        instructions: "Which project?",
        options: { alpha: "", beta: "", none: "" },
      },
      labels: { pattern: "project/{category}" },
      unlabelled: ["none"],
    },
  },
};

async function judged() {
  const w = await setup({ "profile.json": JUDGE_PROFILE });
  const jev = new FakeJev();
  w.io.judge = new SystemOneJudge({ apiKey: "k", fetch: jev.fetch, retryBaseMs: 1 });
  const org = await Organiser.open(w.dir, w.io);
  await org.capture({ source: "sent" });
  await org.sample({ run: "r", year: 2020, size: 100, singleMessage: true });
  await org.fetch({ run: "r" });
  return { w, jev, org };
}

Deno.test("judge: one call per message with every scheme's questions, then nothing pending", async () => {
  const { w, jev, org } = await judged();
  const j = await org.judge({ run: "r" });
  assertEquals(jev.calls.length, j.messages);
  assertEquals(jev.calls[0].questions.length, 9);
  assertEquals(jev.calls[0].context, JUDGE_PROFILE.context);
  assertEquals([j.model, j.failures], ["jev-test-1", 0]);
  const again = await org.judge({ run: "r" });
  assertEquals([again.messages, again.questions], [0, []]);
  assertEquals(jev.calls.length, j.messages, "nothing asked twice");
  const forced = await org.judge({ run: "r", schemes: ["project"], force: true });
  assertEquals(forced.questions, ["project"]);
  await w.done();
});

Deno.test("judge: every asking pass is recorded and summed; a silent pass is not", async () => {
  const { w, org } = await judged();
  const first = await org.judge({ run: "r", schemes: ["triage"] });
  await org.judge({ run: "r", schemes: ["triage"] });
  const second = await org.judge({ run: "r" });
  assertEquals(second.questions, ["project"], "only the scheme not yet asked");
  const m = JSON.parse(await Deno.readTextFile(`${w.dir}/runs/r/manifest.json`));
  assertEquals(m.judge.passes.length, 2);
  assertEquals(m.judge.inputTokens, first.inputTokens + second.inputTokens);
  assertEquals(second.totalInputTokens, m.judge.inputTokens);
  assertEquals(m.judge.costUsd, Number(((m.judge.inputTokens / 1e6) * 0.05).toFixed(6)));
  const answers = JSON.parse(await Deno.readTextFile(`${w.dir}/runs/r/answers.json`));
  assertEquals(
    Object.keys(answers[0].asked).length,
    9,
    "each answer keeps the hash it was asked under",
  );
  await w.done();
});

Deno.test("judge: without a model it refuses before reading anything", async () => {
  const w = await setup();
  const org = await Organiser.open(w.dir, w.io);
  await assertRejects(() => org.judge({ run: "r" }), TypeError, "io.judge");
  await w.done();
});

Deno.test("decide, score, explain, find, runs: local and repeatable", async () => {
  const { w, org } = await judged();
  await org.corpus();
  await org.judge({ run: "r" });
  const out = await org.decide({ run: "r", now: NOW });
  assertEquals(Object.keys(out), ["triage", "project"]);
  assertEquals(out.triage.counts, { delete: 5, defer: 1, keep: 1, important: 2 });
  assertEquals(out.triage.routes.perishable, { delete: 1 }, "r10 without a ruling");
  assertEquals(out.project.counts, { alpha: 1, beta: 1, none: 7 });
  assertEquals(out.triage.routes.campaign, { delete: 1 });
  const again = await org.decide({ run: "r", now: NOW, schemes: ["triage"] });
  assertEquals(again.triage.moves, {}, "an unchanged re-decide moves nothing");
  await org.decide({ run: "r", now: Date.UTC(2040, 0, 1), schemes: ["triage"] });
  const file = JSON.parse(await Deno.readTextFile(`${w.dir}/runs/r/decisions.triage.json`));
  assertEquals(file.now, "2040-01-01T00:00:00.000Z");

  const e = await org.explain({ run: "r", id: "r2", scheme: "triage" });
  assertEquals([e.facts.sender, e.facts.strength, e.facts.protection], [
    "alice@partner.test",
    "strong",
    "address",
  ]);
  assertEquals(Object.keys(e.asked).length, 9);
  await assertRejects(
    () => org.explain({ run: "r", id: "nope", scheme: "triage" }),
    Error,
    "not decided",
  );
  await assertRejects(() => org.score({ run: "r", scheme: "nosuch" }), ProfileError);

  assertEquals((await org.find({ run: "r", text: "INVOICE" })).map((m) => m.id), ["r3"]);
  assertEquals((await org.runs()).map((m) => m.id), ["r"]);
  await w.done();
});

Deno.test("decide without a corpus still decides, treating nobody as known", async () => {
  const { w, org } = await judged();
  await org.judge({ run: "r" });
  const out = await org.decide({ run: "r", now: NOW, schemes: ["triage"] });
  assert(out.triage.counts.delete >= 1);
  assert(w.lines.some((l) => l.includes("no corpus")));
  await w.done();
});
