/** Offline tests for GmailWriter: scope gating, chunking, parent walking, guards, raw message. */
import { assert, assertEquals, assertRejects } from "@std/assert";
import {
  BATCH_MODIFY_MAX,
  buildRawMessage,
  GmailClient,
  GmailWriter,
  InsufficientScopeError,
  MAX_ATTACHMENT_BYTES,
  MemoryTokenStore,
  mimeTypeFor,
  SCOPE_COMPOSE,
  SCOPE_MODIFY,
  SCOPE_READONLY,
} from "../mod.ts";

type Call = { method: string; path: string; body?: unknown };

function fakeGmail(scope: string, routes: (c: Call) => Response | undefined) {
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
    const url = String(input);
    const c: Call = {
      method: init?.method ?? "GET",
      path: url.replace("https://gmail.googleapis.com/gmail/v1/users/me", ""),
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    };
    calls.push(c);
    await Promise.resolve();
    return routes(c) ?? new Response(JSON.stringify({}), { status: 200 });
  };
  const client = new GmailClient({
    clientSecret: { clientId: "id", clientSecret: "s" },
    store,
    fetch,
  });
  return { writer: new GmailWriter(client), calls };
}

const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status });
const WRITE = `${SCOPE_READONLY} ${SCOPE_MODIFY} ${SCOPE_COMPOSE}`;

Deno.test("readonly grant: writes throw locally with no network call", async () => {
  const { writer, calls } = fakeGmail(SCOPE_READONLY, () => undefined);
  await assertRejects(() => writer.createLabel("x"), InsufficientScopeError);
  await assertRejects(
    () => writer.modifyMessage("m", { addLabelIds: ["L"] }),
    InsufficientScopeError,
  );
  await assertRejects(
    () => writer.createDraft({ to: ["a@b.test"], text: "hi" }),
    InsufficientScopeError,
  );
  assertEquals(calls.length, 0);
});

Deno.test("scope parsing: order and whitespace do not matter; empty rejects", async () => {
  const ok = fakeGmail(`  ${SCOPE_MODIFY}   ${SCOPE_READONLY} `, () => json({}));
  await ok.writer.requireScope(SCOPE_MODIFY);
  const none = fakeGmail("", () => json({}));
  await assertRejects(() => none.writer.requireScope(SCOPE_MODIFY), InsufficientScopeError);
  // modify without compose: drafts refused, labels allowed
  const m = fakeGmail(SCOPE_MODIFY, () => json({}));
  await assertRejects(
    () => m.writer.createDraft({ to: ["a@b.test"], text: "x" }),
    InsufficientScopeError,
  );
  await m.writer.requireScope(SCOPE_MODIFY);
});

Deno.test("batchModifyMessages chunks at 1000 and no-ops on empty", async () => {
  const { writer, calls } = fakeGmail(WRITE, () => new Response(null, { status: 204 }));
  const ids = (n: number) => Array.from({ length: n }, (_, i) => `m${i}`);
  assertEquals(await writer.batchModifyMessages([], { addLabelIds: ["L"] }), 0);
  assertEquals(calls.length, 0);
  assertEquals(await writer.batchModifyMessages(ids(1000), { addLabelIds: ["L"] }), 1);
  assertEquals(await writer.batchModifyMessages(ids(1001), { addLabelIds: ["L"] }), 2);
  assertEquals(await writer.batchModifyMessages(ids(2500), { addLabelIds: ["L"] }), 3);
  const sizes = calls.map((c) => (c.body as { ids: string[] }).ids.length);
  assertEquals(sizes, [1000, 1000, 1, 1000, 1000, 500]);
  assert(sizes.every((s) => s <= BATCH_MODIFY_MAX));
});

Deno.test("ensureLabel creates missing parents in order, reuses existing, survives 409", async () => {
  let labels = [{ id: "L1", name: "a" }];
  let nextId = 2;
  const { writer, calls } = fakeGmail(WRITE, (c) => {
    if (c.method === "GET" && c.path === "/labels") return json({ labels });
    if (c.method === "POST" && c.path === "/labels") {
      const name = (c.body as { name: string }).name;
      if (name === "a/b") {
        // simulate a concurrent creator: exists at Gmail, not in our cache
        labels = [...labels, { id: "L99", name: "a/b" }];
        return json({ error: { errors: [{ reason: "conflict" }] } }, 409);
      }
      const l = { id: `L${nextId++}`, name };
      labels = [...labels, l];
      return json(l);
    }
  });
  const leaf = await writer.ensureLabel("a/b/c");
  assertEquals(leaf.name, "a/b/c");
  const creates = calls.filter((c) => c.method === "POST").map((c) =>
    (c.body as { name: string }).name
  );
  assertEquals(creates, ["a/b", "a/b/c"]); // "a" existed; "a/b" hit 409 and was re-resolved
  // idempotent second call: no creates
  const before = calls.length;
  assertEquals((await writer.ensureLabel("a/b/c")).id, leaf.id);
  assertEquals(calls.filter((c) => c.method === "POST").length, creates.length);
  assert(calls.length >= before);
});

Deno.test("system labels are refused without allowSystem", async () => {
  const { writer, calls } = fakeGmail(WRITE, () => json({ id: "m" }));
  await assertRejects(() => writer.modifyMessage("m", { addLabelIds: ["TRASH"] }), Error, "TRASH");
  await assertRejects(
    () => writer.batchModifyMessages(["m"], { removeLabelIds: ["INBOX"] }),
    Error,
    "INBOX",
  );
  assertEquals(calls.length, 0);
  await writer.modifyMessage("m", { removeLabelIds: ["INBOX"], allowSystem: true });
  assertEquals(calls.length, 1);
  assertEquals(calls[0].body, { removeLabelIds: ["INBOX"] }); // allowSystem never reaches the wire
});

Deno.test("createDraft as a reply sets thread, In-Reply-To, References, To and Re:", async () => {
  const { writer, calls } = fakeGmail(WRITE, (c) => {
    if (c.path.startsWith("/messages/orig")) {
      return json({
        id: "orig",
        threadId: "t1",
        payload: {
          headers: [
            { name: "Message-ID", value: "<x@example.test>" },
            { name: "References", value: "<w@example.test>" },
            { name: "From", value: "Sender <sender@example.test>" },
            { name: "Subject", value: "Invoice 42" },
          ],
        },
      });
    }
    if (c.path === "/drafts") return json({ id: "d1", message: { id: "m9", threadId: "t1" } });
  });
  const d = await writer.createDraft({ replyToMessageId: "orig", text: "Thanks — received." });
  assertEquals(d.id, "d1");
  const body = calls.at(-1)!.body as { message: { raw: string; threadId: string } };
  assertEquals(body.message.threadId, "t1");
  const raw = atob(body.message.raw.replace(/-/g, "+").replace(/_/g, "/"));
  assert(raw.includes("To: Sender <sender@example.test>\r\n"));
  assert(raw.includes("Subject: Re: Invoice 42\r\n"));
  assert(raw.includes("In-Reply-To: <x@example.test>\r\n"));
  assert(raw.includes("References: <w@example.test> <x@example.test>\r\n"));
  assert(raw.includes("Content-Transfer-Encoding: base64\r\n"));
});

Deno.test("buildRawMessage is deterministic and RFC 2047 encodes a non-ASCII subject", () => {
  const a = buildRawMessage({ to: ["a@b.test"], subject: "Héllo", text: "body" });
  const b = buildRawMessage({ to: ["a@b.test"], subject: "Héllo", text: "body" });
  assertEquals(a, b);
  const raw = atob(a.replace(/-/g, "+").replace(/_/g, "/"));
  assert(raw.includes("Subject: =?UTF-8?B?"));
  assert(!raw.includes("Date:"));
  const plain = atob(
    buildRawMessage({ to: ["a@b.test"], subject: "Plain", text: "x" }).replace(/-/g, "+").replace(
      /_/g,
      "/",
    ),
  );
  assert(plain.includes("Subject: Plain\r\n"));
});

const unb64url = (s: string) => atob(s.replace(/-/g, "+").replace(/_/g, "/"));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

/** Split a decoded multipart/mixed message into its header block and parts. */
function parts(raw: string): { head: string; parts: { head: string; body: string }[] } {
  const boundary = raw.match(/boundary="([^"]+)"/)![1];
  const [head, ...rest] = raw.split(`\r\n--${boundary}`);
  const parts = rest.filter((p) => !p.startsWith("--")).map((p) => {
    const [h, b] = p.replace(/^\r\n/, "").split("\r\n\r\n");
    return { head: h, body: b.replace(/\r\n/g, "") };
  });
  return { head, parts };
}

Deno.test("buildRawMessage with attachments: multipart/mixed, bytes round-trip, types", () => {
  const pdf = new Uint8Array(100_000).map((_, i) => (i * 31) % 256);
  const raw = unb64url(buildRawMessage({
    to: ["a@b.test"],
    subject: "Drawings",
    text: "See attached — thanks.",
    attachments: [
      { filename: "drawing-E-002.pdf", content: pdf },
      {
        filename: "notes.bin",
        content: new Uint8Array([0, 255]),
        mimeType: "application/x-custom",
      },
      { filename: "data", content: new Uint8Array([1]) },
    ],
  }));
  const m = parts(raw);
  assert(m.head.includes('Content-Type: multipart/mixed; boundary="=_gmail-api_mixed_0"'));
  assert(raw.trimEnd().endsWith("--=_gmail-api_mixed_0--"));
  assertEquals(m.parts.length, 4);
  assert(m.parts[0].head.includes("text/plain; charset=UTF-8"));
  assertEquals(new TextDecoder().decode(unb64(m.parts[0].body)), "See attached — thanks.");
  assert(m.parts[1].head.includes('Content-Type: application/pdf; name="drawing-E-002.pdf"'));
  assert(m.parts[1].head.includes('Content-Disposition: attachment; filename="drawing-E-002.pdf"'));
  assertEquals(unb64(m.parts[1].body), pdf);
  assert(m.parts[2].head.includes("Content-Type: application/x-custom;"));
  assert(m.parts[3].head.includes("Content-Type: application/octet-stream;"));
  // Without attachments the message stays single-part text/plain.
  const plain = unb64url(buildRawMessage({ to: ["a@b.test"], subject: "x", text: "y" }));
  assert(plain.includes("Content-Type: text/plain; charset=UTF-8\r\n"));
  assert(!plain.includes("multipart"));
});

Deno.test("buildRawMessage RFC 2231 encodes non-ASCII and quote-bearing filenames", () => {
  const raw = unb64url(buildRawMessage({
    to: ["a@b.test"],
    subject: "x",
    text: "y",
    attachments: [
      { filename: "Schéma.pdf", content: new Uint8Array([1]) },
      { filename: 'a"b.txt', content: new Uint8Array([1]) },
    ],
  }));
  assert(raw.includes("filename*=UTF-8''Sch%C3%A9ma.pdf"));
  assert(raw.includes("name*=UTF-8''Sch%C3%A9ma.pdf"));
  assert(raw.includes("filename*=UTF-8''a%22b.txt"));
});

Deno.test("mimeTypeFor maps common extensions, case-insensitive, else octet-stream", () => {
  assertEquals(mimeTypeFor("X.PDF"), "application/pdf");
  assertEquals(
    mimeTypeFor("model.xlsx"),
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  );
  assertEquals(mimeTypeFor("noext"), "application/octet-stream");
  assertEquals(mimeTypeFor("weird.qqq"), "application/octet-stream");
});

Deno.test("createDraft refuses attachments over 25 MB before any network call", async () => {
  const { writer, calls } = fakeGmail(WRITE, () => undefined);
  await assertRejects(
    () =>
      writer.createDraft({
        to: ["a@b.test"],
        text: "t",
        attachments: [{ filename: "big.bin", content: new Uint8Array(MAX_ATTACHMENT_BYTES + 1) }],
      }),
    Error,
    "Gmail's limit",
  );
  assertEquals(calls.filter((c) => c.path === "/drafts").length, 0);
});

Deno.test("createDraft sends attachments in the raw message, threaded when replying", async () => {
  const { writer, calls } = fakeGmail(WRITE, (c) => {
    if (c.path.startsWith("/messages/orig")) {
      return json({
        id: "orig",
        threadId: "t1",
        payload: {
          headers: [{ name: "From", value: "s@example.test" }, { name: "Subject", value: "Q" }],
        },
      });
    }
    if (c.path === "/drafts") return json({ id: "d1", message: { id: "m9", threadId: "t1" } });
  });
  await writer.createDraft({
    replyToMessageId: "orig",
    text: "attached",
    attachments: [{ filename: "a.pdf", content: new Uint8Array([37, 80, 68, 70]) }],
  });
  const body = calls.at(-1)!.body as { message: { raw: string; threadId: string } };
  assertEquals(body.message.threadId, "t1");
  const raw = unb64url(body.message.raw);
  assert(raw.includes('filename="a.pdf"'));
  assert(raw.includes("JVBERg==")); // "%PDF"
});
