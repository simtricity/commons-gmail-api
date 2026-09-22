# Gmail API notes — quirks worth knowing

Observed while building and testing this client. Vendor behaviour, not ours.

## OAuth (Desktop-app client, loopback)

- **Testing-mode consent screens expire refresh tokens after 7 days.** If the Google Cloud project's
  OAuth consent screen is in "Testing" (not "Published" / Internal for Workspace), every refresh
  token dies a week after login. Symptom: `refresh_token` request → 400 `invalid_grant`. Publish the
  consent screen (or use an Internal app on Workspace).
- `prompt=consent` is required to reliably get a `refresh_token` on re-login. Without it a returning
  user gets only an access token.
- Google returns the granted `scope` in the token response — store it; a user can untick scopes on
  the consent screen.
- Loopback redirect for Desktop-app clients accepts **any** `127.0.0.1:<port>` — the port does not
  need registering in the console. `localhost` is discouraged; use the IP.
- The mailbox address is available from `users.getProfile` under `gmail.readonly`; no
  `userinfo.email` scope needed.
- `revoke` accepts either token type; revoking the refresh token kills the whole grant.

## Messages / threads

- `messages.get?format=full` returns the MIME tree with `body.attachmentId` for parts above a small
  size threshold; tiny parts come inline in `body.data` (base64url) with no `attachmentId`. Both
  shapes can appear in one message.
- **`attachmentId` is ephemeral.** It differs between `messages.get` calls for the same part.
  Fetch-then-use in one pass; never persist it.
- All `data` fields are **base64url** (`-`/`_`), frequently unpadded.
- `snippet` (a body excerpt) is returned even in `format=metadata`. Metadata-only outputs must be
  built field by field, not by spreading the API object.
- Inline images (signatures, tracking pixels) have `Content-Disposition: inline` **and** a
  `Content-ID`. Some senders mark real attachments `inline` without a Content-ID — hence the
  both-conditions rule.
- Forwarded mails attached as `.eml` come through as `message/rfc822` parts with an `attachmentId`
  like any other file.
- `sizeEstimate` on a message is roughly the RFC 822 size; `body.size` on a part is the decoded byte
  count, which matches what `attachments.get` returns.
- Gmail's web UI URLs use `FMfcgz…` tokens for threads in the new UI; these are **not** API ids and
  cannot be converted client-side. Legacy `#inbox/<16-hex>` URLs are API ids.
- `messages.list` `q` uses full Gmail search syntax; `label:` needs label **ids** (`Label_7`), not
  names. Drafts appear in `messages.list` unless excluded with `-in:draft`.
- Attachments larger than ~25 MB are Drive links in the body, not MIME parts.

## Quotas

- 250 quota units/user/second. `messages.get` = 5 units, `attachments.get` = 5, `messages.list` = 5,
  `threads.get` = 10. A thread fetch with N files costs ~10 + 5N.

## Writes (labels, drafts) — probed 2026-09-22 under `gmail.modify` + `gmail.compose`

- Creating label `a/b/c` creates **only the leaf**. Parents are not created; the UI shows the leaf
  nested but `a` and `a/b` cannot be searched or applied. Create prefixes in order yourself.
- `labels.create` on an existing name → 409 `Label name exists or conflicts`.
- `messages.modify` returns the message with updated `labelIds`; `messages.batchModify` returns
  **204 with an empty body** (no per-message result). Max 1000 ids per call.
- `TRASH` **can** be added via `messages.modify` (it trashes the message); `untrash` restores. So
  `gmail.modify` reaches trash through the label path — guard system labels in code.
- `gmail.labels` cannot apply a label to a message; `gmail.modify` is the least privilege that can.
- `gmail.compose` permits `drafts.create/update/delete` **and** `drafts.send`. Not implementing send
  is the only thing stopping it.
- Quota exhaustion arrives as HTTP 403 with reason `rateLimitExceeded`, not 429. Permission failures
  are also 403 (`insufficientPermissions`); branch on `GmailApiError.reason`. Quota windows are per
  minute, so backoff under ~8 s cannot outlive one. Metadata reads throttle at ~6/s regardless of
  concurrency (reported by the gmail-organiser work).
