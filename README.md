# @simtricity-commons/gmail-api

Typed Deno client + CLI for the Gmail REST API. Loopback OAuth (PKCE) for a Google "Desktop app"
client, **read-only by default**, and thread-level attachment download with a sha256 manifest — the
thing the hosted Gmail connectors don't do.

> Unofficial. Not affiliated with or endorsed by Google. Gmail is a trademark of Google LLC. ©
> Simtricity Limited, MIT.

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
deno task cli attachments list  --thread 18c9f0a1b2d3e4f5
deno task cli attachments fetch --thread 18c9f0a1b2d3e4f5 --out ./july-invoices --include '*.pdf' --include '*.xlsx'
deno task cli attachments fetch --thread 18c9f0a1b2d3e4f5 --out ./july-invoices --skip-existing   # re-run: only what's new
deno task cli logout                     # revokes at Google, then deletes locally
```

Add `--json` to any command for machine-readable output. `--account <email>` picks a mailbox when
more than one is signed in.

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
- Scopes are a login option defaulting to `gmail.readonly`. The `GmailClient` only issues GETs, so a
  wider scope buys nothing here — write support would be new code, on purpose.
- Attachment ids are ephemeral. `listAttachments` output is fetch-then-use; never persist an id.
- Filenames are written as sent (Gmail's `(1)` suffixes included); only path separators and control
  characters are replaced, and collisions get `(2)`, `(3)`….
- `logout` deletes the local credential even if the revoke call fails, and says so.
