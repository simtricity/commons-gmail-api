# @simtricity-commons/gmail-api

Typed Deno client + CLI for the Gmail REST API. © Simtricity Limited, MIT. Lives in the
`simt-commons` workspace; follows its conventions (see the workspace `CLAUDE.md`) and mirrors the
`informdirect-api` reference layout.

## Structure

- `lib/` — publishable library. **Env-agnostic**: no `Deno.env`, no dotenv. Everything is passed in.
  `mime.ts` is pure (no I/O) and is what the unit tests exercise.
- `cli/` — `deno task cli`. The only layer that reads env (`commands.ts:contextFromEnv`).
- `tests/unit-test.ts` offline; `tests/live-test.ts` read-only against the signed-in mailbox.
- `examples/` runnable scripts. `mod.ts` barrel.

## Commands

```bash
deno task check          # type-check every entry point
deno task test           # offline unit tests
deno task test:live      # needs a prior `deno task cli login`; never writes to Gmail
deno task cli --help
deno task publish:dry    # validate the JSR package before tagging
```

## Provenance

Ported from an internal Simtricity Gmail probe (loopback OAuth flow, MIME walk, revoke-then-delete).
Tenant keying, TTL sweeps, date floors and cursors were deliberately NOT ported — that is consumer
policy, expressed as a custom `TokenStore` on top of this client.

## Consumers

Internal Simtricity tooling (a personal Claude skill for attachment retrieval; planned:
email-ingress adapters and supplier-document pipelines). Consumers import from JSR.

## Specs

Specs are **not kept in this repo** and never committed. They live in the workspace
`../_specs/` (`backlog/` → `current/` → `delivered/` | `shelved/`) as
`SPEC-GMAIL-API-<SLUG>-YYYY-MM-DD.md`; see the workspace `CLAUDE.md`. Open: scheduled send
(`../_specs/backlog/SPEC-GMAIL-API-SCHEDULED-SEND-2026-10-02.md`).

## Rules

- Read-only stays the default. Writes exist only on `GmailWriter` (`lib/writes.ts`): labels and
  drafts, decided in the workspace spec `../_specs/delivered/SPEC-GMAIL-API-WRITE-SUPPORT-2026-09-22.md` (2026-09-22). No send, trash or delete; adding any of
  those is a new decision and a new spec. The write grant lives in `credentials.modify.json`, never
  in `credentials.json`.
- Never log or echo the client secret, refresh token, or attachment ids in error text.
- Config lives in `~/.simt/gmail-api/` (Simtricity convention: `~/.simt/` holds all local tool
  config). `client-secret.json` is the Desktop-app OAuth client; `credentials.json` the per-mailbox
  grants; `credentials.modify.json` the write grants (`login --write`). Env overrides:
  `GMAIL_CLIENT_SECRET_PATH`, `GMAIL_API_CREDENTIALS`, `GMAIL_API_CREDENTIALS_MODIFY`.
- Loopback port 8731 is claimed in `~/DEV_PORTS.md`.
- **Do not push, tag, or `deno publish` without explicit go-ahead.** Publishing is by `v*` tag via
  `.github/workflows/publish.yml`. Run the workspace pre-publish leak checklist first.
- Vendor quirks go in `GMAIL_API_NOTES.md`, not in code comments.
- Commit `deno.lock`.
- Every release gets a `CHANGELOG.md` entry before the tag.

## Consumers and vendoring

- The `simt:gmail` skill (`~/.simt-marketplace/plugins/simt/skills/gmail`) **vendors `lib/`** into
  `scripts/lib/` (hosted sandboxes return 403 for jsr.io, so this is permanent) and checks drift with
  `deno task verify-vendor`. After any `lib/` change, run `deno task vendor` in the skill folder and
  update the version line in `scripts/lib/VENDORED.md`. The skill holds only the read-only
  credential, so the vendored `GmailWriter` fails locally with `InsufficientScopeError`.
- Since 0.4.0 the skill's Gmail logic (body text, thread search, write guards and log) lives in
  `lib/`; the skill keeps only arguments, `~/.simt/gmail-api/` paths, agent rules (date bound,
  `-in:chats`) and output. Keep new Gmail behaviour here, not in the skill. `lib/` must import
  nothing beyond `globToRegExp`, `join`, `resolve`, `dirname` from `@std/path` (the skill shims
  exactly those because hosted sandboxes 403 jsr.io).
- Planned: MGF supplier-paper pipelines, importing from JSR.
- `skipExisting` (0.2.0) originated as a skill-side workaround; it now lives in `selector()` so the
  double-reporting the skill had to suppress is gone.
