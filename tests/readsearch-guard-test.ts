/** Offline tests for bodyText/readMessage, searchThreads, requireDateBound and GuardedWriter. */
import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import {
  bodyText,
  GmailClient,
  GmailWriter,
  GuardedWriter,
  hasDateBound,
  MemoryTokenStore,
  type Message,
  readMessage,
  requireDateBound,
  SCOPE_COMPOSE,
  SCOPE_MODIFY,
  SCOPE_READONLY,
  searchThreads,
  stripHtml,
  UnboundedQueryError,
  WriteGuardError,
} from "../mod.ts";

const b64u = (s: string) =>
  btoa(String.fromCharCode(...new TextEncoder().encode(s))).replace(/\+/g, "-").replace(
    /\//g,
    "_",
  ).replace(/=+$/, "");
const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status });
type Call = { method: string; path: string; body?: unknown };

function fake(routes: (c: Call) => Response | undefined, scope = SCOPE_READONLY) {
  const calls: Call[] = [];
  const store = new MemoryTokenStore();
  store.save({
    refreshToken: "r",
    accessToken: "a",
    accessTokenExpiresAt: new Date(Date.now() + 3600_000).toISOString(),
    email: "user@example.test",
    scope,
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
    return routes(c) ?? json({});
  };
  const client = new GmailClient({
    clientSecret: { clientId: "i", clientSecret: "s" },
    store,
    fetch,
  });
  return { client, calls };
}

const msg = (parts: Message["payload"], snippet = "snip"): Message => ({
  id: "m1",
  threadId: "t1",
  snippet,
  payload: parts,
});

Deno.test("bodyText prefers text/plain, skips attached text files, keeps UTF-8", () => {
  const m = msg({
    mimeType: "multipart/mixed",
    parts: [
      { mimeType: "text/plain", filename: "notes.txt", body: { data: b64u("ATTACHMENT") } },
      {
        mimeType: "multipart/alternative",
        parts: [
          { mimeType: "text/plain", body: { data: b64u("  Hello £5 — thanks  ") } },
          { mimeType: "text/html", body: { data: b64u("<p>html</p>") } },
        ],
      },
    ],
  });
  assertEquals(bodyText(m), { text: "Hello £5 — thanks", source: "text/plain", truncatedChars: 0 });
});

Deno.test("bodyText falls back to stripped HTML, then snippet, then none", () => {
  const html = msg({
    mimeType: "text/html",
    body: { data: b64u("<style>x{}</style><p>Hi&nbsp;there</p><div>A &amp; B</div>") },
  });
  assertEquals(bodyText(html).source, "text/html");
  assertEquals(bodyText(html).text, "Hi there\nA & B");
  assertEquals(
    bodyText(msg({ mimeType: "multipart/mixed", parts: [] }, "preview")).source,
    "snippet",
  );
  assertEquals(bodyText(msg({ mimeType: "multipart/mixed" }, "")).source, "none");
  assertEquals(stripHtml("&amp;lt;"), "&lt;"); // entities decoded once, &amp; last
});

Deno.test("bodyText maxChars truncates and reports how much was cut", () => {
  const m = msg({ mimeType: "text/plain", body: { data: b64u("0123456789") } });
  const r = bodyText(m, { maxChars: 4 });
  assertEquals(r.truncatedChars, 6);
  assertEquals(r.text, "0123\n…[truncated 6 chars]");
  assertEquals(bodyText(m, { maxChars: 10 }).truncatedChars, 0);
});

Deno.test("readMessage carries headers and non-inline attachments only", () => {
  const r = readMessage({
    id: "m1",
    threadId: "t1",
    labelIds: ["INBOX"],
    payload: {
      mimeType: "multipart/mixed",
      headers: [
        { name: "From", value: "a@example.test" },
        { name: "To", value: "b@example.test" },
        { name: "Cc", value: "c@example.test" },
        { name: "Subject", value: "S" },
        { name: "Date", value: "D" },
      ],
      parts: [
        { mimeType: "text/plain", body: { data: b64u("body") } },
        { mimeType: "application/pdf", filename: "a.pdf", body: { attachmentId: "x", size: 3 } },
        {
          mimeType: "image/png",
          filename: "logo.png",
          headers: [
            { name: "Content-Disposition", value: "inline" },
            { name: "Content-ID", value: "<logo>" },
          ],
          body: { attachmentId: "y", size: 1 },
        },
      ],
    },
  });
  assertEquals(r.cc, "c@example.test");
  assertEquals(r.attachments, [{ filename: "a.pdf", mimeType: "application/pdf", size: 3 }]);
  assertEquals(r.text, "body");
});

Deno.test("searchThreads groups by thread, dedupes senders and files, reports hasMore", async () => {
  const meta = (id: string, from: string, files: string[]) =>
    json({
      id,
      threadId: id.startsWith("a") ? "ta" : "tb",
      payload: {
        headers: [{ name: "From", value: from }, { name: "Subject", value: `s-${id}` }, {
          name: "Date",
          value: `d-${id}`,
        }],
        parts: files.map((f) => ({
          mimeType: "application/pdf",
          filename: f,
          body: { attachmentId: "x", size: 1 },
        })),
      },
    });
  const { client } = fake((c) => {
    if (c.path.startsWith("/messages?")) {
      return json({
        messages: [{ id: "a2", threadId: "ta" }, { id: "b1", threadId: "tb" }, {
          id: "a1",
          threadId: "ta",
        }],
        nextPageToken: "p2",
      });
    }
    if (c.path.startsWith("/messages/a2")) return meta("a2", "x@e.test", ["inv.pdf"]);
    if (c.path.startsWith("/messages/a1")) return meta("a1", "x@e.test", ["inv.pdf", "b.pdf"]);
    if (c.path.startsWith("/messages/b1")) return meta("b1", "y@e.test", []);
  });
  const r = await searchThreads(client, "q newer_than:1d", { maxResults: 3 });
  assertEquals(r.returned, 3);
  assertEquals(r.hasMore, true);
  assertEquals(r.nextPageToken, "p2");
  assertEquals(r.threads.map((t) => t.threadId), ["ta", "tb"]);
  const ta = r.threads[0];
  assertEquals(ta.messages, 2);
  assertEquals(ta.latest, "d-a2");
  assertEquals(ta.subject, "s-a2");
  assertEquals(ta.from, ["x@e.test"]);
  assertEquals(ta.attachments, ["inv.pdf", "b.pdf"]);
  assertEquals(ta.messageIds, ["a2", "a1"]);
});

Deno.test("requireDateBound is opt-in and recognises each operator", () => {
  for (const q of ["newer_than:7d", "older_than:1y x", "after:2026/01/01", "BEFORE:2026/01/01"]) {
    assert(hasDateBound(q));
    assertEquals(requireDateBound(q), q);
  }
  assertThrows(() => requireDateBound("from:a@b.test"), UnboundedQueryError);
});

// ── GuardedWriter ────────────────────────────────────────────────────────────

const WRITE = `${SCOPE_READONLY} ${SCOPE_MODIFY} ${SCOPE_COMPOSE}`;
const LABELS = [
  { id: "INBOX", name: "INBOX", type: "system" },
  { id: "L1", name: "keep", type: "user" },
];

async function guardedFake(opts: { maxIds?: number } = {}) {
  const dir = await Deno.makeTempDir();
  const path = `${dir}/writes.log`;
  let labels = [...LABELS];
  const f = fake((c) => {
    if (c.path === "/labels" && c.method === "GET") return json({ labels });
    if (c.path === "/labels" && c.method === "POST") {
      const l = {
        id: `L${labels.length + 1}`,
        name: (c.body as { name: string }).name,
        type: "user",
      };
      labels = [...labels, l];
      return json(l);
    }
    if (c.path === "/messages/batchModify") return new Response(null, { status: 204 });
    if (c.path === "/drafts") return json({ id: "d1", message: { id: "m9", threadId: "t1" } });
  }, WRITE);
  const g = new GuardedWriter(new GmailWriter(f.client), {
    maxIds: opts.maxIds,
    log: { path, via: "test-suite" },
    now: () => new Date("2026-09-27T12:00:00Z"),
  });
  const lines = async () =>
    (await Deno.readTextFile(path).catch(() => "")).split("\n").filter(Boolean).map((l) =>
      JSON.parse(l)
    );
  return { g, calls: f.calls, lines };
}

const writes = (calls: Call[]) => calls.filter((c) => c.method !== "GET");

Deno.test("guard: dry run by default makes no write and logs nothing", async () => {
  const { g, calls, lines } = await guardedFake();
  const r = await g.labelChange({ name: "keep", ids: ["a", "b", "a"] });
  assertEquals(r.dryRun, true);
  assertEquals(r.ids, ["a", "b"]); // de-duplicated
  assertEquals(r.count, 2);
  assertEquals(writes(calls).length, 0);
  assertEquals(await lines(), []);
});

Deno.test("guard: apply writes once and logs the skill's line shape", async () => {
  const { g, calls, lines } = await guardedFake();
  const r = await g.labelChange({ name: "keep", ids: ["a", "b"], apply: true });
  assertEquals(r.applied, true);
  assertEquals(writes(calls).map((c) => c.path), ["/messages/batchModify"]);
  assertEquals(await lines(), [{
    at: "2026-09-27T12:00:00.000Z",
    via: "test-suite",
    account: "user@example.test",
    op: "label.apply",
    label: { id: "L1", name: "keep" },
    kind: "message",
    ids: ["a", "b"],
    count: 2,
  }]);
});

Deno.test("guard: id cap, empty ids, unknown and system labels refused before any write", async () => {
  const { g, calls } = await guardedFake({ maxIds: 2 });
  const code = async (p: Promise<unknown>) =>
    (await assertRejects(() => p, WriteGuardError) as WriteGuardError).code;
  assertEquals(
    await code(g.labelChange({ name: "keep", ids: ["a", "b", "c"], apply: true })),
    "too-many-ids",
  );
  assertEquals(await code(g.labelChange({ name: "keep", ids: [" ", ""], apply: true })), "no-ids");
  assertEquals(
    await code(g.labelChange({ name: "nope", ids: ["a"], apply: true })),
    "no-such-label",
  );
  assertEquals(
    await code(g.labelChange({ name: "INBOX", ids: ["a"], apply: true })),
    "system-label",
  );
  assertEquals(writes(calls).length, 0);
  assertEquals(g.maxIds, 2);
});

Deno.test("guard: createLabel is idempotent and logs only a real create", async () => {
  const { g, lines } = await guardedFake();
  assertEquals((await g.createLabel("keep")).created, false);
  const r = await g.createLabel("new");
  assertEquals(r.created, true);
  assertEquals((await g.createLabel("new")).created, false);
  const l = await lines();
  assertEquals(l.length, 1);
  assertEquals(l[0].op, "label.create");
  assertEquals(l[0].name, "new");
});

Deno.test("guard: createDraft returns a link, sent:false, and logs draft ids", async () => {
  const { g, lines } = await guardedFake();
  const r = await g.createDraft({ to: ["a@example.test"], subject: "s", text: "t" });
  assertEquals(r.sent, false);
  assert(r.url.endsWith("compose=m9"));
  const [l] = await lines();
  assertEquals([l.op, l.draftId, l.messageId, l.threadId, l.via], [
    "draft.create",
    "d1",
    "m9",
    "t1",
    "test-suite",
  ]);
});

Deno.test("guard: createDraft logs attachment filenames and sizes, never content", async () => {
  const { g, lines } = await guardedFake();
  await g.createDraft({
    to: ["a@example.test"],
    subject: "s",
    text: "t",
    attachments: [{ filename: "a.pdf", content: new Uint8Array(10) }],
  });
  const [l] = await lines();
  assertEquals(l.attachments, [{ filename: "a.pdf", bytes: 10 }]);
});
