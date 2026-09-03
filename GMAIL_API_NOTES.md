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
