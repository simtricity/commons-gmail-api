/**
 * The one-time move from the two-file layout of 0.3–0.8 (a read-only sign-in in one file, the
 * write sign-in in another) to one sign-in in one file. Local files only: **it never revokes and
 * never calls the network**, because a revoke cancels the app's whole grant for the user, the
 * sign-in being moved with it. Paths are passed in; nothing here reads the environment.
 * @module
 */

import { dirname, join } from "@std/path";
import { SCOPE_COMPOSE, SCOPE_MODIFY, SCOPES_ALL } from "./auth.ts";
import type { OAuthCredential } from "./types.ts";

interface StoreFile {
  version: 1;
  default?: string;
  accounts: Record<string, OAuthCredential>;
}

/** What {@link migrateSplitCredentials} did. */
export interface MigrationResult {
  /** True when a legacy file was found and retired (renamed, tombstone written). */
  migrated: boolean;
  /** Accounts whose write sign-in was copied into the one file. */
  accounts: string[];
  /** Backup of the one file, written only when it changed and existed before. */
  backup?: string;
  /** Where the legacy file now is. */
  renamedTo?: string;
  /** The note left in its place. */
  tombstone?: string;
  /** Set when the legacy file could not be read; it was left untouched. */
  warning?: string;
}

/** Options for {@link migrateSplitCredentials}. */
export interface MigrateOptions {
  /** The one credential file, e.g. `credentials.json`. */
  path: string;
  /** The legacy write-sign-in file, e.g. `credentials.modify.json`. Absent: nothing to do. */
  legacyPath: string;
  /** The time used for the `<utc>` suffixes. Default: now. */
  now?: Date;
}

const stamp = (now: Date) => now.toISOString().replace(/\.\d+Z$/, "Z").replace(/:/g, "-");
const scopesOf = (c?: OAuthCredential) => new Set((c?.scope ?? "").split(" ").filter(Boolean));
const fileName = (p: string) => p.slice(p.lastIndexOf("/") + 1);

async function readStore(path: string): Promise<StoreFile | null> {
  try {
    const parsed = JSON.parse(await Deno.readTextFile(path)) as Partial<StoreFile>;
    return { version: 1, default: parsed.default, accounts: parsed.accounts ?? {} };
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) return null;
    throw e;
  }
}

async function writePrivate(path: string, text: string): Promise<void> {
  const tmp = `${path}.tmp-${crypto.randomUUID().slice(0, 8)}`;
  await Deno.writeTextFile(tmp, text, { mode: 0o600 });
  await Deno.chmod(tmp, 0o600);
  await Deno.rename(tmp, path);
}

/**
 * Move the write sign-in from `legacyPath` into `path`. For each account in the legacy file that
 * holds every scope in {@link SCOPES_ALL}, copy it across when `path` has no entry for it or its
 * entry lacks modify or compose; an account already complete in `path`, or a partial grant, is
 * left alone. `path` is backed up first (`.bak-<utc>`, only if it changes) and written atomically;
 * the legacy file is renamed `.migrated-<utc>` and a `credentials.modify.MOVED.md` note left
 * beside it. Every file it writes is 0600. A second run finds no legacy file and does nothing.
 * A legacy file that is not valid JSON is left untouched and reported in `warning`; this never
 * throws for that.
 */
export async function migrateSplitCredentials(o: MigrateOptions): Promise<MigrationResult> {
  let legacy: StoreFile | null;
  try {
    legacy = await readStore(o.legacyPath);
  } catch (e) {
    // fallback: an unreadable legacy file must not stop the caller; it is left as is, and named.
    if (!(e instanceof SyntaxError)) throw e;
    return {
      migrated: false,
      accounts: [],
      warning: `could not read ${o.legacyPath} to migrate it (${e.message}); left as is`,
    };
  }
  if (!legacy) return { migrated: false, accounts: [] };
  const at = stamp(o.now ?? new Date());
  const before = await readStore(o.path);
  const next: StoreFile = before
    ? { ...before, accounts: { ...before.accounts } }
    : { version: 1, accounts: {} };

  const accounts: string[] = [];
  for (const [key, c] of Object.entries(legacy.accounts)) {
    const full = SCOPES_ALL.every((s) => scopesOf(c).has(s));
    const have = scopesOf(next.accounts[key]);
    const lacksWrite = !have.has(SCOPE_MODIFY) || !have.has(SCOPE_COMPOSE);
    if (full && (!next.accounts[key] || lacksWrite)) {
      next.accounts[key] = c;
      accounts.push(key);
    }
  }

  const result: MigrationResult = { migrated: true, accounts };
  if (accounts.length) {
    next.default ??= legacy.default && accounts.includes(legacy.default)
      ? legacy.default
      : accounts[0];
    if (before) {
      result.backup = `${o.path}.bak-${at}`;
      await Deno.copyFile(o.path, result.backup);
      await Deno.chmod(result.backup, 0o600);
    }
    await Deno.mkdir(dirname(o.path), { recursive: true, mode: 0o700 });
    await writePrivate(o.path, JSON.stringify(next, null, 2) + "\n");
  }

  result.renamedTo = `${o.legacyPath}.migrated-${at}`;
  await Deno.rename(o.legacyPath, result.renamedTo);
  await Deno.chmod(result.renamedTo, 0o600);
  result.tombstone = join(dirname(o.legacyPath), "credentials.modify.MOVED.md");
  await writePrivate(
    result.tombstone,
    `# credentials.modify.json has moved\n\n` +
      `Since gmail-api 0.9.0 one sign-in holds read, labels and drafts, in ` +
      `\`${fileName(o.path)}\`.\n\n` +
      `On ${at} the write sign-in in this folder was moved there ` +
      `(${accounts.length ? `copied: ${accounts.join(", ")}` : "nothing needed copying"}). ` +
      `The old file is kept as \`${fileName(result.renamedTo)}\`. Nothing was revoked.\n`,
  );
  return result;
}
