/**
 * The one-time move from the 0.3–0.8 two-file layout (`credentials.json` read-only,
 * `credentials.modify.json` write) to one sign-in in `credentials.json`. Local files only:
 * **it never revokes and never calls the network.** A revoke cancels the app's whole grant for
 * the user, the sign-in being migrated with it.
 * @module
 */

import { SCOPE_COMPOSE, SCOPE_MODIFY, SCOPES_ALL } from "../lib/mod.ts";
import type { OAuthCredential } from "../lib/mod.ts";
import { basename, dirname, join } from "@std/path";

interface StoreFile {
  version: 1;
  default?: string;
  accounts: Record<string, OAuthCredential>;
}

/** What a migration did. */
export interface MigrationResult {
  /** False when there was nothing to migrate (no old write file). */
  ran: boolean;
  /** Accounts whose write sign-in was copied into the one file. */
  copied: string[];
  /** Accounts left as they were: already complete in the one file, or not a full grant. */
  leftAlone: string[];
  /** Backup of the one file, written only when it changed and existed before. */
  backup?: string;
  /** Where the old write file now is. */
  renamedTo?: string;
  /** The note left in its place. */
  tombstone?: string;
}

const stamp = (now: Date) => now.toISOString().replace(/\.\d+Z$/, "Z").replace(/:/g, "-");
const scopesOf = (c?: OAuthCredential) => new Set((c?.scope ?? "").split(" ").filter(Boolean));

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
 * Move the write sign-in from `modifyPath` into `credentialsPath`. For each account in the old
 * write file that holds every scope in `SCOPES_ALL`, copy it across when the one file has no entry
 * for it or its entry lacks modify or compose. Back the one file up first (only if it changes),
 * then rename the old file to `…migrated-<utc>` and leave a `credentials.modify.MOVED.md` note.
 * Every file it writes is 0600. A second run finds no old file and does nothing.
 */
export async function migrateWriteSignIn(o: {
  credentialsPath: string;
  modifyPath: string;
  now?: Date;
}): Promise<MigrationResult> {
  const old = await readStore(o.modifyPath);
  if (!old) return { ran: false, copied: [], leftAlone: [] };
  const at = stamp(o.now ?? new Date());
  const before = await readStore(o.credentialsPath);
  const next: StoreFile = before
    ? { ...before, accounts: { ...before.accounts } }
    : { version: 1, accounts: {} };

  const copied: string[] = [];
  const leftAlone: string[] = [];
  for (const [key, c] of Object.entries(old.accounts)) {
    const full = SCOPES_ALL.every((s) => scopesOf(c).has(s));
    const have = scopesOf(next.accounts[key]);
    const lacksWrite = !have.has(SCOPE_MODIFY) || !have.has(SCOPE_COMPOSE);
    if (full && (!next.accounts[key] || lacksWrite)) {
      next.accounts[key] = c;
      copied.push(key);
    } else {
      leftAlone.push(key);
    }
  }

  const result: MigrationResult = { ran: true, copied, leftAlone };
  if (copied.length) {
    next.default ??= old.default && copied.includes(old.default) ? old.default : copied[0];
    if (before) {
      result.backup = `${o.credentialsPath}.bak-${at}`;
      await Deno.copyFile(o.credentialsPath, result.backup);
      await Deno.chmod(result.backup, 0o600);
    }
    await Deno.mkdir(dirname(o.credentialsPath), { recursive: true, mode: 0o700 });
    await writePrivate(o.credentialsPath, JSON.stringify(next, null, 2) + "\n");
  }

  result.renamedTo = `${o.modifyPath}.migrated-${at}`;
  await Deno.rename(o.modifyPath, result.renamedTo);
  await Deno.chmod(result.renamedTo, 0o600);
  result.tombstone = join(dirname(o.modifyPath), "credentials.modify.MOVED.md");
  await writePrivate(
    result.tombstone,
    `# credentials.modify.json has moved\n\n` +
      `Since gmail-api 0.9.0 one sign-in holds read, labels and drafts, in ` +
      `\`${basename(o.credentialsPath)}\`.\n\n` +
      `On ${at} the write sign-in in this folder was moved there ` +
      `(${copied.length ? `copied: ${copied.join(", ")}` : "nothing needed copying"}). ` +
      `The old file is kept as \`${basename(result.renamedTo)}\`. Nothing was revoked.\n`,
  );
  return result;
}

/** One stderr line describing a migration that ran. */
export function migrationNotice(r: MigrationResult): string {
  const what = r.copied.length
    ? `moved the write sign-in for ${r.copied.join(", ")} into the one credential file`
    : "found nothing to copy from the old write sign-in file";
  return `gmail-api: ${what}; old file kept as ${r.renamedTo}` +
    (r.backup ? `, backup ${r.backup}` : "") + ". Nothing was revoked.";
}

/** The deprecation line printed when `GMAIL_API_CREDENTIALS_MODIFY` is set. */
export const MODIFY_ENV_DEPRECATED =
  "GMAIL_API_CREDENTIALS_MODIFY is deprecated: it is read only to migrate the old write sign-in.";
