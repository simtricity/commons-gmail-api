/**
 * The organise CLI, offline: exit codes, the key file, and the verbs driven
 * through `runOrganise` against the contract's synthetic mailbox.
 */
import { assert, assertEquals } from "@std/assert";
import {
  exitCodeFor,
  keyFromEnvFile,
  MissingKeyError,
  type OrganiseDeps,
  runOrganise,
  UsageError,
} from "../../cli/organise.ts";
import {
  GmailApiError,
  GmailWriter,
  GuardedWriter,
  InsufficientScopeError,
  NotSignedInError,
  OAuthError,
  SCOPE_COMPOSE,
  SCOPE_MODIFY,
  SCOPE_READONLY,
  WriteGuardError,
} from "../../mod.ts";
import { ProfileError, SystemOneError, SystemOneJudge } from "../../organise.ts";
import { FakeJev, FakeMailbox } from "./fakes.ts";
import { FLAKY, OWNER, RECEIVED, SENT } from "./fixtures.ts";

const WRITE = `${SCOPE_READONLY} ${SCOPE_MODIFY} ${SCOPE_COMPOSE}`;

Deno.test("exitCodeFor: every error class and result the table names", () => {
  const err = (e: unknown) => exitCodeFor({ error: e });
  assertEquals(err(new NotSignedInError("x")), 2);
  assertEquals(err(new OAuthError("x")), 2);
  assertEquals(err(new InsufficientScopeError(SCOPE_MODIFY, [SCOPE_READONLY])), 2);
  assertEquals(err(new MissingKeyError("x")), 2);
  assertEquals(err(new SystemOneError(401, "")), 2);
  assertEquals(err(new SystemOneError(403, "")), 2);
  assertEquals(err(new SystemOneError(500, "")), 1);
  assertEquals(err(new SystemOneError(429, "")), 1);
  assertEquals(err(new UsageError("x")), 1);
  assertEquals(err(new ProfileError("x")), 1);
  assertEquals(err(new WriteGuardError("no-ids", "x")), 1);
  assertEquals(err(new GmailApiError(403, "/x", "")), 1);
  assertEquals(err(new Error("x")), 1);
  assertEquals(err("thrown string"), 1);

  const ok = (verb: string, result: unknown) => exitCodeFor({ verb, result });
  assertEquals(ok("score", { criticalFailures: 1 }), 3);
  assertEquals(ok("score", { criticalFailures: 0 }), 0);
  assertEquals(ok("reconcile", { ok: false }), 4);
  assertEquals(ok("reconcile", { ok: true }), 0);
  for (const verb of ["capture", "fetch", "judge"]) {
    assertEquals(ok(verb, { failures: 2 }), 5, verb);
    assertEquals(ok(verb, { failures: 0 }), 0, verb);
  }
  assertEquals(ok("decide", { failures: 2 }), 0, "only the resumable stages report failures");
  assertEquals(ok("whoami", { ready: false }), 2);
  assertEquals(ok("whoami", { ready: true }), 0);
  assertEquals(ok("runs", []), 0);
});

Deno.test("keyFromEnvFile: the one line, unquoted; nothing else", () => {
  assertEquals(keyFromEnvFile("A=1\nTYPESAFE_API_KEY=abc\nB=2"), "abc");
  assertEquals(keyFromEnvFile('export TYPESAFE_API_KEY="q w"'), "q w");
  assertEquals(keyFromEnvFile("TYPESAFE_API_KEY='x'\r\n"), "x");
  assertEquals(keyFromEnvFile("TYPESAFE_API_KEY="), undefined);
  assertEquals(keyFromEnvFile("OTHER_TYPESAFE_API_KEY=no\n# TYPESAFE_API_KEY=no"), undefined);
});

const PROFILE = {
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

async function cli(profile: unknown = PROFILE) {
  const dir = await Deno.makeTempDir({ prefix: "organise-cli-" });
  await Deno.writeTextFile(`${dir}/profile.json`, JSON.stringify(profile));
  const mailbox = new FakeMailbox([...SENT, ...RECEIVED], FLAKY);
  const jev = new FakeJev();
  const state = { key: true as boolean, writeGrant: true as boolean };
  const out: string[] = [];
  const err: string[] = [];
  const deps: OrganiseDeps = {
    dataDir: dir,
    pacing: { readsPerSecond: 1000, quotaRetryMs: 5 },
    gmail: () => Promise.resolve(mailbox.client(SCOPE_READONLY)),
    writer: () => {
      if (!state.writeGrant) return Promise.reject(new NotSignedInError("no write grant"));
      return Promise.resolve(
        new GuardedWriter(new GmailWriter(mailbox.client(WRITE)), {
          log: { path: `${dir}/guard.log`, via: "test" },
        }),
      );
    },
    judge: (model) => {
      if (!state.key) throw new MissingKeyError("no key");
      return new SystemOneJudge({ apiKey: "k", model, fetch: jev.fetch, retryBaseMs: 1 });
    },
    grants: () => Promise.resolve({ read: { email: OWNER, scopes: [SCOPE_READONLY] } }),
    out: (t) => out.push(t),
    err: (t) => err.push(t),
  };
  const run = async (...argv: string[]) => {
    out.length = 0;
    const code = await runOrganise(argv, () => deps);
    return { code, json: argv.includes("--json") ? JSON.parse(out.join("\n")) : undefined };
  };
  return { dir, mailbox, jev, state, run, err, done: () => Deno.remove(dir, { recursive: true }) };
}

Deno.test("cli: the pipeline by verb, --json on stdout, exit codes as the table says", async () => {
  const c = await cli();
  const pace = ["--json"];
  assertEquals((await c.run("capture", "--source", "sent", ...pace)).code, 0);
  assertEquals((await c.run("corpus", ...pace)).code, 0);
  const s = await c.run(
    "sample",
    "--run",
    "r",
    "--year",
    "2020",
    "--size",
    "100",
    "--single-message",
    ...pace,
  );
  assertEquals([s.code, s.json.sample.size > 0], [0, true]);
  const f = await c.run("fetch", "--run", "r", "--rate", "1000", ...pace);
  assertEquals([f.code, f.json.failures], [0, 0]);
  assertEquals((await c.run("judge", "--run", "r", ...pace)).code, 0);
  const d = await c.run("decide", "--run", "r", "--now", "2026-09-01T00:00:00Z", ...pace);
  assertEquals([d.code, Object.keys(d.json)], [0, ["triage", "project"]]);

  assertEquals(
    (await c.run("score", "--run", "r", ...pace)).code,
    1,
    "two schemes: --scheme needed",
  );
  assertEquals((await c.run("score", "--run", "r", "--scheme", "triage", ...pace)).code, 0);

  const before = c.mailbox.writes().length;
  const dry = await c.run("apply", "--run", "r", "--scheme", "triage", ...pace);
  assertEquals([dry.code, dry.json.dryRun, c.mailbox.writes().length], [0, true, before]);
  c.state.writeGrant = false;
  const refused = await c.run("apply", "--run", "r", "--scheme", "triage", "--apply", ...pace);
  assertEquals([refused.code, refused.json.error.name], [2, "NotSignedInError"]);
  c.state.writeGrant = true;
  const done = await c.run("apply", "--run", "r", "--scheme", "triage", "--apply", ...pace);
  assertEquals([done.code, done.json.dryRun], [0, false]);
  assertEquals((await c.run("reconcile", "--run", "r", "--scheme", "triage", ...pace)).code, 0);

  const del = c.mailbox.labelByName("organiser/2020/delete")!;
  const keep = c.mailbox.labelByName("organiser/2020/keep")!;
  const r1 = c.mailbox.messages.get("r1")!;
  r1.labelIds = r1.labelIds.filter((l) => l !== del.id).concat(keep.id);
  const off = await c.run("reconcile", "--run", "r", "--scheme", "triage", ...pace);
  assertEquals([off.code, off.json.ok], [4, false]);

  // A critical failure: r1 is ruled never-delete, and it is decided delete.
  const ruled = await c.run(
    "rule",
    "--scheme",
    "triage",
    "--message",
    "r1",
    "--is",
    "keep",
    "--never",
    "delete",
    ...pace,
  );
  assertEquals([ruled.code, ruled.json.case.never], [0, ["delete"]]);
  assertEquals((await c.run("score", "--run", "r", "--scheme", "triage", ...pace)).code, 3);

  const runs = await c.run("runs", ...pace);
  assertEquals([runs.code, runs.json.map((m: { id: string }) => m.id)], [0, ["r"]]);
  await c.done();
});

Deno.test("cli: usage errors exit 1, a missing key exits 2, rule --find wants one match", async () => {
  const c = await cli();
  assertEquals((await c.run("nosuch", "--json")).code, 1);
  assertEquals((await c.run("sample", "--year", "2020", "--json")).code, 1, "no --run");
  assertEquals((await c.run("sample", "--run", "x", "--json")).code, 1, "no --year or --query");
  assertEquals((await c.run("sample", "--run", "x", "--year", "20.5")).code, 1);
  assertEquals((await c.run("capture", "--source", "drafts")).code, 1);
  assertEquals((await c.run("decide", "--run", "r", "--now", "soon")).code, 1);
  assertEquals((await c.run("fetch", "--bogus")).code, 1, "unknown option");

  await c.run("capture", "--source", "sent");
  await c.run("sample", "--run", "r", "--year", "2020", "--size", "100", "--single-message");
  await c.run("fetch", "--run", "r", "--rate", "1000");
  c.state.key = false;
  const nokey = await c.run("judge", "--run", "r", "--json");
  assertEquals([nokey.code, nokey.json.error.name], [2, "MissingKeyError"]);
  c.state.key = true;
  await c.run("judge", "--run", "r");
  await c.run("decide", "--run", "r");

  c.err.length = 0;
  const many = await c.run(
    "rule",
    "--scheme",
    "triage",
    "--run",
    "r",
    "--find",
    "test",
    "--is",
    "keep",
  );
  assertEquals(many.code, 1);
  assert(c.err.filter((l) => l.startsWith("  r")).length > 1, "the candidates are listed");
  const one = await c.run(
    "rule",
    "--scheme",
    "triage",
    "--run",
    "r",
    "--find",
    "invoice",
    "--is",
    "keep",
    "--json",
  );
  assertEquals([one.code, one.json.case.id, one.json.decision.id], [0, "r3", "r3"]);
  await c.done();
});

Deno.test("cli: one scheme needs no --scheme; whoami is ready only with a read grant and a key", async () => {
  const c = await cli({});
  const w = await c.run("whoami", "--json");
  assertEquals([w.code, w.json.ready, w.json.read.email, w.json.model.ok], [0, true, OWNER, true]);
  assertEquals([w.json.profile.schemes, w.json.dataDir.exists], [["triage"], true]);
  c.state.key = false;
  const nokey = await c.run("whoami", "--json");
  assertEquals([nokey.code, nokey.json.model.ok], [2, false]);
  await c.run("capture", "--source", "sent");
  await c.run("sample", "--run", "r", "--year", "2020", "--size", "100", "--single-message");
  await c.run("fetch", "--run", "r", "--rate", "1000");
  c.state.key = true;
  await c.run("judge", "--run", "r");
  await c.run("decide", "--run", "r");
  assertEquals((await c.run("apply", "--run", "r", "--json")).json.scheme, "triage");
  await c.done();
});
