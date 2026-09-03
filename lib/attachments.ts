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
  for (let n = 2; ; n++) {
    const candidate = `${stem} (${n})${ext}`;
    if (!taken.has(candidate)) return candidate;
  }
}

function selector(opts: FetchAttachmentsOptions): (a: AttachmentRef) => string | null {
  const names = opts.filenames && new Set(opts.filenames);
  const globs = opts.include === undefined
    ? []
    : (Array.isArray(opts.include) ? opts.include : [opts.include]).map((g) =>
      globToRegExp(g, { caseInsensitive: true })
    );
  return (a) => {
    if (a.inline && !opts.includeInline) return "inline";
    if (names) return names.has(a.filename) ? null : "not in --filename list";
    if (globs.length && !globs.some((re) => re.test(a.filename))) return "no --include match";
    if (opts.maxBytes !== undefined && a.size > opts.maxBytes) {
      return `larger than ${opts.maxBytes} bytes`;
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
  const skip = selector(opts);
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
      manifest.skipped.push({ messageId: ref.messageId, filename: ref.filename, reason });
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
