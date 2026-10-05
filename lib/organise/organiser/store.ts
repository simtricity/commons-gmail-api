/**
 * The organiser's data directory: where each file lives, and how it is written.
 *
 * Every path is under the `dataDir` the caller passes in. Nothing here picks a
 * default location, expands `~` or reads the environment: that is the caller's
 * business. Files are written whole (a temporary file, then a rename) as 0600,
 * and directories are created 0700, because a capture is a map of everyone the
 * account holder corresponds with.
 *
 * @module
 */

import { dirname, join } from "@std/path";

/** Run and scheme ids become path segments, so they are held to a safe alphabet. */
const SAFE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** `value` if it is safe as one path segment, else throws a `TypeError` naming `what`. */
export function safeName(what: string, value: string): string {
  if (!SAFE.test(value) || value.includes("..")) {
    throw new TypeError(
      `${what} "${value}" must be 1-64 letters, digits, ".", "_" or "-", starting with a letter or digit`,
    );
  }
  return value;
}

/** Every file of a data directory, by role. */
export function layout(dataDir: string) {
  const run = (id: string) => {
    const dir = join(dataDir, "runs", safeName("run", id));
    return {
      dir,
      manifest: join(dir, "manifest.json"),
      sample: join(dir, "sample.json"),
      messages: join(dir, "messages.json"),
      answers: join(dir, "answers.json"),
      decisions: (scheme: string) => join(dir, `decisions.${safeName("scheme", scheme)}.json`),
      applyLog: (scheme: string) => join(dir, `apply.${safeName("scheme", scheme)}.log`),
    };
  };
  return {
    profile: join(dataDir, "profile.json"),
    senders: join(dataDir, "rulings", "senders.json"),
    golden: join(dataDir, "rulings", "golden.json"),
    captureState: join(dataDir, "capture", "state.json"),
    captureDir: (source: string) => join(dataDir, "capture", source),
    shard: (source: string, year: string) => join(dataDir, "capture", source, `${year}.jsonl`),
    runs: join(dataDir, "runs"),
    run,
  };
}

/** The paths of one data directory, as {@link layout} returns them. */
export type Layout = ReturnType<typeof layout>;

/** Create a directory and its parents, 0700. */
export async function ensureDir(path: string): Promise<void> {
  await Deno.mkdir(path, { recursive: true, mode: 0o700 });
}

async function restrict(path: string, mode: number): Promise<void> {
  try {
    await Deno.chmod(path, mode);
  } catch {
    // fallback: chmod is unavailable on some filesystems and platforms; the create mode stands.
  }
}

/** Write `value` as JSON, whole: a temporary file in the same directory, then a rename. 0600. */
export async function writeJson(path: string, value: unknown): Promise<void> {
  await ensureDir(dirname(path));
  const tmp = `${path}.tmp-${crypto.randomUUID()}`;
  try {
    await Deno.writeTextFile(tmp, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
    await restrict(tmp, 0o600);
    await Deno.rename(tmp, path);
  } catch (err) {
    await Deno.remove(tmp).catch(() => {});
    throw err;
  }
}

/** Parse a JSON file. Throws when it is missing or malformed. */
export async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await Deno.readTextFile(path)) as T;
}

/** Parse a JSON file, or return `absent` when there is no such file. Malformed JSON still throws. */
export async function readJsonOr<T>(path: string, absent: T): Promise<T> {
  try {
    return await readJson<T>(path);
  } catch (err) {
    // fallback: a file that does not exist yet means the default, e.g. no rulings so far.
    if (err instanceof Deno.errors.NotFound) return absent;
    throw err;
  }
}

/** Append one JSON line, creating the file 0600. Never rewrites what is there. */
export async function appendLine(path: string, value: unknown): Promise<void> {
  await ensureDir(dirname(path));
  await Deno.writeTextFile(path, JSON.stringify(value) + "\n", {
    append: true,
    create: true,
    mode: 0o600,
  });
  await restrict(path, 0o600);
}
