/**
 * Offline tests for 0.9.0: one sign-in for every scope, the migration from the old write file,
 * and a logout that asks first. Temp dirs and stubs only; never the real `~/.simt/gmail-api/`.
 */
import { assert, assertEquals, assertRejects } from "@std/assert";
import {
  loginInteractive,
  type OAuthCredential,
  OAuthError,
  SCOPE_COMPOSE,
  SCOPE_MODIFY,
  SCOPE_READONLY,
  SCOPES_ALL,
  SCOPES_WRITE,
} from "../mod.ts";
import { contextFromEnv, login, LOGIN_SCOPES, WRITE_FLAG_IGNORED } from "../cli/commands.ts";
import { migrateWriteSignIn } from "../cli/migrate.ts";

export const ALL = `${SCOPE_READONLY} ${SCOPE_MODIFY} ${SCOPE_COMPOSE}`;

/** A credential for `email` holding `scope`. Synthetic. */
export const cred = (email: string, scope: string, token = `r-${email}`): OAuthCredential => ({
  email,
  refreshToken: token,
  accessToken: `a-${email}`,
  accessTokenExpiresAt: "2026-11-23T10:00:00.000Z",
  scope,
  savedAt: "2026-11-23T09:00:00.000Z",
});

/** A temp dir with `GMAIL_API_CREDENTIALS` pointed into it for the test's duration. */
export async function withTempHome<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await Deno.makeTempDir({ prefix: "gmail-one-sign-in-" });
  const keep = Deno.env.get("GMAIL_API_CREDENTIALS");
  Deno.env.set("GMAIL_API_CREDENTIALS", `${dir}/credentials.json`);
  try {
    return await fn(dir);
  } finally {
    if (keep === undefined) Deno.env.delete("GMAIL_API_CREDENTIALS");
    else Deno.env.set("GMAIL_API_CREDENTIALS", keep);
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test("SCOPES_ALL is read, modify and compose; SCOPES_WRITE is its deprecated alias", () => {
  assertEquals([...SCOPES_ALL], [SCOPE_READONLY, SCOPE_MODIFY, SCOPE_COMPOSE]);
  assertEquals(SCOPES_WRITE, SCOPES_ALL);
  assertEquals(LOGIN_SCOPES, SCOPES_ALL);
});

Deno.test("CLI login asks for every scope and saves to the one credential file", async () => {
  await withTempHome(async (dir) => {
    const ctx = contextFromEnv({ json: true });
    assertEquals(ctx.credentialsPath, `${dir}/credentials.json`);
    let asked: string[] = [];
    const logged: string[] = [];
    const out = console.log;
    console.log = (s: string) => logged.push(s);
    try {
      await login(ctx, {
        clientSecret: { clientId: "id", clientSecret: "s" },
        loginInteractive: (o) => {
          asked = o.scopes ?? [];
          return Promise.resolve(cred("owner@home.test", (o.scopes ?? []).join(" ")));
        },
      });
    } finally {
      console.log = out;
    }
    assertEquals(asked, [SCOPE_READONLY, SCOPE_MODIFY, SCOPE_COMPOSE]);
    const saved = await ctx.store.load("owner@home.test");
    assertEquals(saved?.scope, ALL);
    assertEquals(JSON.parse(logged[0]).store, `${dir}/credentials.json`);
  });
});

Deno.test("the library's own login default is still read-only", async () => {
  let url = "";
  const port = 8731 + 1000 + Math.floor(Math.random() * 500);
  await assertRejects(
    () =>
      loginInteractive({
        clientSecret: { clientId: "id", clientSecret: "s" },
        port,
        openBrowser: (u) => {
          url = u;
          return false;
        },
        log: () => {},
        timeoutMs: 50,
      }),
    OAuthError,
  );
  await new Promise((r) => setTimeout(r, 300)); // let the loopback listener close
  assertEquals(new URL(url).searchParams.get("scope"), SCOPE_READONLY);
});

Deno.test("--write is no longer needed: the notice is one line", () => {
  assert(!WRITE_FLAG_IGNORED.includes("\n"));
  assert(WRITE_FLAG_IGNORED.startsWith("--write is no longer needed"));
});

// ── Migration from credentials.modify.json ──────────────────────────────────

const READ_ONLY = SCOPE_READONLY;
const NOW = new Date("2026-11-23T13:30:00.000Z");
const store = (accounts: Record<string, OAuthCredential>, def?: string) =>
  JSON.stringify({ version: 1, default: def ?? Object.keys(accounts)[0], accounts }, null, 2);
const mode = async (p: string) => ((await Deno.stat(p)).mode ?? 0) & 0o777;

/** Run with every fetch failing loudly: the migration must never touch the network. */
async function offline<T>(fn: () => Promise<T>): Promise<T> {
  const real = globalThis.fetch;
  globalThis.fetch = () => {
    throw new Error("network call during migration");
  };
  try {
    return await fn();
  } finally {
    globalThis.fetch = real;
  }
}

Deno.test("migration: the write sign-in replaces a read-only entry; backup, rename, tombstone, 0600", async () => {
  await withTempHome(async (dir) => {
    const credentialsPath = `${dir}/credentials.json`;
    const modifyPath = `${dir}/credentials.modify.json`;
    const readFile = store({ "owner@home.test": cred("owner@home.test", READ_ONLY, "r-old") });
    await Deno.writeTextFile(credentialsPath, readFile, { mode: 0o600 });
    await Deno.writeTextFile(
      modifyPath,
      store({ "owner@home.test": cred("owner@home.test", ALL, "r-write") }),
      { mode: 0o600 },
    );
    const r = await offline(() => migrateWriteSignIn({ credentialsPath, modifyPath, now: NOW }));
    assertEquals(r.copied, ["owner@home.test"]);
    const now = JSON.parse(await Deno.readTextFile(credentialsPath));
    assertEquals(now.accounts["owner@home.test"].refreshToken, "r-write");
    assertEquals(now.default, "owner@home.test");
    assertEquals(r.backup, `${credentialsPath}.bak-2026-11-23T13-30-00Z`);
    assertEquals(await Deno.readTextFile(r.backup!), readFile, "backup is the file as it was");
    assertEquals(r.renamedTo, `${modifyPath}.migrated-2026-11-23T13-30-00Z`);
    await assertRejects(() => Deno.stat(modifyPath), Deno.errors.NotFound);
    assert((await Deno.readTextFile(r.tombstone!)).includes("Nothing was revoked"));
    for (const p of [credentialsPath, r.backup!, r.renamedTo!, r.tombstone!]) {
      assertEquals(await mode(p), 0o600, p);
    }

    const again = await offline(() =>
      migrateWriteSignIn({ credentialsPath, modifyPath, now: NOW })
    );
    assertEquals(again, { ran: false, copied: [], leftAlone: [] }, "a second run is a no-op");
  });
});

Deno.test("migration: copies into a missing file, keeps others, leaves complete and partial entries", async () => {
  await withTempHome(async (dir) => {
    const credentialsPath = `${dir}/sub/credentials.json`;
    const modifyPath = `${dir}/credentials.modify.json`;
    await Deno.writeTextFile(
      modifyPath,
      store({
        "a@home.test": cred("a@home.test", ALL),
        "b@home.test": cred("b@home.test", `${SCOPE_READONLY} ${SCOPE_MODIFY}`),
      }),
    );
    const r = await offline(() => migrateWriteSignIn({ credentialsPath, modifyPath, now: NOW }));
    assertEquals([r.copied, r.leftAlone, r.backup], [["a@home.test"], ["b@home.test"], undefined]);
    const now = JSON.parse(await Deno.readTextFile(credentialsPath));
    assertEquals(Object.keys(now.accounts), ["a@home.test"], "a partial grant is not copied");
  });

  await withTempHome(async (dir) => {
    const credentialsPath = `${dir}/credentials.json`;
    const modifyPath = `${dir}/credentials.modify.json`;
    const readFile = store({
      "a@home.test": cred("a@home.test", ALL, "r-already-complete"),
      "c@home.test": cred("c@home.test", READ_ONLY),
    });
    await Deno.writeTextFile(credentialsPath, readFile);
    await Deno.writeTextFile(
      modifyPath,
      store({ "a@home.test": cred("a@home.test", ALL, "r-older") }),
    );
    const r = await offline(() => migrateWriteSignIn({ credentialsPath, modifyPath, now: NOW }));
    assertEquals([r.copied, r.leftAlone, r.backup], [[], ["a@home.test"], undefined]);
    assertEquals(await Deno.readTextFile(credentialsPath), readFile, "unchanged, byte for byte");
    assert(r.renamedTo && r.tombstone, "the old file is still retired");
  });
});
