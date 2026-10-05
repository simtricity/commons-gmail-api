/** Offline tests for GuardedWriter's scoped bulk relabel: refusals, chunking, log hashing. */
import { assert, assertEquals, assertRejects } from "@std/assert";
import {
  BATCH_MODIFY_MAX,
  GmailClient,
  GmailWriter,
  GuardedWriter,
  idsSha256,
  type Label,
  MemoryTokenStore,
  SCOPE_COMPOSE,
  SCOPE_MODIFY,
  SCOPE_READONLY,
  sha256Hex,
  WriteGuardError,
} from "../mod.ts";

type Call = { method: string; path: string; body?: Record<string, unknown> };
const WRITE = `${SCOPE_READONLY} ${SCOPE_MODIFY} ${SCOPE_COMPOSE}`;
const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status });

const BASE: Label[] = [
  { id: "INBOX", name: "INBOX", type: "system" },
  { id: "L1", name: "sorter", type: "user" },
  { id: "L2", name: "sorter/2020", type: "user" },
  { id: "L3", name: "sorter/2020/keep", type: "user" },
  { id: "L4", name: "sorter/2020/later", type: "user" },
  { id: "L5", name: "receipts", type: "user" },
  // A system-type label whose name sits inside the prefix: unusual, but must still be refused.
  { id: "S1", name: "sorter/sys", type: "system" },
] as Label[];

async function setup() {
  const dir = await Deno.makeTempDir();
  const logPath = `${dir}/writes.log`;
  let labels = [...BASE];
  const calls: Call[] = [];
  const store = new MemoryTokenStore();
  store.save({
    refreshToken: "r",
    accessToken: "a",
    accessTokenExpiresAt: new Date(Date.now() + 3600_000).toISOString(),
    email: "user@example.test",
    scope: WRITE,
    savedAt: new Date().toISOString(),
  });
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const c: Call = {
      method: init?.method ?? "GET",
      path: String(input).replace("https://gmail.googleapis.com/gmail/v1/users/me", ""),
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    };
    calls.push(c);
    await Promise.resolve();
    if (c.path === "/labels" && c.method === "GET") return json({ labels });
    if (c.path === "/labels" && c.method === "POST") {
      const l = { id: `N${labels.length}`, name: String(c.body!.name), type: "user" } as Label;
      labels = [...labels, l];
      return json(l);
    }
    if (c.path === "/messages/batchModify") return new Response(null, { status: 204 });
    if (c.path === "/profile") return json({ emailAddress: "user@example.test" });
    return json({});
  };
  const client = new GmailClient({
    clientSecret: { clientId: "i", clientSecret: "s" },
    store,
    fetch,
  });
  const g = new GuardedWriter(new GmailWriter(client), { log: { path: logPath, via: "test" } });
  const lines = async () =>
    (await Deno.readTextFile(logPath).catch(() => "")).split("\n").filter(Boolean).map((l) =>
      JSON.parse(l)
    );
  const posts = () => calls.filter((c) => c.method !== "GET");
  const modifies = () => calls.filter((c) => c.path === "/messages/batchModify");
  return { g, lines, posts, modifies };
}

async function code(fn: () => Promise<unknown>): Promise<string> {
  const e = await assertRejects(fn, WriteGuardError);
  return (e as WriteGuardError).code;
}

Deno.test("scoped refusals come in order and before any write", async () => {
  const { g, posts } = await setup();
  const r = (req: Partial<Parameters<typeof g.scopedRelabel>[0]>) => () =>
    g.scopedRelabel({ prefix: "sorter/", remove: [], ids: ["m1"], apply: true, ...req });

  assertEquals(await code(r({ prefix: "" })), "bad-scope");
  assertEquals(await code(r({ prefix: "sorter" })), "bad-scope");
  // bad-scope wins even when the names are also outside it
  assertEquals(await code(r({ prefix: "sorter", add: "receipts" })), "bad-scope");
  assertEquals(await code(r({ add: "receipts" })), "outside-scope");
  // outside-scope is checked before system-label: INBOX is refused as outside
  assertEquals(await code(r({ add: "sorter/2020/keep", remove: ["INBOX"] })), "outside-scope");
  assertEquals(await code(r({ add: "sorter/sys" })), "system-label");
  assertEquals(await code(r({ remove: ["sorter/sys"] })), "system-label");
  // system-label is checked before no-such-label
  assertEquals(await code(r({ add: "sorter/missing", remove: ["sorter/sys"] })), "system-label");
  assertEquals(await code(r({ add: "sorter/missing" })), "no-such-label");
  assertEquals(posts(), [], "nothing was written");
});

Deno.test("createScopedLabel: inside the prefix only, parents created, idempotent", async () => {
  const { g, lines } = await setup();
  assertEquals(await code(() => g.createScopedLabel("sorter/", "elsewhere/x")), "outside-scope");
  assertEquals(await code(() => g.createScopedLabel("sorter", "sorter/x")), "bad-scope");
  assertEquals(await code(() => g.createScopedLabel("", "x")), "bad-scope");
  const first = await g.createScopedLabel("sorter/", "sorter/2021/keep");
  assertEquals(first.created, true);
  assertEquals(first.label.name, "sorter/2021/keep");
  assertEquals((await g.createScopedLabel("sorter/", "sorter/2021/keep")).created, false);
  const created = (await lines()).filter((l) => l.op === "label.create").map((l) => l.name);
  assertEquals(created, ["sorter/2021/keep"], "one log line, for the real create only");
});

Deno.test("dry run writes nothing; missing remove names are skipped", async () => {
  const { g, modifies, lines } = await setup();
  const dry = await g.scopedRelabel({
    prefix: "sorter/",
    add: "sorter/2020/keep",
    remove: ["sorter/2020/later", "sorter/2020/not-yet"],
    ids: ["m1", "m2", "m1", " "],
  });
  assertEquals(dry.dryRun, true);
  assertEquals(dry.add, { id: "L3", name: "sorter/2020/keep" });
  assertEquals(dry.remove, [{ id: "L4", name: "sorter/2020/later" }]);
  assertEquals(dry.ids, ["m1", "m2"], "de-duplicated, blanks dropped, order kept");
  assertEquals(dry.count, 2);
  assertEquals(modifies().length, 0);
  assertEquals(await lines(), []);
});

Deno.test("add named in remove is dropped from remove, never sent as both", async () => {
  const { g, modifies } = await setup();
  const plan = await g.planScopedRelabel({
    prefix: "sorter/",
    add: "sorter/2020/keep",
    remove: ["sorter/2020/keep", "sorter/2020/later"],
    ids: ["m1"],
  });
  assertEquals(plan.remove.map((l) => l.name), ["sorter/2020/later"]);
  await g.scopedRelabel({
    prefix: "sorter/",
    add: "sorter/2020/keep",
    remove: ["sorter/2020/keep"],
    ids: ["m1"],
    apply: true,
  });
  const body = modifies()[0].body!;
  assertEquals(body.addLabelIds, ["L3"]);
  assertEquals(body.removeLabelIds, undefined, "an empty remove list is not sent");
});

Deno.test("no id cap: applied in chunks of BATCH_MODIFY_MAX", async () => {
  const { g, modifies } = await setup();
  const ids = Array.from({ length: 1501 }, (_, i) => `m${i}`);
  const done = await g.scopedRelabel({
    prefix: "sorter/",
    add: "sorter/2020/keep",
    remove: ["sorter/2020/later"],
    ids,
    apply: true,
  });
  assertEquals(done.applied, true);
  assertEquals(done.calls, 2);
  const sizes = modifies().map((c) => (c.body!.ids as string[]).length);
  assertEquals(sizes, [BATCH_MODIFY_MAX, 501]);
  assertEquals(modifies()[0].body!.addLabelIds, ["L3"]);
  assertEquals(modifies()[0].body!.removeLabelIds, ["L4"]);
});

Deno.test("an applied relabel logs one line with a hash of the ids, never the ids", async () => {
  const { g, lines } = await setup();
  const ids = ["m3", "m1", "m2", "m1"];
  await g.scopedRelabel({
    prefix: "sorter/",
    add: "sorter/2020/keep",
    remove: ["sorter/2020/later"],
    ids,
    apply: true,
  });
  const relabels = (await lines()).filter((l) => l.op === "label.relabel");
  assertEquals(relabels.length, 1);
  const l = relabels[0];
  assertEquals(l.prefix, "sorter/");
  assertEquals(l.add, { id: "L3", name: "sorter/2020/keep" });
  assertEquals(l.remove, [{ id: "L4", name: "sorter/2020/later" }]);
  assertEquals(l.count, 3);
  assertEquals(l.via, "test");
  assertEquals(l.ids, undefined, "ids are hashed, not logged");
  // Independent computation: sorted, de-duplicated, joined by a newline.
  const expected = await sha256Hex(new TextEncoder().encode("m1\nm2\nm3"));
  assertEquals(l.idsSha256, expected);
  assertEquals(await idsSha256(["m2", "m3", "m1"]), expected, "order does not matter");
});

Deno.test("nothing to do is a no-op: no request, no log line", async () => {
  const { g, modifies, lines } = await setup();
  const none = await g.scopedRelabel({
    prefix: "sorter/",
    remove: ["sorter/2020/not-yet"],
    ids: ["m1"],
    apply: true,
  });
  assertEquals(none.calls, 0);
  const empty = await g.scopedRelabel({
    prefix: "sorter/",
    add: "sorter/2020/keep",
    remove: [],
    ids: [],
    apply: true,
  });
  assertEquals([empty.count, empty.calls], [0, 0]);
  assertEquals(modifies().length, 0);
  assertEquals(await lines(), []);
});

Deno.test("labelChange keeps its 25-id cap", async () => {
  const { g } = await setup();
  const ids = Array.from({ length: 26 }, (_, i) => `m${i}`);
  assertEquals(await code(() => g.labelChange({ name: "receipts", ids })), "too-many-ids");
  assert((await g.labelChange({ name: "receipts", ids: ids.slice(0, 25) })).dryRun);
});
