/**
 * Read-only live checks against the signed-in mailbox. Needs a prior `deno task cli login`.
 * Never writes to Gmail; writes only into a temp dir.
 */
import { assert, assertEquals } from "@std/assert";
import { contextFromEnv } from "../cli/commands.ts";
import { fetchThreadAttachments, GmailClient, loadClientSecretFile } from "../mod.ts";

const ctx = contextFromEnv({});
const clientSecret = await loadClientSecretFile(ctx.clientSecretPath);
const gmail = await GmailClient.fromStore({
  clientSecret,
  store: ctx.store,
  account: ctx.account,
});

Deno.test("profile resolves to the stored account", async () => {
  const p = await gmail.profile();
  assertEquals(
    p.emailAddress.toLowerCase(),
    (await gmail.email()).toLowerCase(),
  );
});

Deno.test("a recent message with an attachment round-trips through fetch + manifest", async () => {
  const page = await gmail.listMessages(
    "has:attachment newer_than:30d smaller:2M",
    { maxResults: 1 },
  );
  const hit = page.messages?.[0];
  if (!hit) {
    throw new Error(
      "no recent small message with an attachment in this mailbox",
    );
  }
  const dir = await Deno.makeTempDir({ prefix: "gmail-api-live-" });
  try {
    const manifest = await fetchThreadAttachments(gmail, hit.threadId, {
      outDir: dir,
    });
    assert(manifest.files.length + manifest.skipped.length > 0);
    for (const f of manifest.files) {
      const stat = await Deno.stat(f.path!);
      assertEquals(stat.size, f.bytes);
      assertEquals(f.sha256?.length, 64);
    }
    await Deno.stat(`${dir}/manifest.json`);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
