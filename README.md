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

## Is this email genuine? (0.6.0)

```bash
deno task cli read --message 18c9f0a1b2d3e4f5 --links            # auth line + every link
deno task cli read --message 18c9f0a1b2d3e4f5 --headers --json   # all headers, auth, as JSON
deno task cli raw  --message 18c9f0a1b2d3e4f5 --out ./evidence   # the .eml exactly as received
```

```ts
import { authSummary, messageLinks } from "@simtricity-commons/gmail-api";

const msg = await gmail.getMessage(id, "full");
const auth = authSummary(msg); // { dkim, spf, dmarc, flags: [...warnings], notes: [...context] }
const { hosts, mismatches } = messageLinks(msg); // where the links really go
```

`auth` comes from the topmost `Authentication-Results` added by Gmail's receiving server, so a
sender cannot fake it with a header of their own. Empty `flags` means DKIM aligned with `From`,
DMARC passed and Reply-To stays on the sender's domain. It does not prove the sender is honest,
only that the mail is really from the domain it claims.

## Why did my email bounce? (0.6.0)

```bash
deno task cli read --message <bounce-id>                         # who failed, status, reason, original
deno task cli bounces --recipient someone@example.com --days 365  # that address's bounce history
```

A relay that says "not sending to previously bounced email" (`reason: "suppressed"`) is
refusing because an earlier message to the same address failed; `bounces --recipient` finds
that first failure and the remote server's reason. Gmail words any rejection by a "Send mail
as" relay as a misconfigured alias, so read the relay's own diagnostic rather than Gmail's text.

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
deno task cli draft create --reply-to 18c9f0a1b2d3e4f5 --body-file reply.txt \
  --attach drawing-E-001.pdf --attach drawing-E-002.pdf   # attachments total ≤ 25 MB
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
await w.createDraft({
  to: ["someone@example.com"],
  subject: "Drawings",
  text: "Both attached.",
  attachments: [{ filename: "drawing.pdf", content: await Deno.readFile("drawing.pdf") }], // bytes in; type from extension
});
```

For agents and interactive tools, wrap the writer in `GuardedWriter`, which is what the CLI and
agent skills built on this package use:

```ts
const g = new GuardedWriter(w, { maxIds: 25, log: { path: `${home}/.simt/gmail-api/writes.log`, via: "my-tool" } });
await g.labelChange({ name: "organiser/2026/review", ids, kind: "thread" });              // dry run: returns the plan
await g.labelChange({ name: "organiser/2026/review", ids, kind: "thread", apply: true }); // writes and logs
```

A bulk job that owns a label prefix (a classifier, say) uses the scoped methods instead. There is
no id cap, but every label it adds or removes must sit under its prefix, system labels are refused,
and the log records a hash of the ids rather than the ids:

```ts
await g.createScopedLabel("sorter/", "sorter/2026/keep");            // parents too; idempotent
const plan = await g.scopedRelabel({                                  // dry run: returns the plan
  prefix: "sorter/", add: "sorter/2026/keep", remove: ["sorter/2026/later"], ids,
});
await g.scopedRelabel({ ...plan, add: "sorter/2026/keep", remove: ["sorter/2026/later"], apply: true });
```

Reading as text: `readMessages(gmail, { threadId })` and `bodyText(msg, { maxChars })`; grouped
search: `searchThreads(gmail, q)`. The library never refuses an unbounded query on its own;
`requireDateBound(q)` is there for callers that want that rule.

Guardrails, in the library: every write checks the granted scope locally and throws
`InsufficientScopeError` before any request; `TRASH`, `SPAM` and `INBOX` are refused in any label
change unless `allowSystem: true`; there is no send, trash or delete method. In the CLI: dry run
unless `--apply`, 25 ids per call, system labels refused outright, and every applied write appends a
JSON line to `~/.simt/gmail-api/writes.log`. Vendor quirks (parents not auto-created, 409 on
duplicates, `TRASH` reachable via modify) are in `GMAIL_API_NOTES.md`.

## Organising a mailbox (0.7.0)

`@simtricity-commons/gmail-api/organise` sorts received mail into labels. Each message is decided
by fixed rules over its envelope (who sent it, through what, whether you have written to them)
together with a decision model's answers to plain-language questions about it. The default scheme
is a triage into `delete`, `defer`, `keep` and `important`, labelled `organiser/<year>/<category>`;
a profile can add schemes of your own, such as one label per project.

It only ever adds and removes labels inside a scheme's own prefix. Nothing is sent, trashed or
deleted, and `apply` is a dry run unless you pass `--apply`.

> The decision model is TypeSafe's System One API, used with your own key. Unofficial. Not
> affiliated with or endorsed by TypeSafe. Any other model can be plugged in through the `Judge`
> interface.

From a fresh `login` (the read grant is enough) to a dry run:

```bash
export TYPESAFE_API_KEY=…                           # or any secrets manager that injects it
deno task cli organise whoami                       # grants, model key, profile, data directory
deno task cli organise capture --source sent        # sent-mail metadata: who you write to
deno task cli organise corpus
deno task cli organise sample --run first --query newer_than:30d --size 50
deno task cli organise fetch  --run first
deno task cli organise judge  --run first           # one model call per message
deno task cli organise decide --run first
deno task cli organise apply  --run first           # dry run: the labels it would create and move
```

Then:

- `explain --run first --message <id>` shows the facts and answers behind one decision, and
  `find --run first --find <text>` locates a message by subject or sender.
- `rule --message <id> --is keep [--never delete] [--sender]` records your verdict. Rulings form a
  golden set that `score --run first` checks every later decide against; `--sender` also rules
  everything from that sender.
- `apply --run first --apply` writes the labels. It needs the write grant from
  `deno task cli login --write`, and every applied change is logged, ids included, in the run's
  `apply.<scheme>.log`, so it can be undone.
- `reconcile --run first` compares the labels in Gmail with the decisions, and catches a label
  moved by hand.

Every verb takes `--json`, and exits 0 when done, 1 on a usage error, 2 when a grant or the model
key is missing, 3 when `score` finds a critical failure, 4 when `reconcile` finds a mismatch, and
5 when a stage finished with failures (re-run it to resume). `organise --help` lists every option.

State lives in `~/.simt/gmail-api/organise` (`GMAIL_ORGANISE_DATA` to move it): the profile,
rulings, sent-mail capture and one directory per run. With no `profile.json` you get the default
triage; `examples/organise/profile.json` is a starting point. Gmail reads are paced at 4 a second,
within the per-user quota. `examples/organise-triage.ts` drives the same steps from code; the
library reads no environment, so every path, client and key is passed in.

## Setup

1. Google Cloud Console → APIs & Services → Credentials → **OAuth client ID, type Desktop app** →
   download JSON to `~/.simt/gmail-api/client-secret.json` (or point `GMAIL_CLIENT_SECRET_PATH` at
   it). Enable the Gmail API on the project.
2. `deno task cli login`. Loopback callback binds `127.0.0.1:8731` (`GMAIL_API_LOOPBACK_PORT` to
   change). Set `GMAIL_NO_BROWSER=1` on a headless box and open the printed URL yourself.
3. Credentials land in `~/.simt/gmail-api/credentials.json`, mode 0600, one entry per mailbox.
   `GMAIL_API_CREDENTIALS` overrides the path.
4. Sign-in events (logins, logouts, refresh retries and failures, never tokens) are appended to
   `~/.simt/gmail-api/auth.log` (`GMAIL_API_AUTH_LOG` to move it). If a command says the sign-in
   was rejected, `deno task cli whoami` shows when you signed in and the last refresh failure,
   and the log has the history.

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
