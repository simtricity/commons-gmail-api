# @simtricity-commons/gmail-api

Typed Deno client + CLI for the Gmail REST API. Loopback OAuth (PKCE) for a Google "Desktop app"
client, **read-only by default**, thread-level attachment download with a sha256 manifest, and —
behind a separate, opt-in grant — labels and drafts. Never send, trash or delete.

> Unofficial. Not affiliated with or endorsed by Google. Gmail is a trademark of Google LLC. ©
> Simtricity Limited, MIT.
>
> [Changelog](https://github.com/simtricity/commons-gmail-api/blob/main/CHANGELOG.md) · [Issues](https://github.com/simtricity/commons-gmail-api/issues)

```ts
import {
  fetchThreadAttachments,
  FileTokenStore,
  GmailClient,
  loadClientSecretFile,
} from "@simtricity-commons/gmail-api";

const home = Deno.env.get("HOME")!;
const gmail = await GmailClient.fromStore({
  clientSecret: await loadClientSecretFile(
    `${home}/.simt/gmail-api/client-secret.json`,
  ),
  store: new FileTokenStore({
    path: `${home}/.simt/gmail-api/credentials.json`,
  }),
});

const manifest = await fetchThreadAttachments(gmail, "18c9f0a1b2d3e4f5", {
  outDir: "./out",
  include: "*.pdf",
  skipExisting: true, // name + size match against ./out; nothing downloaded to decide
});
```

## CLI

```bash
deno task cli login                      # browser sign-in, gmail.readonly only
deno task cli whoami
deno task cli search -q 'from:supplier.example has:attachment newer_than:90d'
deno task cli search -q 'from:supplier.example newer_than:90d' --threads   # grouped by thread
deno task cli read --thread 18c9f0a1b2d3e4f5 --max-chars 4000             # bodies as text
deno task cli attachments list  --thread 18c9f0a1b2d3e4f5
deno task cli attachments fetch --thread 18c9f0a1b2d3e4f5 --out ./july-invoices --include '*.pdf' --include '*.xlsx'
deno task cli attachments fetch --thread 18c9f0a1b2d3e4f5 --out ./july-invoices --skip-existing   # re-run: only what's new
deno task cli logout                     # revokes at Google, then deletes locally
```

Add `--json` to any command for machine-readable output. `--account <email>` picks a mailbox when
more than one is signed in.

## Writes: labels and drafts (0.3.0, opt-in)

Writing needs a second grant and a separate import. The read-only credential is never widened.

```bash
deno task cli login --write     # consents to gmail.modify + gmail.compose; stored in credentials.modify.json
deno task cli whoami --write    # proves the write grant; non-zero if absent
deno task cli labels
deno task cli label create organiser/2026/review          # creates parents too; idempotent
deno task cli label apply organiser/2026/review --ids 18c9…,18ca…          # dry run
deno task cli label apply organiser/2026/review --ids 18c9…,18ca… --apply  # ≤ 25 ids per call
deno task cli draft create --reply-to 18c9f0a1b2d3e4f5 --body "Thanks, received."
```

```ts
import { GmailClient, GmailWriter, FileTokenStore, loadClientSecretFile } from "@simtricity-commons/gmail-api";

const gmail = await GmailClient.fromStore({
  clientSecret: await loadClientSecretFile(`${home}/.simt/gmail-api/client-secret.json`),
  store: new FileTokenStore({ path: `${home}/.simt/gmail-api/credentials.modify.json` }),
});
const w = new GmailWriter(gmail);
const label = await w.ensureLabel("organiser/2026/review");
await w.batchModifyMessages(ids, { addLabelIds: [label.id] }); // chunks at 1000, any length
const draft = await w.createDraft({ replyToMessageId: id, text: "Thanks, received." }); // not sent
```

For agents and interactive tools, wrap the writer in `GuardedWriter`, which is what the CLI and
the `simt:gmail` skill use:

```ts
const g = new GuardedWriter(w, { maxIds: 25, log: { path: `${home}/.simt/gmail-api/writes.log`, via: "my-tool" } });
await g.labelChange({ name: "organiser/2026/review", ids, kind: "thread" });              // dry run: returns the plan
await g.labelChange({ name: "organiser/2026/review", ids, kind: "thread", apply: true }); // writes and logs
```

Reading as text: `readMessages(gmail, { threadId })` and `bodyText(msg, { maxChars })`; grouped
search: `searchThreads(gmail, q)`. The library never refuses an unbounded query on its own;
`requireDateBound(q)` is there for callers that want that rule.

Guardrails, in the library: every write checks the granted scope locally and throws
`InsufficientScopeError` before any request; `TRASH`, `SPAM` and `INBOX` are refused in any label
change unless `allowSystem: true`; there is no send, trash or delete method. In the CLI: dry run
unless `--apply`, 25 ids per call, system labels refused outright, and every applied write appends a
JSON line to `~/.simt/gmail-api/writes.log`. Vendor quirks (parents not auto-created, 409 on
duplicates, `TRASH` reachable via modify) are in `GMAIL_API_NOTES.md`; the decision record is
`SPEC-write-support.md`.

## Setup

1. Google Cloud Console → APIs & Services → Credentials → **OAuth client ID, type Desktop app** →
   download JSON to `~/.simt/gmail-api/client-secret.json` (or point `GMAIL_CLIENT_SECRET_PATH` at
   it). Enable the Gmail API on the project.
2. `deno task cli login`. Loopback callback binds `127.0.0.1:8731` (`GMAIL_API_LOOPBACK_PORT` to
   change). Set `GMAIL_NO_BROWSER=1` on a headless box and open the printed URL yourself.
3. Credentials land in `~/.simt/gmail-api/credentials.json`, mode 0600, one entry per mailbox.
   `GMAIL_API_CREDENTIALS` overrides the path.

## Design notes

- `lib/` never reads env. All paths, ports and secrets are passed in; `cli/` is the only layer that
  consults `Deno.env`.
- `TokenStore` is an interface. `FileTokenStore` is a plain persistent file; callers with a
  TTL/sweep policy or a keychain implement their own.
- Scopes are a login option defaulting to `gmail.readonly`. `GmailClient` only issues GETs; writes
  live on `GmailWriter`, need `SCOPES_WRITE` at login, and are stored in a separate credential file.
- Attachment ids are ephemeral. `listAttachments` output is fetch-then-use; never persist an id.
- Filenames are written as sent (Gmail's `(1)` suffixes included); only path separators and control
  characters are replaced, and collisions get `(2)`, `(3)`….
- `logout` deletes the local credential even if the revoke call fails, and says so.
