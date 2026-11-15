# Changelog

All notable changes to `@simtricity-commons/gmail-api`. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow SemVer.

## [0.8.1] - 2026-11-15

### Fixed

- **`updateDraft` dropped To, Cc and Bcc when a caller passed empty lists.** Argument parsers can
  hand over `[]` for an absent repeatable flag (the `simt:gmail` skill's does), and `[]` was read
  as "replace with nothing", so the edited draft lost its recipients. An absent or empty `to`,
  `cc` or `bcc` now keeps the draft's own header; a non-empty one replaces it whole. Recipients
  on an edit come only from the draft's headers, never from the original.
- **Replying to your own message sent only to yourself** (a note to yourself, a send-as alias)
  threw "no recipients", because removing your own addresses left nothing. Reply-all now
  addresses the original's To as written in that case; Cc keeps the self filter and Bcc is still
  never computed.
- **A plain reply to your own message** went back to you (its From). It now goes where Gmail
  sends it: the original's To without you, or its To as written when it went only to you.
  `replyRecipients()` is exported. Working out whether the original is yours costs a plain
  reply one profile read and one send-as read, unless `to` is given.

## [0.8.0] - 2026-11-15

### Added

- **Quoted history in replies.** `DraftInput.quote` (default on with `replyToMessageId`) puts
  `On <Date>, <From> wrote:` and the original under the reply, in Gmail's `gmail_quote` markup.
  The quote is the original's text, HTML-escaped, capped at `QUOTE_MAX_CHARS` (100,000) with a
  marker; none of the original's HTML is carried. `quoteBlock()` and `attribution()` are exported.
- **HTML bodies.** `DraftInput.html` is sent as given, as `multipart/alternative` with `text`;
  with files it nests in `multipart/mixed`.
- **One composer.** `composeBody({ text, html?, signature?, tail? })` assembles every draft body
  (new text, signature, then a quote or forwarded block); `escapeHtml` and `textToHtml` helpers.
- **Reply-all.** `DraftInput.replyAll`: Gmail's rules, your own addresses (profile and every
  send-as) removed, never a computed Bcc; a given `to` replaces, a given `cc` adds. Needs
  `replyToMessageId` (a `TypeError` before any request). `splitAddresses`, `bareAddress`,
  `replyAllRecipients` and `addRecipients` are exported.
- **Signatures.** `DraftInput.signature` adds the default send-as's signature (else the
  primary's) above any quote. `scrubSignatureHtml()` strips script and style (repeated until
  stable), event handlers and `javascript:`/`vbscript:` URLs, and escapes any `<` that does not
  open a well-formed tag; images are kept. `signatureBlock()` is exported.
- `GmailClient.listSendAs()`, `GmailClient.listDrafts({ max, q })` (read-only),
  `GmailClient.getDraft()`; `SendAs` and `DraftSummary` types.
- `GmailWriter.buildDraft()` builds the message `createDraft` would post and reports what went
  into it, writing nothing; `postDraft()` writes it.
- **Forward.** `GuardedWriter.forwardDraft({ messageId, to, … })` and
  `GmailWriter.buildForward()`: `Fwd:` subject, Gmail's forwarded-message block, the original's
  thread and threading headers (as Gmail's own Forward writes them), and its files
  (`attachments: "all" | "none" | names`; an unknown name throws before any download). Inline
  images are reported in `skippedInline`. `forwardBlock`, `forwardSubject` and
  `FORWARD_MARKER` are exported.
- **Edit.** `GuardedWriter.updateDraft({ draftId, … })` and `GmailWriter.buildUpdate()` /
  `putDraft()`: anything not given is kept (recipients, subject, threading, the body parts,
  every file byte for byte, with sha256 in the result). A new body regenerates the quote from the
  original in the thread; old quote text is never parsed back. `expectMessageId`, plus a re-read
  just before the write, refuse a draft edited elsewhere.
- **Carrying files.** `carryAttachments(client, message, { select, addedBytes, limit })` returns a
  message's regular files as bytes with sha256; the declared sizes are checked before anything
  is downloaded. `fileRefs()` and `existingBody()` are exported.
- New errors: `AttachmentLimitError { totalBytes, limit }`, `DraftNotEditableError { draftId,
  reason: "inline_parts" | "download_failed" }`, `DraftChangedError { draftId, expected, actual }`.
- Guard results: `createDraft` returns `recipients`, `quoted` and `signature`; forward and update
  return their own summaries. The write log adds recipient counts, file counts and sha256, never
  addresses or filenames (`draft.forward` and `draft.update` ops).
- CLI: `draft create` gains `--html-file`, `--bcc`, `--reply-all`, `--signature`, `--no-quote`
  and prints To, Cc and Bcc; new `draft forward`, `draft update` and `drafts`.

### Changed

- `createDraft` on a reply now quotes the original by default (pass `quote: false` for the old
  output) and reads it in `full` format when quoting.
- A plain reply splits the original's Reply-To/From into one recipient per address.
- `MAX_ATTACHMENT_BYTES` moved to `lib/carry.ts` (still exported from the root). The size refusal
  in `createDraft` is now an `AttachmentLimitError` (an `Error`, same message wording).

## [0.7.0] - 2026-11-15

### Added

- **Scoped bulk relabels on `GuardedWriter`**: `createScopedLabel(prefix, name)`,
  `planScopedRelabel(req)` and `scopedRelabel({ prefix, add, remove, ids, apply })` for bulk
  jobs that own a label prefix. No id cap; applied in chunks of `BATCH_MODIFY_MAX`. Every label
  added or removed must start with the prefix. Refusals, all before any request, in this order:
  `bad-scope` (prefix empty or not ending in `/`), `outside-scope`, `system-label`,
  `no-such-label` (`add` missing). Dry run unless `apply`. `remove` names that do not exist are
  skipped, and `add` is never also removed. Nothing to do is a no-op with no request and no
  log line.
- An applied scoped relabel appends one `label.relabel` line to the write log with `prefix`,
  `add`, `remove`, `count` and `idsSha256` (sha256 of the sorted ids joined by a newline) in
  place of the ids. `idsSha256(ids)` is exported so a caller can match its own id list to the log.
- If a chunk fails part-way (a quota refusal, a dropped connection), the line is still written
  before the error is rethrown, with `partial: true`, `callsDone` (chunks applied, in `ids`
  order) and `error` (class name and HTTP status, never the body).
- `ScopedRelabelRequest`, `ScopedRelabelPlan` and `ScopedRelabelResult` types.
- **Organise engine** at the new `./organise` entry point (`@simtricity-commons/gmail-api/organise`):
  envelope reading, the sent-mail correspondent corpus and relationships, the sender policy,
  sampling, throttling, golden-set parsing and the `decide` triage routes with
  `DEFAULT_THRESHOLDS` and `mergeThresholds`. The root entry point does not import it.
  `./organise` also re-exports the core `Message`, `MessagePart`, `MessagePartBody` and
  `MessagePartHeader` types its functions take. Every exported symbol is documented.
- The organise test fixtures use only reserved domains (`.example`, `.test`).
- **Schemes** (`./organise`): `Scheme`, `labelFor` and `labelPrefixOf`, and `triageScheme()`,
  the four-verdict engine as a scheme. It decides exactly as `decide()` with the engine's own
  routes and default thresholds, and labels by each message's own UTC year.
- `TRIAGE_DEFAULT_QUESTIONS`: generic wording for the eight triage questions, so triage runs
  with no question file. One phrase in `carries_private_data` reads "data exports" rather
  than an industry-specific term; wording is overridable per question.
- `choiceScheme()`: a declarative scheme over one Choice question; the winning option is the
  category, sender rulings decide first, and an unanswered message goes to an unlabelled option.
- `parseProfile()` and `ProfileError`: a JSON profile naming the schemes to run. Every field has a
  default and an absent `schemes` means generic triage, so `{}` is a working profile. Label
  prefixes that nest and questions defined two ways are refused.
- `questionsFor()`, `questionHash()` and `pendingQuestions()`: all schemes' questions in one model
  call per message, and answers stored with the hash they were asked under, so rewording one
  question re-asks only it.
- Golden sets per scheme: `parseGolden(raw, categories?)` fills in each case's scheme, `score()`
  scores one scheme, and `withRuling()` / `withSenderRuling()` record rulings without mutating.
- `relabelPlan()`: decisions into batched label changes, each adding one label and removing the
  scheme's others for that year in the same call.
- `SystemOneJudge` behind a `Judge` interface: a client for TypeSafe's System One endpoint with an
  injected key and `fetch`, its own retries for 429, 5xx and network failures, and
  `SystemOneError` (status, body, reason) whose message never carries the key or the body.
- **`Organiser`**: the whole pipeline over one data directory, `capture → corpus → sample →
  fetch → judge → decide → score → apply → reconcile`, plus `explain`, `find`, `rule` and
  `runs`. Gmail, the decision model, the writer and the clock are injected; it reads and writes
  only under the directory it is given, never the environment or a default path. Files are
  written whole, 0600, in 0700 directories.
  - `capture` keeps sent or received metadata in yearly shards, incrementally; `sample` draws a
    deterministic sample that never includes a thread you replied into; `fetch` reads it paced
    to Gmail's per-user quota, rejects single-message threads that have since grown without
    reading them, and resumes.
  - `judge` asks only what is unanswered or was asked under different wording, and records
    every pass and its token use; `decide`, `score`, `explain` and `find` work from stored
    files alone.
  - `apply` is a dry run unless `apply: true`, changes only messages whose labels differ from
    their decision, and keeps every applied change, ids included, in
    `runs/<run>/apply.<scheme>.log` with the same `idsSha256` the guard logs. A change refused
    part-way is logged with the chunks that landed before the error is rethrown.
  - `reconcile` compares the labels in Gmail with the decisions; `rule` records a golden case
    and optionally a sender ruling, validated before either file is written.
- **CLI `organise <verb>`** for every stage and `whoami`, with `--json` on every verb and exit
  codes for scripts: 0 done, 1 usage or unexpected, 2 a missing grant or model key, 3 a critical
  `score` failure, 4 a `reconcile` mismatch, 5 a stage that finished with failures. The data
  directory defaults to `~/.simt/gmail-api/organise` (`GMAIL_ORGANISE_DATA`); the model key is
  `TYPESAFE_API_KEY`. The CLI is not published.
- README "Organising a mailbox", `examples/organise/profile.json` and
  `examples/organise-triage.ts`.

### Changed

- `scopedRelabel` (new in this release) throws `ScopedRelabelError` when a chunk fails part-way,
  carrying `callsDone`, `idsSha256` and `status`, with the original error as its `cause`, so a
  caller can record which ids landed. The write log's `partial` line is unchanged.
- `withRetry` (`./organise`) takes `quotaBaseMs`, the first wait after a quota refusal; the
  default stays 8000 ms.
- `./organise` golden-set refusals are `ProfileError` (a subclass of `Error`), and `GoldenCase`
  holds categories as strings with an optional `scheme`.
- `WriteGuardError.code` adds `"bad-scope"` and `"outside-scope"`. A consumer that switches
  exhaustively over the codes will need the two new cases.
- `labelChange` and its 25-id cap are unchanged.
- `GMAIL_API_NOTES.md`: `label:` in a search takes the label's name with `/` and spaces written
  as `-`, not its id as the notes said. New notes on the per-minute unit quota, counting thread
  sizes by listing, sender and mailing-list quirks, and Noul versus Choice answers.

## [0.6.1] - 2026-11-15

A failed token refresh no longer signs you out. Previously any error answer from Google's token
endpoint, including a momentary 429 or 503, deleted the saved sign-in and reported "Not signed
in", so a passing outage at Google forced a new login. Now only a real refusal asks for one, the
credential is always kept, and every failure is recorded so the cause can be read afterwards.

### Fixed

- A token refresh that fails is never a reason to delete the stored credential. `GmailClient`
  keeps it and records the failure on it; a new `login` replaces it.
- Failures that can pass (429, a 5xx, or no response) are retried three times with doubling waits
  (1 s, 2 s) before `TokenEndpointError` is thrown. They no longer surface as "Not signed in".
- A refusal (`invalid_grant`, `invalid_client`, any other 4xx) throws `NotSignedInError` naming
  Google's code and description, e.g. "Google rejected the saved sign-in (invalid_grant: Token
  has been expired or revoked.). Run login.", with the `OAuthError` as its `cause`.

### Added

- `OAuthError` carries `status`, `code` and `description` from Google's answer.
- `TokenEndpointError` for a token-endpoint failure that can pass, with the last `status` and
  `code`.
- `refreshAccessToken(secret, cred, opts?)` takes `fetch`, `attempts`, `retryBaseMs` and
  `onRetry`.
- `GmailClientOptions.onAuthEvent` receives sign-in events (`refresh-retry`,
  `refresh-recovered`, `refresh-failed`, `refresh-rejected`) for the caller's own log; they never
  carry a token. `refreshRetryBaseMs` sets the first wait between refresh attempts.
- `OAuthCredential` records `lastRefreshAt` and `lastRefreshError` (`RefreshFailure`: time,
  status, code and whether Google refused).
- CLI: sign-in events, logins and logouts are appended to `~/.simt/gmail-api/auth.log` (0600,
  JSON lines, `GMAIL_API_AUTH_LOG` to move it). `whoami` shows when you signed in, the grant's
  age, the last refresh and the last refresh failure, and where the log is. A refused or failed
  refresh names the log, and a failure of the write grant names `login --write`.

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
