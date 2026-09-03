# Changelog

All notable changes to `@simtricity-commons/gmail-api`. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow SemVer.

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
