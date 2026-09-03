# @simtricity-commons/gmail-api

Typed Deno client + CLI for the Gmail REST API. © Simtricity Limited, MIT. Lives in the
`simt-commons` workspace; follows its conventions (see the workspace `CLAUDE.md`) and
mirrors the `informdirect-api` reference layout.

## Structure

- `lib/` — publishable library. **Env-agnostic**: no `Deno.env`, no dotenv. Everything is
  passed in. `mime.ts` is pure (no I/O) and is what the unit tests exercise.
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

Ported from an internal Simtricity Gmail probe (loopback OAuth flow, MIME walk,
revoke-then-delete). Tenant keying, TTL sweeps, date floors and cursors were deliberately
NOT ported — that is consumer policy, expressed as a custom `TokenStore` on top of this client.

## Consumers

Internal Simtricity tooling (a personal Claude skill for attachment retrieval; planned:
email-ingress adapters and supplier-document pipelines). Consumers import from JSR.

## Rules

- Read-only stays the default. Adding a write method needs an explicit decision and a
  wider scope at login; do not add one as a convenience.
- Never log or echo the client secret, refresh token, or attachment ids in error text.
- Config lives in `~/.simt/gmail-api/` (Simtricity convention: `~/.simt/` holds all local
  tool config). `client-secret.json` is the Desktop-app OAuth client; `credentials.json`
  the per-mailbox grants. Env overrides: `GMAIL_CLIENT_SECRET_PATH`, `GMAIL_API_CREDENTIALS`.
- Loopback port 8731 is claimed in `~/DEV_PORTS.md`.
- **Do not push, tag, or `deno publish` without explicit go-ahead.** Publishing is by `v*`
  tag via `.github/workflows/publish.yml`. Run the workspace pre-publish leak checklist first.
- Vendor quirks go in `GMAIL_API_NOTES.md`, not in code comments.
- Commit `deno.lock`.
