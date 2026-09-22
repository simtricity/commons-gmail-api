# Spec — `gmail-api` write support (labels and drafts), 0.3.0

Status: **accepted, in progress** (2026-09-22). Owner: Damon. The section "Owner decisions" below
is authoritative where it differs from the advisory draft that follows it.

## Owner decisions (2026-09-22)

Amendments to the advisory draft after a live probe against a sandbox label:

1. **Drafts are in scope.** The write grant is `gmail.readonly` + `gmail.modify` + `gmail.compose`.
   Sending is not implemented anywhere; there is no send method, so `gmail.compose`'s
   `drafts.send` ability is unreachable from this library.
2. **Writes live on a separate `GmailWriter` class** (`lib/writes.ts`), not on `GmailClient`. The
   read client gains only a low-level `request()` transport and `grantedScopes()`. A consumer that
   imports the read client cannot call a write; the import line shows intent.
3. **Trash and untrash are out.** Nothing named needs them. The probe showed `TRASH` can be applied
   through `messages.modify` under `gmail.modify`, so `GmailWriter` refuses `TRASH`, `SPAM` and
   `INBOX` in any label change unless the caller passes `allowSystem: true`. The CLI never passes it.
4. **`ensureLabel` walks parents.** Creating `a/b/c` does **not** create `a` or `a/b` (probe); the
   leaf displays nested but the parents are not real labels. `ensureLabel` creates each missing
   prefix in order, and treats 409 as "exists, re-resolve".
5. **CLI guardrails.** Dry run by default with `--apply`; at most 25 ids per `label apply|remove`
   call (the library has no cap: bulk consumers call `batchModifyMessages` directly); every applied
   mutation appends a JSON line to `~/.simt/gmail-api/writes.log`.
6. **Separate credential file** as drafted: `credentials.modify.json`, env
   `GMAIL_API_CREDENTIALS_MODIFY`, `login --write`, `whoami --write`. Shipped ahead of the rest.
7. `modifyThread`, `updateLabel`, `deleteLabel` are included (cheap; the live test needs delete).

Probe results (2026-09-22, sandbox label, all cleaned up): nested create 200 leaf only; duplicate
409 "Label name exists or conflicts"; `messages.modify` 200 with labelIds; `batchModify` 204 empty
body; `TRASH` via modify 200 then `untrash` 200; `drafts.create` 200, `drafts.delete` 204.

---

## Advisory draft (client, 2026-09-22)


Status: **proposed**, not implemented. Target release `@simtricity-commons/gmail-api` `0.3.0`.
Drafted 2026-09-22 for the mailbox-organiser work.

Living in the workspace root rather than in `gmail-api/` because it is a
proposal awaiting a decision. Move it into the repo when the work starts.

`gmail-api/CLAUDE.md` says: *"Read-only stays the default. Adding a write method
needs an explicit decision and a wider scope at login; do not add one as a
convenience."* This is that explicit decision, written down before code moves.

---

## 1. Why

A consumer (`gmail-organiser`) classifies mail and needs to record the verdict
where the operator can see and act on it — as Gmail labels. Everything else in
that pipeline is read-only and stays so; the label write is the single mutation
at the end.

The immediate job is 500 messages as a dry-run/live pair. The same path has to
scale to a 445,239-message mailbox without a redesign.

## 2. Scope: `gmail.modify`, and nothing wider

| Scope | Grants | Verdict |
|---|---|---|
| `gmail.readonly` | read only | current default, unchanged |
| `gmail.labels` | create/rename/delete **label objects** | insufficient — cannot apply a label to a message |
| `gmail.modify` | all read/write **except permanent delete** | **chosen** |
| `mail.google.com` | everything, including permanent delete | rejected |

`gmail.labels` is the intuitive choice and the wrong one: it manages label
objects but cannot attach one to a message. Applying a label is a message
mutation, so `gmail.modify` is the least privilege that does the job.

The safety property worth stating plainly: **under `gmail.modify` this library
structurally cannot permanently delete mail.** `messages.delete` requires the
full `mail.google.com` scope, which we will not request. The worst case is
`messages.trash`, recoverable for 30 days. Any future permanent-delete
capability is a separate decision and a separate spec.

`lib/auth.ts` already accepts `scopes?: string[]` defaulting to
`[SCOPE_READONLY]`, so the OAuth flow itself needs no change. Add:

```ts
/** Read/write except permanent delete. A deliberate widening; see the write-support spec. */
export const SCOPE_MODIFY = "https://www.googleapis.com/auth/gmail.modify";
```

## 3. Credential isolation — the part most likely to go wrong

`FileTokenStore` keys credentials **by email address**. A modify-scoped login for
`someone@example.com` would therefore *overwrite* that mailbox's read-only
credential in the same file. Every existing read-only consumer — including the
`simt-gmail` skill — would silently inherit write power with no code change and
no review. That is unacceptable.

**Requirement:** the modify grant is stored separately.

```
~/.simt/gmail-api/credentials.json          # readonly, untouched by this work
~/.simt/gmail-api/credentials.modify.json   # modify, opt-in
```

- New env override `GMAIL_API_CREDENTIALS_MODIFY`, mirroring `GMAIL_API_CREDENTIALS`.
- Both files mode 0600, as now.
- A consumer wanting write access constructs its client against the modify store
  explicitly. There is no way to obtain a writing client by accident.
- Revoking write is deleting one file; the read-only path keeps working.

Rejected alternative: incremental authorisation upgrading the single grant in
place. Fewer files, and strictly worse — it removes the operator's ability to
hold read-only and read-write capability separately, and makes "which of my
tools can write to my mailbox" unanswerable.

## 4. Capability enforcement in the client

Do not trust a constructor flag. `OAuthCredential.scope` already records the
space-separated scopes **Google actually granted**, which is the only
trustworthy source — a user can decline a scope on the consent screen and still
complete the flow.

```ts
/** Thrown when a write is attempted with a credential that lacks the scope. */
export class InsufficientScopeError extends Error {
  override name = "InsufficientScopeError";
  constructor(readonly required: string, readonly granted: string) {
    super(`This credential does not grant ${required}. Granted: ${granted || "(none)"}`);
  }
}
```

Every write method calls a private `requireScope(SCOPE_MODIFY)` that inspects the
loaded credential and throws **before any network call**. A read-only client
calling `addLabels()` fails locally, immediately, with an actionable message —
never with a confusing 403 from Google.

## 5. Transport

`lib/client.ts` today has exactly one transport method: a private
`get<T>(path, retry)`. There is **no POST helper**. This is the main structural
gap.

Add a private `send<T>(method, path, body?, retry = true)` mirroring `get`'s
behaviour exactly — in particular its 401-refresh-and-retry-once — and handling
the empty-body case, because `batchModify` returns `204 No Content` and
`res.json()` would throw on it.

```ts
private async send<T>(
  method: "POST" | "PUT" | "PATCH" | "DELETE",
  path: string,
  body?: unknown,
  retry = true,
): Promise<T | null>
```

Refactor `get` to delegate to it rather than duplicating retry logic. This is the
only change to existing behaviour and must not alter any read path; the existing
live read tests are the guard.

## 6. API surface

All on `GmailClient`, all gated by `requireScope`.

### Labels

```ts
/** Every label, including ids. Already exists; unchanged. */
listLabels(): Promise<Label[]>

/** Create a label. `name` may contain "/" for nesting, e.g. "organiser/2020/for-delete". */
createLabel(name: string, opts?: {
  labelListVisibility?: "labelShow" | "labelShowIfUnread" | "labelHide";
  messageListVisibility?: "show" | "hide";
}): Promise<Label>

/** Find by exact name, else create. Idempotent; safe to call on every run. */
ensureLabel(name: string, opts?: …): Promise<Label>

/** Rename, or change visibility. */
updateLabel(id: string, patch: { name?: string; … }): Promise<Label>

/** Delete the label itself. Does not delete the messages carrying it. */
deleteLabel(id: string): Promise<void>
```

`ensureLabel` is what consumers should reach for. Notes:

- Gmail applies labels **by id, never by name**. Name→id resolution is the
  caller's most common chore and belongs here.
- `labels.create` returns **409** when the name exists. `ensureLabel` treats that
  as success and re-resolves the id rather than propagating — this closes the
  race between two concurrent runs.
- Nesting is by literal `/` in the name. **Verify empirically** whether creating
  `a/b/c` auto-creates the `a` and `a/b` parents or merely displays as nested;
  record the answer in `GMAIL_API_NOTES.md`. If parents are not auto-created,
  `ensureLabel` must create them in order.

### Messages

```ts
/** Add and/or remove labels on one message. Returns the updated message. */
modifyMessage(id: string, change: {
  addLabelIds?: string[];
  removeLabelIds?: string[];
}): Promise<Message>

/** The same change across many messages. At most 1000 ids per call. */
batchModifyMessages(ids: string[], change: {
  addLabelIds?: string[];
  removeLabelIds?: string[];
}): Promise<void>

/** Move to Trash. Recoverable for 30 days. */
trashMessage(id: string): Promise<Message>
untrashMessage(id: string): Promise<Message>
```

Thread equivalents (`modifyThread`, `trashThread`) follow the same shape; add
them only when a consumer needs them, not speculatively.

### `batchModify` is why this design scales

| Call | Messages | Quota units |
|---|---|---|
| `messages.modify` × 1000 | 1000 | 5,000 |
| `messages.batchModify` × 1 | 1000 | 50 |

A hundredfold saving, and one round trip instead of a thousand. Against the
6,000 units/minute ceiling, labelling the whole 445k mailbox costs roughly
22,000 units — under four minutes of quota, versus nearly two hours.

Two consequences the implementation must handle:

- **It returns `204` with no body.** There is no per-message result, so a partial
  failure is invisible. `batchModifyMessages` therefore returns `void`, not a
  list. A caller needing confirmation must re-read the messages.
- **Chunking is the library's job.** `batchModifyMessages` accepts any number of
  ids and splits into ≤1000 internally. A caller passing 50,000 ids just works.

## 7. Facts carried over from the organiser work

These cost real time to learn and belong in `GMAIL_API_NOTES.md`.

- **Gmail signals quota exhaustion as HTTP 403 `rateLimitExceeded`, not 429.**
  Treating 403 as fatal lost 318 of 490 messages on one run. Genuine permission
  failures are *also* 403, so the reason string must be inspected.
- **Quota windows are per minute.** Sub-second backoff cannot outlive one; start
  quota retries at 8 seconds.
- **Gmail throttles metadata reads to about 6/s regardless of concurrency** —
  measured 5.4/s at 6 in flight, 5.4/s at 8, 5.8/s at 14, with round-trip latency
  rising 1.1s→2.4s to absorb the difference. Writes via `batchModify` are one
  call and are not affected.

This motivates a small additive improvement to `GmailApiError`: parse Google's
JSON error body and expose

```ts
readonly reason?: string;   // e.g. "rateLimitExceeded", "insufficientPermissions"
```

The workspace rule is that callers branch on `instanceof`, never message text —
yet today a caller distinguishing quota-403 from permission-403 has no choice but
to regex `message`. Keep `status`, `path` and `body` exactly as they are.

Retry and backoff policy itself stays **out** of this library: consumer policy,
consistent with tenant keying and TTL sweeps being deliberately not ported
(`gmail-api/CLAUDE.md` § Provenance).

## 8. CLI

`cli/` is the only layer that reads env. Add:

```
gmail-api login --write                       # consent to gmail.modify, store separately
gmail-api whoami --write                      # prove the write grant; non-zero if absent
gmail-api labels                              # list labels with ids (read, --json)
gmail-api label create <name>
gmail-api label apply  <name> --ids <a,b,c>   [--dry-run]
gmail-api label remove <name> --ids <a,b,c>   [--dry-run]
```

- `--dry-run` prints the resolved label id and the exact message count it would
  touch, and makes no write call. Default for anything destructive.
- `whoami --write` honours the workspace probe contract: prove live access, exit
  non-zero on failure.
- `--json` on everything, per workspace convention.

## 9. Testing

`tests/unit-test.ts` stays offline and must stay that way. Cover:

- `requireScope` accepts a credential granting modify, rejects readonly, rejects
  an empty scope string.
- Scope parsing handles the space-separated form, extra whitespace, and a list
  where modify is not first.
- `batchModifyMessages` chunking: 0 ids is a no-op with **no** network call; 1000
  is one chunk; 1001 is two; 2500 is three.
- `ensureLabel` treats 409 as success and re-resolves.
- Fixtures synthetic — no real addresses, label names or mailbox ids.

`tests/live-test.ts` is currently read-only and documented as such. A live write
test must be **opt-in and self-cleaning**:

- Runs only when `GMAIL_API_LIVE_WRITE=1`; otherwise skips with a clear message.
- Touches only labels under a fixed sandbox prefix, e.g. `gmail-api-test/<uuid>`.
- Creates a label, applies it to one message found by search, verifies, removes
  it, deletes the label. Cleanup in `finally`.
- Never trashes anything.

Update `deno task check` to include any new entry points.

## 10. Consumer impact

- **`simt-gmail` skill** (`~/.claude/skills/simt-gmail`) **vendors `lib/`** into
  `scripts/lib/`. After this lands, run `deno task vendor` there and update the
  version line in `scripts/lib/VENDORED.md`, per `gmail-api/CLAUDE.md`. The skill
  gains no write capability in practice: it holds only the read-only credential
  and `requireScope` fails locally. Confirm `deno task verify-vendor` still
  passes.
- **`gmail-organiser`** stays read-only; its own `CLAUDE.md` forbids a write path
  there. It emits message ids plus a label name; a separate thin tool holding the
  modify credential performs the write.
- No existing method changes signature. `0.2.x` consumers are unaffected.

## 11. Out of scope

Explicitly not in `0.3.0`:

- Permanent delete (`messages.delete`) and the `mail.google.com` scope.
- Sending mail (`messages.send`), drafts, filters, forwarding, settings.
- Retry and backoff policy — consumer's.
- Watch/push notifications, history sync.

## 12. Release

- One minor: `0.2.1` → `0.3.0`. Per the SemVer rule, one minor per merge to main
  regardless of how many features the round contains; patches for churn within.
- `CHANGELOG.md` entry before the tag, calling out the new scope prominently —
  this release lets the library write to a mailbox for the first time.
- Run the workspace leak checklist before tagging.
- **Do not push, tag or publish without Damon's explicit go-ahead.**

## 13. Acceptance checklist

- [ ] `SCOPE_MODIFY` exported; `SCOPE_READONLY` still the default everywhere.
- [ ] Modify credential in a separate file; read-only grant provably untouched
      (compare `credentials.json` before and after).
- [ ] `requireScope` throws `InsufficientScopeError` locally, before any fetch.
- [ ] `send()` mirrors `get()`'s 401-refresh-retry; `get()` refactored onto it
      with no behavioural change; existing live read tests pass unmodified.
- [ ] `ensureLabel` idempotent, 409-safe; nesting behaviour verified and recorded
      in `GMAIL_API_NOTES.md`.
- [ ] `batchModifyMessages` chunks at 1000 and no-ops on an empty list.
- [ ] `GmailApiError.reason` populated; 403-quota distinguishable from
      403-permission without regexing a message.
- [ ] `--dry-run` on every mutating CLI command, default for destructive ones.
- [ ] Offline tests cover scope gating and chunking; live write test opt-in and
      self-cleaning.
- [ ] `deno task check`, `test`, `lint`, `publish:dry` all clean.
- [ ] `CHANGELOG.md` updated; skill re-vendored.

## 14. Open questions

1. Does creating label `a/b/c` auto-create `a` and `a/b`? Determines whether
   `ensureLabel` must walk the path. **Verify before implementing.**
2. Can `TRASH` be added via `modifyMessage`, or does Gmail require
   `messages.trash`? Believed to require `trash()`; confirm and record.
3. Should `batchModifyMessages` expose a progress callback for very large runs,
   or is chunk-level granularity enough? Defer until a consumer asks.
