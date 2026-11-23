/**
 * A JSON-lines log of sign-in events (logins, logouts, refresh retries and failures). Never
 * tokens: an {@link AuthEvent} carries none. The path is passed in; nothing here reads the
 * environment.
 * @module
 */

import { dirname } from "@std/path";
import type { AuthEvent } from "./types.ts";

/**
 * Append one event to the log at `path` as a JSON line (file 0600, directory 0700), with `extra`
 * fields such as `grant` (the sign-in's scope short names) or `via` (which tool wrote it).
 * Synchronous, so the line is on disk before an error exits the process. Never throws.
 */
export function appendAuthLog(
  path: string,
  event: AuthEvent,
  extra: Record<string, unknown> = {},
): void {
  try {
    Deno.mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    Deno.writeTextFileSync(path, JSON.stringify({ ...event, ...extra }) + "\n", {
      append: true,
      mode: 0o600,
    });
  } catch {
    // fallback: an unwritable log never breaks a Gmail command; the error still reaches the user.
  }
}
