// deno run --allow-net --allow-env --allow-read --allow-write examples/thread-attachments.ts <threadId> <outDir>
import {
  fetchThreadAttachments,
  FileTokenStore,
  GmailClient,
  loadClientSecretFile,
} from "../mod.ts";

const [threadId, outDir = "./attachments"] = Deno.args;
if (!threadId) {
  console.error("usage: thread-attachments.ts <threadId> [outDir]");
  Deno.exit(1);
}

const home = Deno.env.get("HOME")!;
const gmail = await GmailClient.fromStore({
  clientSecret: await loadClientSecretFile(`${home}/.simt/gmail-api/client-secret.json`),
  store: new FileTokenStore({ path: `${home}/.simt/gmail-api/credentials.json` }),
});

const manifest = await fetchThreadAttachments(gmail, threadId, { outDir, include: ["*.pdf", "*.xlsx"] });
for (const f of manifest.files) console.log(`${f.savedAs}\t${f.bytes}\t${f.sha256}`);
