/**
 * Organiser stages against the contract's synthetic mailbox. The full pipeline is
 * the contract test's; these pin each stage's own edges.
 */
import { assert, assertEquals, assertRejects } from "@std/assert";
import { Organiser, type OrganiserIO } from "../../organise.ts";
import { ProfileError } from "../../lib/organise/scheme.ts";
import { SCOPE_READONLY } from "../../mod.ts";
import { FakeMailbox } from "./contract/fakes.ts";
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
