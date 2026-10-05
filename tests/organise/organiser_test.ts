/**
 * Organiser stages against the contract's synthetic mailbox. The full pipeline is
 * the contract test's; these pin each stage's own edges.
 */
import { assert, assertEquals, assertRejects } from "@std/assert";
import { Organiser, type OrganiserIO } from "../../organise.ts";
import { ProfileError } from "../../lib/organise/scheme.ts";
import {
  GmailApiError,
  GmailWriter,
  GuardedWriter,
  idsSha256,
  SCOPE_COMPOSE,
  SCOPE_MODIFY,
  SCOPE_READONLY,
  ScopedRelabelError,
} from "../../mod.ts";
import { FakeJev, FakeMailbox } from "./fakes.ts";
import { SystemOneJudge } from "../../lib/organise/judge.ts";
import { FLAKY, NOW, RECEIVED, SENT } from "./fixtures.ts";

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

const WRITE = `${SCOPE_READONLY} ${SCOPE_MODIFY} ${SCOPE_COMPOSE}`;

const jsonLines = async (path: string) =>
  (await Deno.readTextFile(path)).split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));

const ours = (names: string[], prefix: string) => names.filter((n) => n.startsWith(prefix));

Deno.test("apply and reconcile: dry run first, changed messages only, every group logged (R2)", async () => {
  const { w } = await judged();
  const guardLog = `${w.dir}/../${w.dir.split("/").at(-1)}-guard.log`;
  w.io.writer = new GuardedWriter(new GmailWriter(w.mailbox.client(WRITE)), {
    log: { path: guardLog, via: "test" },
  });
  const org = await Organiser.open(w.dir, w.io);
  await org.corpus();
  await org.judge({ run: "r" });
  await org.decide({ run: "r", now: NOW });
  const before = w.mailbox.writes().length;

  const plan = await org.apply({ run: "r", scheme: "triage" });
  assertEquals([plan.dryRun, plan.calls, plan.unchanged], [true, 0, 0]);
  assertEquals(plan.toCreate, [
    "organiser/2020/defer",
    "organiser/2020/delete",
    "organiser/2020/important",
    "organiser/2020/keep",
  ]);
  assertEquals(plan.moves, {
    "unlabelled → delete": 5,
    "unlabelled → defer": 1,
    "unlabelled → keep": 1,
    "unlabelled → important": 2,
  });
  assertEquals(w.mailbox.writes().length, before, "a dry run writes nothing");

  const done = await org.apply({ run: "r", scheme: "triage", apply: true });
  assertEquals([done.dryRun, done.calls], [false, 4]);
  for (const call of w.mailbox.writes()) {
    assert(
      call.method === "POST" && (call.path === "/labels" || call.path === "/messages/batchModify"),
      `${call.method} ${call.path}`,
    );
  }
  const applied = await jsonLines(`${w.dir}/runs/r/apply.triage.log`);
  const guarded = (await jsonLines(guardLog))
    .filter((l) => l.op === "label.relabel")
    .map((l) => l.idsSha256);
  assertEquals(applied.length, 4);
  for (const line of applied) {
    assertEquals(Object.keys(line), ["at", "scheme", "add", "remove", "ids", "idsSha256", "calls"]);
    assertEquals(line.ids, [...line.ids].sort());
    assertEquals(line.idsSha256, await idsSha256(line.ids));
    assert(guarded.includes(line.idsSha256), "the guard logged the same change");
  }
  const manifest = JSON.parse(await Deno.readTextFile(`${w.dir}/runs/r/manifest.json`));
  assertEquals(manifest.apply.triage.calls, 4);

  const again = await org.apply({ run: "r", scheme: "triage" });
  assertEquals([again.unchanged, again.toCreate, again.moves], [9, [], {}]);
  const ok = await org.reconcile({ run: "r", scheme: "triage" });
  assertEquals([ok.ok, ok.counts], [true, { delete: 5, defer: 1, keep: 1, important: 2 }]);
  assertEquals(ok.outsideRun["organiser/2020/delete"], 0);

  // A hand move is caught, then fixed by relabelling that message alone.
  const del = w.mailbox.labelByName("organiser/2020/delete")!;
  const keep = w.mailbox.labelByName("organiser/2020/keep")!;
  const r1 = w.mailbox.messages.get("r1")!;
  r1.labelIds = r1.labelIds.filter((l) => l !== del.id).concat(keep.id);
  const off = await org.reconcile({ run: "r", scheme: "triage" });
  assertEquals([off.ok, off.wrong], [false, [{ id: "r1", decided: "delete", labelled: "keep" }]]);
  const fix = await org.apply({ run: "r", scheme: "triage", apply: true });
  assertEquals([fix.moves, fix.calls], [{ "keep → delete": 1 }, 1]);
  assertEquals((await jsonLines(`${w.dir}/runs/r/apply.triage.log`)).at(-1).ids, ["r1"]);
  assertEquals((await org.reconcile({ run: "r", scheme: "triage" })).ok, true);

  // An unlabelled category is never labelled, and counts messages carrying none.
  await org.apply({ run: "r", scheme: "project", apply: true });
  const project = await org.reconcile({ run: "r", scheme: "project" });
  assertEquals([project.ok, project.counts], [true, { alpha: 1, beta: 1, none: 7 }]);
  assertEquals(ours(w.mailbox.labelNames("r1"), "project/"), []);

  await Deno.remove(guardLog);
  await w.done();
});

Deno.test("apply: refuses to write without a writer, after a dry run is still free", async () => {
  const { w, org } = await judged();
  await org.judge({ run: "r" });
  await org.decide({ run: "r", now: NOW, schemes: ["triage"] });
  assertEquals((await org.apply({ run: "r", scheme: "triage" })).dryRun, true);
  const before = w.mailbox.writes().length;
  await assertRejects(
    () => org.apply({ run: "r", scheme: "triage", apply: true }),
    TypeError,
    "write grant",
  );
  assertEquals(w.mailbox.writes().length, before);
  await w.done();
});

/** A writer whose `n`th batchModify is refused with 403. */
class RefusingWriter extends GmailWriter {
  calls = 0;
  constructor(client: ConstructorParameters<typeof GmailWriter>[0], readonly refuse: number) {
    super(client);
  }
  override async batchModifyMessages(
    ids: string[],
    change: Parameters<GmailWriter["batchModifyMessages"]>[1],
  ): Promise<number> {
    if (++this.calls === this.refuse) {
      throw new GmailApiError(403, "/messages/batchModify", '{"error":{"code":403}}');
    }
    return await super.batchModifyMessages(ids, change);
  }
}

Deno.test("apply: a group refused part way logs what landed, then rethrows (R2, R-c)", async () => {
  const ids = Array.from({ length: 1500 }, (_, i) => `m${String(i).padStart(4, "0")}`);
  const date = String(Date.UTC(2020, 5, 1));
  const w = await setup({
    "profile.json": {
      schemes: {
        project: {
          kind: "choice",
          question: { id: "project", instructions: "Which?", options: { alpha: "", none: "" } },
          labels: { pattern: "project/{category}" },
          unlabelled: ["none"],
        },
      },
    },
    "runs/big/manifest.json": { id: "big", createdAt: new Date(NOW).toISOString() },
    "runs/big/messages.json": {
      messages: ids.map((id) => ({ id, internalDate: date })),
      rejected: [],
    },
    "runs/big/decisions.project.json": {
      scheme: "project",
      decidedAt: new Date(NOW).toISOString(),
      now: new Date(NOW).toISOString(),
      decisions: [...ids].reverse().map((id) => ({
        id,
        scheme: "project",
        category: "alpha",
        route: "choice",
        why: "",
        sender: "a@b.test",
        subject: "",
      })),
    },
  });
  const guardLog = `${w.dir}-guard.log`;
  w.io.writer = new GuardedWriter(new RefusingWriter(w.mailbox.client(WRITE), 2), {
    log: { path: guardLog, via: "test" },
  });
  const org = await Organiser.open(w.dir, w.io);
  const e = await assertRejects(
    () => org.apply({ run: "big", scheme: "project", apply: true }),
    ScopedRelabelError,
  );
  assertEquals([e.callsDone, e.status], [1, 403]);
  const [line] = await jsonLines(`${w.dir}/runs/big/apply.project.log`);
  assertEquals(line.ids, ids, "every id of the group, sorted");
  assertEquals([line.calls, line.partial, line.error], [1, true, {
    name: "GmailApiError",
    status: 403,
  }]);
  assertEquals(line.idsSha256, e.idsSha256);
  const [guarded] = (await jsonLines(guardLog)).filter((l) => l.op === "label.relabel");
  assertEquals([guarded.idsSha256, guarded.callsDone, guarded.partial], [line.idsSha256, 1, true]);
  const manifest = JSON.parse(await Deno.readTextFile(`${w.dir}/runs/big/manifest.json`));
  assertEquals(
    manifest.apply,
    undefined,
    "a failed apply is recorded in its log, not the manifest",
  );
  await Deno.remove(guardLog);
  await w.done();
});

Deno.test("rule: golden and sender rulings written, replaced, re-decided; refusals write nothing", async () => {
  const { w, org } = await judged();
  await org.judge({ run: "r" });
  await org.decide({ run: "r", now: NOW });
  const r = await org.rule({
    scheme: "triage",
    id: "r11",
    is: "important",
    note: "synthetic",
    sender: true,
    run: "r",
  });
  assertEquals(r.case, { id: "r11", scheme: "triage", expect: "important", note: "synthetic" });
  assertEquals(r.sender, { address: "person@neutral.test", category: "important" });
  assertEquals([r.decision?.category, r.decision?.route], ["important", "policy"]);
  assertEquals(org.golden.length, 1);
  assertEquals(org.profile.schemes[0].categories.length, 4);

  const golden = `${w.dir}/rulings/golden.json`;
  const senders = `${w.dir}/rulings/senders.json`;
  assertEquals(JSON.parse(await Deno.readTextFile(senders)), {
    triage: { important: { "person@neutral.test": "synthetic" } },
  });
  assertEquals(await mode(golden), 0o600);

  // Without a run, the sender comes from the newest run that decided the message.
  const moved = await org.rule({ scheme: "triage", id: "r11", is: "keep", sender: true });
  assertEquals([moved.sender?.category, moved.decision], ["keep", undefined]);
  assertEquals(JSON.parse(await Deno.readTextFile(senders)), {
    triage: { keep: { "person@neutral.test": "" } },
  });
  assertEquals(
    JSON.parse(await Deno.readTextFile(golden)).cases.map((c: { expect: string }) => c.expect),
    ["keep"],
    "a re-ruling replaces",
  );

  const project = await org.rule({ scheme: "project", id: "r2", is: ["alpha", "beta"] });
  assertEquals(project.case.scheme, "project");
  assertEquals(org.golden.length, 2);

  const before = [await Deno.readTextFile(golden), await Deno.readTextFile(senders)];
  for (
    const bad of [
      { scheme: "triage", id: "r11", is: ["keep", "defer"], sender: true },
      { scheme: "triage", id: "r11", is: "archive" },
      { scheme: "project", id: "r2", is: "gamma" },
      { scheme: "nosuch", id: "r2", is: "alpha" },
    ]
  ) {
    await assertRejects(() => org.rule(bad), ProfileError);
  }
  await assertRejects(
    () => org.rule({ scheme: "triage", id: "nope", is: "keep", sender: true }),
    Error,
    "sender is unknown",
  );
  assertEquals(
    [await Deno.readTextFile(golden), await Deno.readTextFile(senders)],
    before,
    "a refused ruling leaves both files as they were",
  );
  assertEquals((await Organiser.open(w.dir, w.io)).golden.length, 2, "reopened, the rulings hold");
  await w.done();
});
