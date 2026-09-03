import { assertEquals, assertThrows } from "@std/assert";
import {
  buildAuthUrl,
  decodeBase64Url,
  disambiguate,
  listAttachments,
  makeSelector,
  MemoryTokenStore,
  type Message,
  parseClientSecret,
  parseGmailId,
  safeBasename,
  scanExisting,
  SCOPE_READONLY,
  sha256Hex,
  summarize,
} from "../mod.ts";

const fixture: Message = {
  id: "18c9f0a1b2d3e4f5",
  threadId: "18c9f0a1b2d3e4f5",
  snippet: "Hi team, body text that must not leak",
  payload: {
    mimeType: "multipart/mixed",
    headers: [
      { name: "From", value: "invoices@supplier.example" },
      { name: "Subject", value: "Acme ESA July 2026" },
      { name: "Date", value: "Fri, 21 Aug 2026 13:03:03 +0100" },
    ],
    parts: [
      {
        mimeType: "multipart/related",
        parts: [
          { mimeType: "text/html", body: { size: 10, data: "PGI-aGk8L2I-" } },
          {
            mimeType: "image/png",
            filename: "image001.png",
            headers: [
              {
                name: "Content-Disposition",
                value: "inline; filename=image001.png",
              },
              { name: "Content-ID", value: "<img1>" },
            ],
            body: { attachmentId: "ATT-INLINE", size: 1234 },
          },
        ],
      },
      {
        mimeType: "application/pdf",
        filename: "Acme GESA July 2026-export-INV-0409 (1).pdf",
        headers: [{ name: "Content-Disposition", value: "attachment" }],
        body: { attachmentId: "ATT-PDF", size: 98765 },
      },
      {
        mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        filename: "Acme GESA July 2026 (1).xlsx",
        body: { attachmentId: "ATT-XLSX", size: 45678 },
      },
    ],
  },
};

Deno.test("listAttachments walks nested parts and flags inline CID images", () => {
  const refs = listAttachments(fixture);
  assertEquals(refs.map((r) => r.filename), [
    "image001.png",
    "Acme GESA July 2026-export-INV-0409 (1).pdf",
    "Acme GESA July 2026 (1).xlsx",
  ]);
  assertEquals(refs.map((r) => r.inline), [true, false, false]);
  assertEquals(refs[1].messageId, "18c9f0a1b2d3e4f5");
  assertEquals(refs[2].mimeType.endsWith("sheet"), true);
});

Deno.test("summarize carries headers and attachments but never the snippet", () => {
  const s = summarize(fixture);
  assertEquals(s.subject, "Acme ESA July 2026");
  assertEquals(s.from, "invoices@supplier.example");
  assertEquals(s.attachments.length, 3);
  assertEquals(JSON.stringify(s).includes("must not leak"), false);
});

Deno.test("decodeBase64Url tolerates missing padding", async () => {
  const bytes = decodeBase64Url("aGVsbG8gd29ybGQ"); // "hello world" without '='
  assertEquals(new TextDecoder().decode(bytes), "hello world");
  assertEquals(
    await sha256Hex(bytes),
    "b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9",
  );
});

Deno.test("parseGmailId accepts hex ids and legacy URLs, rejects FMfcgz tokens", () => {
  assertEquals(parseGmailId("18c9f0a1b2d3e4f5"), "18c9f0a1b2d3e4f5");
  assertEquals(parseGmailId(" 18C9F0A1B2D3E4F5 "), "18c9f0a1b2d3e4f5");
  assertEquals(
    parseGmailId("https://mail.google.com/mail/u/0/#inbox/18c9f0a1b2d3e4f5"),
    "18c9f0a1b2d3e4f5",
  );
  assertThrows(() => parseGmailId("https://mail.google.com/mail/u/0/#inbox/FMfcgzQcpxLmSw"));
  assertThrows(() => parseGmailId("not-an-id"));
});

Deno.test("safeBasename and disambiguate", () => {
  assertEquals(safeBasename("../evil/../x.pdf"), ".._evil_.._x.pdf");
  assertEquals(safeBasename(""), "attachment");
  assertEquals(
    safeBasename("Acme GESA July 2026 (1).xlsx"),
    "Acme GESA July 2026 (1).xlsx",
  );
  const taken = new Set(["a.pdf", "a (2).pdf"]);
  assertEquals(disambiguate("a.pdf", taken), "a (3).pdf");
  assertEquals(disambiguate("b.pdf", taken), "b.pdf");
  assertEquals(disambiguate("noext", new Set(["noext"])), "noext (2)");
});

Deno.test("parseClientSecret accepts installed/web/bare shapes and hides contents on error", () => {
  const s = parseClientSecret(
    JSON.stringify({ installed: { client_id: "id", client_secret: "sec" } }),
  );
  assertEquals(s, { clientId: "id", clientSecret: "sec" });
  assertEquals(
    parseClientSecret('{"web":{"client_id":"a","client_secret":"b"}}').clientId,
    "a",
  );
  assertEquals(
    parseClientSecret('{"client_id":"a","client_secret":"b"}').clientSecret,
    "b",
  );
  const err = assertThrows(() => parseClientSecret('{"client_id":"leaked"}', "/p/secret.json"));
  assertEquals((err as Error).message.includes("leaked"), false);
});

Deno.test("buildAuthUrl requests exactly the scopes given, offline, with PKCE S256", () => {
  const url = new URL(buildAuthUrl({
    clientId: "cid",
    redirectUri: "http://127.0.0.1:8731/callback",
    challenge: "chal",
    state: "st",
    scopes: [SCOPE_READONLY],
  }));
  assertEquals(url.searchParams.get("scope"), SCOPE_READONLY);
  assertEquals(url.searchParams.get("access_type"), "offline");
  assertEquals(url.searchParams.get("code_challenge_method"), "S256");
  assertEquals(
    url.searchParams.get("redirect_uri"),
    "http://127.0.0.1:8731/callback",
  );
});

Deno.test("MemoryTokenStore: first save becomes default, keys are case-insensitive", async () => {
  const store = new MemoryTokenStore();
  const cred = {
    refreshToken: "r",
    accessToken: "a",
    accessTokenExpiresAt: new Date().toISOString(),
    email: "Ops@Example.com",
    scope: SCOPE_READONLY,
    savedAt: new Date().toISOString(),
  };
  await store.save(cred);
  assertEquals((await store.load())?.email, "Ops@Example.com");
  assertEquals((await store.load("ops@example.com"))?.email, "Ops@Example.com");
  assertEquals(await store.list(), ["ops@example.com"]);
});

Deno.test("makeSelector: skipExisting applies after include/inline/maxBytes and quotes prior sha256", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await Deno.writeFile(`${dir}/invoice.pdf`, new Uint8Array(100));
    await Deno.writeFile(`${dir}/stale.pdf`, new Uint8Array(7)); // wrong size → refetch
    await Deno.writeTextFile(
      `${dir}/manifest.json`,
      JSON.stringify({
        files: [{ savedAs: "invoice.pdf", sha256: "abcdef0123456789ff" }],
      }),
    );
    const existing = await scanExisting(dir);
    assertEquals(existing.sizes.get("invoice.pdf"), 100);
    assertEquals(existing.sizes.has("manifest.json"), false);

    const ref = (filename: string, size: number, inline = false) => ({
      messageId: "m1",
      attachmentId: "a",
      mimeType: "application/pdf",
      filename,
      size,
      inline,
    });
    const skip = makeSelector({
      outDir: dir,
      include: "*.pdf",
      skipExisting: true,
    }, existing);
    assertEquals(
      skip(ref("invoice.pdf", 100)),
      `already in ${existing.dir} (sha256 abcdef012345…)`,
    );
    assertEquals(skip(ref("stale.pdf", 100)), null); // size differs → fetch
    assertEquals(skip(ref("sheet.xlsx", 5)), "no --include match"); // glob first, not "already present"
    assertEquals(skip(ref("logo.png", 3, true)), "inline");

    const noSha = makeSelector({ outDir: dir, skipExisting: true }, {
      ...existing,
      sha256: new Map(),
    });
    assertEquals(
      noSha(ref("invoice.pdf", 100)),
      `already in ${existing.dir} (name + size match)`,
    );

    const missing = await scanExisting(`${dir}/does-not-exist`);
    assertEquals(missing.sizes.size, 0);
    assertEquals(
      makeSelector({ outDir: dir, skipExisting: true }, missing)(
        ref("invoice.pdf", 100),
      ),
      null,
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
