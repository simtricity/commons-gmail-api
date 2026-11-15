/**
 * The core entry point never loads the organiser. `mod.ts` and every core `lib/*.ts` must not
 * import or re-export anything under `lib/organise/`, so a plain Gmail user never downloads the
 * engine or the decision-model client. The dependency runs one way: organise may import core.
 */
import { assert, assertEquals } from "@std/assert";
import { dirname, fromFileUrl, join } from "@std/path";

const ROOT = join(dirname(fromFileUrl(import.meta.url)), "..");

/** Module specifiers of every static import/export and dynamic import in a source text. */
function specifiers(src: string): string[] {
  const out: string[] = [];
  for (const m of src.matchAll(/\b(?:import|export)\b[^"';]*?\bfrom\s*["']([^"']+)["']/g)) {
    out.push(m[1]);
  }
  for (const m of src.matchAll(/\bimport\s*\(\s*["']([^"']+)["']\s*\)/g)) out.push(m[1]);
  for (const m of src.matchAll(/^\s*import\s+["']([^"']+)["']/gm)) out.push(m[1]);
  return out;
}

const core = [
  "mod.ts",
  ...[...Deno.readDirSync(join(ROOT, "lib"))]
    .filter((e) => e.isFile && e.name.endsWith(".ts"))
    .map((e) => `lib/${e.name}`),
].sort();

Deno.test("the scan sees the core files", () => {
  assert(core.includes("mod.ts") && core.includes("lib/client.ts") && core.length > 10);
});

Deno.test("mod.ts and core lib/*.ts never import lib/organise/", () => {
  const offenders: string[] = [];
  for (const f of core) {
    for (const s of specifiers(Deno.readTextFileSync(join(ROOT, f)))) {
      if (/(^|\/)organise(\/|\.ts$)/.test(s)) offenders.push(`${f} → ${s}`);
    }
  }
  assertEquals(offenders, [], "core must not depend on the organiser");
});

Deno.test("the specifier scan catches every import form", () => {
  const src = [
    'import { a } from "./organise/mod.ts";',
    'export * from "../organise.ts";',
    'const m = await import("./organise/x.ts");',
    'import "./organise/side.ts";',
    'import type { T } from "./types.ts";',
  ].join("\n");
  assertEquals(specifiers(src), [
    "./organise/mod.ts",
    "../organise.ts",
    "./types.ts",
    "./organise/x.ts",
    "./organise/side.ts",
  ]);
});

Deno.test("lib/organise reads no environment and computes no home-relative path", () => {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const e of Deno.readDirSync(join(ROOT, dir))) {
      const rel = `${dir}/${e.name}`;
      if (e.isDirectory) walk(rel);
      else if (e.name.endsWith(".ts")) files.push(rel);
    }
  };
  walk("lib/organise");
  assert(files.length > 20, "the walk sees the organise tree");
  const banned = [/\bDeno\.env\b/, /\bHOME\b/, /\bhomedir\b/, /["'`]~\//, /USERPROFILE/];
  const offenders: string[] = [];
  for (const f of files) {
    Deno.readTextFileSync(join(ROOT, f)).split("\n").forEach((line, i) => {
      if (banned.some((b) => b.test(line))) offenders.push(`${f}:${i + 1}`);
    });
  }
  assertEquals(offenders, [], "paths under lib/organise come only from the caller");
});
