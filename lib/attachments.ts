/**
 * Bulk attachment download with a manifest.
 * @module
 */

import { globToRegExp, join, resolve } from "@std/path";
import type { GmailClient } from "./client.ts";
import { sha256Hex } from "./mime.ts";
import type { AttachmentRef, Manifest, ManifestEntry } from "./types.ts";

export interface FetchAttachmentsOptions {
  /** Directory to write into. Created if missing. */
  outDir: string;
  /** Glob(s) on the original filename, e.g. `*.pdf`. Default: everything. */
  include?: string | string[];
  /** Exact filename(s) to fetch; wins over `include` when set. */
  filenames?: string[];
  /** Also write inline/CID parts (embedded images). Default false. */
  includeInline?: boolean;
  /** Skip files larger than this many bytes. Default: no limit. */
  maxBytes?: number;
  /**
   * Skip attachments already present on disk, without downloading them. `true` checks
   * `outDir`; a string names another directory. An attachment counts as present when a
   * file of the same name and byte size exists there (Gmail's `body.size` is the decoded
   * byte count, so this is exact). If that directory holds a previous `manifest.json`, its
   * recorded sha256 is quoted in the skip reason. Applied after `include`/`filenames`/
   * `includeInline`/`maxBytes`, so a file excluded by those rules is never reported as
   * "already present". Default false.
   */
  skipExisting?: boolean | string;
  /** Resolve everything, write nothing. */
  dryRun?: boolean;
  /** Progress lines. */
  log?: (line: string) => void;
}

/** Replace path separators and control characters; keep everything else as sent. */
export function safeBasename(filename: string): string {
  // deno-lint-ignore no-control-regex
  const cleaned = filename.replace(/[/\\\x00-\x1f\x7f]/g, "_").trim();
  return cleaned === "" || cleaned === "." || cleaned === ".." ? "attachment" : cleaned;
}

/** `name.ext` → `name (2).ext`, `name (3).ext`… until unused in `taken`. */
export function disambiguate(basename: string, taken: Set<string>): string {
  if (!taken.has(basename)) return basename;
  const dot = basename.lastIndexOf(".");
  const stem = dot > 0 ? basename.slice(0, dot) : basename;
  const ext = dot > 0 ? basename.slice(dot) : "";
  for (let n = 2;; n++) {
    const candidate = `${stem} (${n})${ext}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/** What `scanExisting` found in a directory: file sizes by name, and prior sha256s by name. */
export interface ExistingIndex {
  dir: string;
  /** Byte size of every regular file in `dir`, excluding `manifest.json`. */
  sizes: Map<string, number>;
  /** sha256 by `savedAs` from a previous `manifest.json` in `dir`, if one parses. */
  sha256: Map<string, string>;
}

/**
 * Index a directory for `skipExisting`. A missing directory yields an empty index, so a
 * first run and a re-run take the same code path.
 */
export async function scanExisting(dir: string): Promise<ExistingIndex> {
  const abs = resolve(dir);
  const index: ExistingIndex = {
    dir: abs,
    sizes: new Map(),
    sha256: new Map(),
  };
  try {
    for await (const e of Deno.readDir(abs)) {
      if (!e.isFile || e.name === "manifest.json") continue;
      index.sizes.set(e.name, (await Deno.stat(join(abs, e.name))).size);
    }
  } catch {
    // fallback: directory does not exist yet, so nothing can be present
    return index;
  }
  try {
    const prior = JSON.parse(
      await Deno.readTextFile(join(abs, "manifest.json")),
    ) as {
      files?: { savedAs?: string; sha256?: string }[];
    };
    for (const f of prior.files ?? []) {
      if (f.savedAs && f.sha256) index.sha256.set(f.savedAs, f.sha256);
    }
  } catch {
    // fallback: no readable prior manifest; a (name, size) match is still decisive
  }
  return index;
}

/**
 * Build the skip predicate used by the fetch functions. Returns `null` to fetch, else a
 * human-readable reason. Exported so callers can preview decisions without a client.
 */
export function makeSelector(
  opts: FetchAttachmentsOptions,
  existing?: ExistingIndex,
): (a: AttachmentRef) => string | null {
  const names = opts.filenames && new Set(opts.filenames);
  const globs = opts.include === undefined
    ? []
    : (Array.isArray(opts.include) ? opts.include : [opts.include]).map((g) =>
      globToRegExp(g, { caseInsensitive: true })
    );
  return (a) => {
    if (a.inline && !opts.includeInline) return "inline";
    if (names) return names.has(a.filename) ? null : "not in --filename list";
    if (globs.length && !globs.some((re) => re.test(a.filename))) {
      return "no --include match";
    }
    if (opts.maxBytes !== undefined && a.size > opts.maxBytes) {
      return `larger than ${opts.maxBytes} bytes`;
    }
    if (existing && existing.sizes.get(a.filename) === a.size) {
      const sha = existing.sha256.get(a.filename);
      return sha
        ? `already in ${existing.dir} (sha256 ${sha.slice(0, 12)}…)`
        : `already in ${existing.dir} (name + size match)`;
    }
    return null;
  };
}

async function fetchRefs(
  client: GmailClient,
  refs: AttachmentRef[],
  source: Manifest["source"],
  opts: FetchAttachmentsOptions,
): Promise<Manifest> {
  const log = opts.log ?? (() => {});
  const outDir = resolve(opts.outDir);
  const existing = opts.skipExisting
    ? await scanExisting(
      opts.skipExisting === true ? outDir : opts.skipExisting,
    )
    : undefined;
  const skip = makeSelector(opts, existing);
  const taken = new Set<string>();
  const manifest: Manifest = {
    source,
    account: await client.email(),
    fetchedAt: new Date().toISOString(),
    outDir,
    files: [],
    skipped: [],
  };

  if (!opts.dryRun) await Deno.mkdir(outDir, { recursive: true });

  for (const ref of refs) {
    const reason = skip(ref);
    if (reason) {
      manifest.skipped.push({
        messageId: ref.messageId,
        filename: ref.filename,
        reason,
      });
      continue;
    }
    const savedAs = disambiguate(safeBasename(ref.filename), taken);
    taken.add(savedAs);
    const entry: ManifestEntry = {
      messageId: ref.messageId,
      filename: ref.filename,
      savedAs,
      mimeType: ref.mimeType,
      bytes: ref.size,
    };
    if (!opts.dryRun) {
      log(`fetching ${ref.filename} (${ref.size} bytes)`);
      const bytes = await client.getAttachment(ref.messageId, ref.attachmentId);
      const path = join(outDir, savedAs);
      await Deno.writeFile(path, bytes);
      entry.path = path;
      entry.bytes = bytes.byteLength;
      entry.sha256 = await sha256Hex(bytes);
    }
    manifest.files.push(entry);
  }

  if (!opts.dryRun) {
    await Deno.writeTextFile(
      join(outDir, "manifest.json"),
      JSON.stringify(manifest, null, 2) + "\n",
    );
  }
  return manifest;
}

/** Every attachment in a thread → `outDir`, plus `manifest.json`. */
export async function fetchThreadAttachments(
  client: GmailClient,
  threadId: string,
  opts: FetchAttachmentsOptions,
): Promise<Manifest> {
  const refs = await client.listThreadAttachments(threadId);
  return fetchRefs(client, refs, { threadId }, opts);
}

/** Every attachment in one message → `outDir`, plus `manifest.json`. */
export async function fetchMessageAttachments(
  client: GmailClient,
  messageId: string,
  opts: FetchAttachmentsOptions,
): Promise<Manifest> {
  const refs = await client.listMessageAttachments(messageId);
  return fetchRefs(client, refs, { messageId }, opts);
}
