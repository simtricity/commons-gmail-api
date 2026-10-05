import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import {
  appendLine,
  layout,
  readJson,
  readJsonOr,
  safeName,
  writeJson,
} from "../../lib/organise/organiser/store.ts";

const mode = async (p: string) => ((await Deno.stat(p)).mode ?? 0) & 0o777;

Deno.test("store: writeJson writes whole files 0600 in 0700 directories, leaving no temp file", async () => {
  const dir = await Deno.makeTempDir();
  const path = layout(dir).run("r1").manifest;
  await writeJson(path, { a: 1 });
  await writeJson(path, { b: 2 });
  assertEquals(await readJson(path), { b: 2 });
  assertEquals(await mode(path), 0o600);
  assertEquals(await mode(layout(dir).run("r1").dir), 0o700);
  const names = [];
  for await (const e of Deno.readDir(layout(dir).run("r1").dir)) names.push(e.name);
  assertEquals(names, ["manifest.json"]);
  await Deno.remove(dir, { recursive: true });
});

Deno.test("store: readJsonOr defaults only for a missing file", async () => {
  const dir = await Deno.makeTempDir();
  assertEquals(await readJsonOr(`${dir}/absent.json`, { cases: [] }), { cases: [] });
  await Deno.writeTextFile(`${dir}/bad.json`, "{ not json");
  await assertRejects(() => readJsonOr(`${dir}/bad.json`, {}), SyntaxError);
  await Deno.remove(dir, { recursive: true });
});

Deno.test("store: appendLine appends one JSON line, 0600", async () => {
  const dir = await Deno.makeTempDir();
  const path = layout(dir).run("r1").applyLog("triage");
  await appendLine(path, { n: 1 });
  await appendLine(path, { n: 2 });
  assertEquals((await Deno.readTextFile(path)).trim().split("\n").map((l) => JSON.parse(l)), [{
    n: 1,
  }, { n: 2 }]);
  assertEquals(await mode(path), 0o600);
  await Deno.remove(dir, { recursive: true });
});

Deno.test("store: run and scheme ids are single safe path segments", () => {
  for (const bad of ["", "../up", "a/b", ".hidden", "a..b", "x".repeat(65), "sp ace"]) {
    assertThrows(() => safeName("run", bad), TypeError);
  }
  assertEquals(safeName("run", "2020-single_500.v2"), "2020-single_500.v2");
  assertThrows(() => layout("/data").run("../../etc"), TypeError);
  assertThrows(() => layout("/data").run("ok").decisions("a/b"), TypeError);
  assert(layout("/data").run("ok").decisions("triage").endsWith("/runs/ok/decisions.triage.json"));
});
