/**
 * This repo is licence-clean: no name of the organisation it grew in, anywhere in it.
 *
 * Every text file is read (code, docs, tests) and checked against a private denylist. The list
 * is itself sensitive, so it never lives in this repo: it is read from `../_boundary/denylist.txt`
 * or `$COMMONS_DENYLIST`. Where neither exists (CI, another machine) the name check skips.
 * "Simtricity" may appear only as the copyright holder, its GitHub org or its package scope;
 * that check needs no list and always runs.
 *
 * Failures report `file:line` only, never the matched word or the line: the word is exactly
 * what must not reach a log or a transcript.
 */
import { assert } from "@std/assert";
import { dirname, fromFileUrl, join, relative } from "@std/path";

const ROOT = join(dirname(fromFileUrl(import.meta.url)), "..");
const SELF = fromFileUrl(import.meta.url);
const DENY = Deno.env.get("COMMONS_DENYLIST") || join(ROOT, "..", "_boundary", "denylist.txt");
const SKIP_DIRS = new Set([".git", ".claude", "node_modules", "coverage", ".cache"]);
const SKIP_FILES = new Set(["deno.lock"]);
const BINARY = /\.(png|jpe?g|gif|webp|ico|pdf|eml|zip|gz|wasm|woff2?|ttf)$/i;
/** The organisation's name may appear only in these forms. */
const ALLOWED = ["Simtricity Limited", "github.com/simtricity/", "@simtricity-commons"];

function denylist(): string[] | null {
  let text: string;
  try {
    text = Deno.readTextFileSync(DENY);
  } catch {
    // fallback: no private list on this machine (CI, a fresh clone); the name check skips
    return null;
  }
  return text.split(/\r?\n/).map((w) => w.trim().toLowerCase())
    .filter((w) => w && !w.startsWith("#"));
}

/** Every text file in the repo except skipped dirs, lock files and binaries. */
function* texts(dir = ROOT): Generator<{ path: string; text: string }> {
  for (const e of [...Deno.readDirSync(dir)].sort((a, b) => a.name.localeCompare(b.name))) {
    const path = join(dir, e.name);
    if (e.isDirectory) {
      if (!SKIP_DIRS.has(e.name)) yield* texts(path);
    } else if (e.isFile && !SKIP_FILES.has(e.name) && !BINARY.test(e.name)) {
      yield { path, text: new TextDecoder().decode(Deno.readFileSync(path)) };
    }
  }
}

const rel = (p: string) => relative(ROOT, p);
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const words = denylist();
const skipNote = `private denylist not found at ${DENY} (set COMMONS_DENYLIST)`;

Deno.test({
  name: "no denylisted name appears in the repo",
  ignore: words === null,
  fn() {
    const pats = words!.map((w) => new RegExp(`(?<![a-z0-9])${escape(w)}(?![a-z0-9])`, "i"));
    const found: string[] = [];
    for (const { path, text } of texts()) {
      if (path === SELF) continue;
      text.split(/\r?\n/).forEach((line, i) => {
        if (pats.some((p) => p.test(line))) found.push(`${rel(path)}:${i + 1}`);
      });
    }
    assert(
      !found.length,
      `denylisted names at (word not shown):\n${found.slice(0, 40).join("\n")}`,
    );
  },
});

Deno.test({
  name: "the denylist is read (skips when absent)",
  ignore: words === null,
  fn() {
    assert(words!.length > 15, "the denylist has too few entries to be the real list");
  },
});

Deno.test("Simtricity appears only as the copyright holder, GitHub org or package scope", () => {
  const found: string[] = [];
  for (const { path, text } of texts()) {
    if (path === SELF) continue;
    text.split(/\r?\n/).forEach((line, i) => {
      if (/simtricity/i.test(line) && !ALLOWED.some((a) => line.includes(a))) {
        found.push(`${rel(path)}:${i + 1}`);
      }
    });
  }
  assert(!found.length, `"Simtricity" outside its allowed forms at:\n${found.join("\n")}`);
});

Deno.test("no denylist file is inside the repo", () => {
  const inside = [...texts()].map((t) => rel(t.path)).filter((p) =>
    /denylist/i.test(p.split("/").at(-1)!)
  );
  assert(!inside.length, `a denylist file is inside the repo: ${inside.join(", ")}`);
});

if (words === null) console.warn(`boundary-test: name check skipped: ${skipNote}`);
