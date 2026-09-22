/**
 * Opt-in live write test. Runs only with GMAIL_API_LIVE_WRITE=1 and a prior `login --write`.
 * Touches only labels under `gmail-api-test/<uuid>` and one draft; everything is removed in
 * `finally`. Never trashes, never sends.
 *   GMAIL_API_LIVE_WRITE=1 deno task test:live:write
 */
import { assert, assertEquals } from "@std/assert";
import { contextFromEnv } from "../cli/commands.ts";
import { GmailClient, GmailWriter, loadClientSecretFile } from "../mod.ts";

const enabled = Deno.env.get("GMAIL_API_LIVE_WRITE") === "1";

Deno.test({
  name: "label create/apply/remove/delete and draft create/delete round-trip, self-cleaning",
  ignore: !enabled,
  async fn() {
    const ctx = contextFromEnv({ write: true });
    const gmail = await GmailClient.fromStore({
      clientSecret: await loadClientSecretFile(ctx.clientSecretPath),
      store: ctx.store,
      account: ctx.account,
    });
    const w = new GmailWriter(gmail);
    const root = `gmail-api-test/${crypto.randomUUID().slice(0, 8)}`;
    const created: string[] = [];
    let draftId: string | undefined;
    try {
      const leaf = await w.ensureLabel(`${root}/leaf`);
      const all = await w.listLabels(true);
      for (const l of all) if (l.name.startsWith(root)) created.push(l.id);
      assertEquals(created.length, 2, "root and leaf both created");
      assert((await w.ensureLabel(`${root}/leaf`)).id === leaf.id, "idempotent");

      const hit = (await gmail.listMessages("newer_than:30d -in:chats", { maxResults: 1 })).messages
        ?.[0];
      assert(hit, "need one recent message to label");
      await w.batchModifyMessages([hit.id], { addLabelIds: [leaf.id] });
      assert((await gmail.getMessage(hit.id, "minimal")).labelIds?.includes(leaf.id));
      await w.modifyMessage(hit.id, { removeLabelIds: [leaf.id] });
      assert(!(await gmail.getMessage(hit.id, "minimal")).labelIds?.includes(leaf.id));

      const d = await w.createDraft({
        replyToMessageId: hit.id,
        text: "gmail-api live test draft — will be deleted",
      });
      draftId = d.id;
      assertEquals(d.message.threadId, hit.threadId);
    } finally {
      if (draftId) await w.deleteDraft(draftId);
      for (const id of created.reverse()) await w.deleteLabel(id);
    }
  },
});

if (!enabled) console.error("live write test skipped: set GMAIL_API_LIVE_WRITE=1 to run");
