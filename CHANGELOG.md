# Changelog

All notable changes to `@simtricity-commons/gmail-api`. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow SemVer.

## [0.6.0] - 2026-10-04

Reading a message now shows where it really came from, where its links go, and, for a bounce,
who failed and why. Checking a suspected phishing email or a failed send needs no custom code.

### Added

- **Authentication summary** (`lib/headers.ts`): `authSummary(msg)` reports DKIM (result, signing
  domain, selector), SPF (result, envelope sender) and DMARC (result, published policy) from the
  **topmost** `Authentication-Results` written by `mx.google.com`, ignoring any lower copy a sender
  could have forged. `flags` are warnings (`dkim-fail`, `dkim-not-aligned`, `spf-fail`,
  `dmarc-fail`, `dmarc-none`, `reply-to-other-domain`, `no-authentication-results`); `notes` are
  context that is normal on its own (`return-path-other-domain`, `dmarc-policy-none`).
- `parseAuthenticationResults(value)` (RFC 8601, also takes the ARC form), `allHeaders(msg)`,
  `provenanceHeaders(msg)`, `addressDomain()`, and `orgDomain()` (approximate organisational
  domain without a Public Suffix List).
- **Links** (`lib/links.ts`): `messageLinks(msg)` returns every `href` from the HTML part, taken
  before tags are stripped (bare URLs from plain text when there is no HTML), a host → count
  summary, and `mismatch` where the visible text names a different organisation from the
  target. `extractHtmlLinks()` and `extractTextLinks()` are exported.
- `readMessage` / `readMessages` always include `auth`; `{ headers: true }` adds every header and
  `{ links: true }` adds the links.
- `rawMessage(gmail, id)`: the message exactly as received (RFC 5322 bytes).
- **Bounces** (`lib/bounce.ts`): `parseBounce(msg)` reads RFC 3464 delivery status reports,
  including Gmail's layout (per-message fields as part headers, per-recipient fields in a child
  part) and relays that write free-text `Final-Recipient` or a bare `550` status, with a
  plain-text fallback for notices that carry no report. Each recipient gets action, enhanced
  status, severity, remote server, the server's own words and a `reason` (`no-such-user`,
  `suppressed`, `mailbox-full`, `domain-not-found`, `policy`, `temporary`, `other`). The original
  message's From/To/Cc/Subject/Message-ID come from the returned headers. `isBounce()`,
  `bounceReason()`, `BOUNCE_QUERY`, and `findBounces(gmail, { recipient, days })` to search the
  mailbox for a recipient's bounce history.
- `readMessage` adds `bounce` when the message is a delivery failure notice.
- CLI: `read` prints a one-line DKIM/SPF/DMARC summary with flags, plus the bounce details for a
  bounce; `read --headers` and `read --links`; `raw --message <id> --out <dir>` saves
  `<id>.eml` (mode 0600) with its sha256; `bounces [--recipient <addr>] [--days N]` lists
  delivery failures grouped by recipient, oldest cause last.

## [0.5.0] - 2026-10-02

Drafts can carry file attachments.

### Added

- **Draft attachments**: `DraftInput.attachments` takes `{ filename, content: Uint8Array,
  mimeType? }[]`. `buildRawMessage` then emits `multipart/mixed` (text part first, each file a
  base64 `Content-Disposition: attachment` part); without attachments the message is unchanged
  single-part `text/plain`. Non-ASCII or quote-bearing filenames are RFC 2231 encoded. The
  library takes bytes only and never reads paths.
- `mimeTypeFor(filename)`: MIME type by extension (PDF, images, Office, CSV, DWG/DXF …), else
  `application/octet-stream`.
- `MAX_ATTACHMENT_BYTES` (25 MB, Gmail's send limit): `createDraft` refuses a larger total before
  any network call.
- CLI: `draft create --attach <path>` (repeatable) and `--body-file <path>` (instead of `--body`).

### Changed

- `GuardedWriter.createDraft` log lines include `attachments: [{ filename, bytes }]` when files
  are attached. Content is never logged.
- base64 encoding is chunked, so multi-MB attachments encode quickly.

## [0.4.0] - 2026-09-27

The library is now the home of all Gmail logic, so CLIs and agent skills built on it can be thin wrappers.

### Added

- **Body text** (`lib/body.ts`): `bodyText(msg, { maxChars })` returns the first non-attachment
  `text/plain` part, else stripped `text/html`, else the snippet, with `source` and
  `truncatedChars`. `readMessage` / `readMessages(gmail, { threadId | messageId })` add headers,
  labels and non-inline attachment names. `stripHtml` exported.
- **Thread-grouped search** (`lib/search.ts`): `searchThreads(gmail, q, { maxResults, pageToken })`
  returns per-thread message count, latest date, distinct senders, subject, attachment filenames
  and message ids, plus `hasMore` / `nextPageToken`. Opt-in `requireDateBound(q)` /
  `hasDateBound(q)` with `UnboundedQueryError`; the library never applies it itself.
- **`GuardedWriter`** (`lib/guarded.ts`): one policy layer for interactive and agent writes over
  `GmailWriter`. Configurable id cap (default 25), system labels refused, plan-then-apply label
  changes (`labelChange({ …, apply })` is a dry run unless `apply`), idempotent `createLabel`,
  `createDraft` returning a Gmail link and `sent: false`. Refusals throw `WriteGuardError` with a
  `code`. Applied writes append one JSON line to a caller-given log path, tagged with the
  caller's `via` and the mailbox.
- CLI: `read --thread|--message [--max-chars N]`; `search --threads` for grouped results.

### Changed

- CLI write commands now go through `GuardedWriter`. **`writes.log` line shape standardised**
  on `{at, via, account, op, label, kind, ids, count}` for label changes (was
  `messageIds`/`threadIds`, no `via`); the CLI records `via: "gmail-api-cli"`. Earlier lines are
  left as written.
- No new dependencies: `lib/` still imports only `globToRegExp`, `join`, `resolve`, `dirname`
  from `@std/path`.

## [0.3.0] - 2026-09-22

### Added — first release that can write to a mailbox (labels and drafts only)

- **`GmailWriter`** (`lib/writes.ts`), separate from the read client. Needs a credential granted
  with `SCOPES_WRITE` = `gmail.readonly` + `gmail.modify` + `gmail.compose`. Every method checks the
  granted scope locally and throws `InsufficientScopeError` before any request.
- Labels: `createLabel`, `ensureLabel` (creates missing parents of a nested name in order; 409 is
  treated as "exists"), `updateLabel`, `deleteLabel`, `listLabels`/`findLabel`.
- Messages: `modifyMessage`, `batchModifyMessages` (chunked at 1000, empty no-op), `modifyThread`.
  `TRASH`, `SPAM`, `INBOX` are refused unless `allowSystem: true`.
- Drafts: `createDraft` (plain text; reply mode sets threadId, In-Reply-To, References, To and
  `Re:`), `deleteDraft`. **No send, trash or delete method exists.**
- `GmailClient.request()` low-level transport (401 refresh-and-retry, 204 → undefined),
  `grantedScopes()`, and a `fetch` option for tests. `GmailApiError.reason` (`rateLimitExceeded`
  vs `insufficientPermissions` are both 403). `buildRawMessage`, `toBase64Url`.
- CLI: `login --write` stores the write grant in `~/.simt/gmail-api/credentials.modify.json`
  (`GMAIL_API_CREDENTIALS_MODIFY`), leaving `credentials.json` untouched; `whoami [--write]` reports
  the grant; `labels`; `label create|apply|remove` (dry run unless `--apply`, max 25 ids, system
  labels refused); `draft create`. Applied writes append to `~/.simt/gmail-api/writes.log`.
- Tests: 7 offline writer tests with injected fetch; opt-in self-cleaning live write test
  (`GMAIL_API_LIVE_WRITE=1 deno task test:live:write`).
- `SPEC-write-support.md` (decision record) and write-side quirks in `GMAIL_API_NOTES.md`.

### Changed

- `get()` now delegates to `request()`; read behaviour unchanged (live read tests pass unmodified).

## [0.2.1] - 2026-09-03

### Changed

- JSDoc on every exported symbol and member (was 59% on JSR's score). No code changes.

## [0.2.0] - 2026-09-03

### Added

- `skipExisting?: boolean | string` on `FetchAttachmentsOptions`. Skips attachments already present
  on disk, matched on (filename, byte size) so nothing is downloaded to decide, and quotes the
  sha256 from a prior `manifest.json` in the skip reason when one exists. Applied after the
  `include`/`filenames`/`includeInline`/`maxBytes` rules, so a glob-excluded file is never reported
  as "already present".
- `scanExisting(dir)` and `makeSelector(opts, existing)` exported so callers can preview skip
  decisions without a client.
- CLI: `attachments fetch --skip-existing [dir]` (bare flag means `--out`).

### Changed

- `Manifest.skipped` doc now covers the `already in <dir>` reason.
- `deno task test` grants `--allow-read --allow-write` for the temp-dir test; still offline.

## [0.1.0] - 2026-09-03

### Added

- Initial release. Typed Gmail REST client with loopback OAuth (PKCE) for a Desktop-app client,
  read-only scope by default, `FileTokenStore` under `~/.simt/gmail-api/`.
- Thread- and message-level attachment download with sha256 manifest.
- CLI: `login`, `logout`, `whoami`, `accounts`, `search`, `attachments list|fetch`, `--json` on
  every command.

[0.2.1]: https://github.com/simtricity/commons-gmail-api/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/simtricity/commons-gmail-api/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/simtricity/commons-gmail-api/releases/tag/v0.1.0
