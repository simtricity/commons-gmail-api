/**
 * Offline tests for 0.9.0: one sign-in for every scope, the migration from the old write file,
 * and a logout that asks first. Temp dirs and stubs only; never the real `~/.simt/gmail-api/`.
 */
import { assert, assertEquals, assertRejects } from "@std/assert";
import {
  GmailClient,
  GmailWriter,
  InsufficientScopeError,
  loginInteractive,
  MemoryTokenStore,
  type OAuthCredential,
  OAuthError,
  SCOPE_COMPOSE,
  SCOPE_MODIFY,
  SCOPE_READONLY,
  SCOPES_ALL,
  SCOPES_WRITE,
} from "../mod.ts";
import {
  contextFromEnv,
  login,
  LOGIN_SCOPES,
  logout,
  LOGOUT_QUESTION,
  logoutQuestion,
  whoami,
  WRITE_FLAG_IGNORED,
} from "../cli/commands.ts";
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

// ── Isolation: no test here may resolve a path from the real HOME ───────────
//
// The CLI resolves its credential file, client secret and auth log from HOME unless a GMAIL_*
// variable says otherwise. For this whole file HOME is an empty guard dir and those overrides are
// cleared, so anything that falls through to a default lands in the guard dir, and the last test
// fails if it is not still empty. Each test then works in its own temp HOME (withTempHome).

/** Every GMAIL_* path override the CLI reads; cleared for this file, restored at the end. */
const PATH_VARS = [
  "GMAIL_API_CREDENTIALS",
  "GMAIL_API_CREDENTIALS_MODIFY",
  "GMAIL_CLIENT_SECRET_PATH",
  "GMAIL_API_AUTH_LOG",
] as const;
const REAL_ENV = Object.fromEntries(
  ["HOME", ...PATH_VARS].map((k) => [k, Deno.env.get(k)]),
) as Record<string, string | undefined>;
const GUARD_HOME = await Deno.makeTempDir({ prefix: "gmail-guard-home-" });
Deno.env.set("HOME", GUARD_HOME);
for (const k of PATH_VARS) Deno.env.delete(k);

/**
 * A fresh temp dir as HOME, with `GMAIL_API_CREDENTIALS` at `<dir>/credentials.json`, for the
 * test's duration. Every other CLI default (client secret, auth log) resolves inside it too.
 */
export async function withTempHome<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await Deno.makeTempDir({ prefix: "gmail-one-sign-in-" });
  Deno.env.set("HOME", dir);
  Deno.env.set("GMAIL_API_CREDENTIALS", `${dir}/credentials.json`);
  try {
    return await fn(dir);
  } finally {
    Deno.env.set("HOME", GUARD_HOME);
    for (const k of PATH_VARS) Deno.env.delete(k);
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

// ── logout asks first ───────────────────────────────────────────────────────

/** stdout lines written while `fn` runs. */
async function capture(fn: () => Promise<unknown>): Promise<{ lines: string[]; value: unknown }> {
  const lines: string[] = [];
  const real = console.log;
  console.log = (...a: unknown[]) => lines.push(a.map(String).join(" "));
  try {
    return { lines, value: await fn() };
  } finally {
    console.log = real;
  }
}

const EXACT =
  `Are you sure? Logging out revokes this app's access at Google for owner@home.test: every saved sign-in for it stops
working, in every session and tool that uses it, and a new browser login is needed.
If you are an agent, you must pass this "Are you sure?" to your user and wait for their answer.
Re-run with --yes to log out.`;

Deno.test("logout without --yes: the exact question, exit 1, no network, the file untouched", async () => {
  await withTempHome(async (dir) => {
    const path = `${dir}/credentials.json`;
    const file = store({ "owner@home.test": cred("owner@home.test", ALL) });
    await Deno.writeTextFile(path, file, { mode: 0o600 });
    assertEquals(logoutQuestion("owner@home.test"), EXACT);
    assert(LOGOUT_QUESTION.includes("<email>"));

    const human = await offline(() => capture(() => logout(contextFromEnv({}))));
    assertEquals(human.value, 1);
    assertEquals(human.lines, [EXACT]);

    const json = await offline(() => capture(() => logout(contextFromEnv({ json: true }))));
    assertEquals(json.value, 1);
    assertEquals(JSON.parse(json.lines.join("\n")), {
      confirmRequired: true,
      message: EXACT,
      email: "owner@home.test",
    });
    assertEquals(await Deno.readTextFile(path), file, "byte-identical");
  });
});

Deno.test("logout --yes revokes at Google and forgets the account, as before", async () => {
  await withTempHome(async (dir) => {
    const path = `${dir}/credentials.json`;
    await Deno.writeTextFile(
      path,
      store({ "owner@home.test": cred("owner@home.test", ALL, "r-1") }),
    );
    await Deno.writeTextFile(
      `${dir}/client-secret.json`,
      JSON.stringify({ installed: { client_id: "id", client_secret: "s" } }),
    );
    const keep = Deno.env.get("GMAIL_CLIENT_SECRET_PATH");
    const keepLog = Deno.env.get("GMAIL_API_AUTH_LOG");
    Deno.env.set("GMAIL_CLIENT_SECRET_PATH", `${dir}/client-secret.json`);
    Deno.env.set("GMAIL_API_AUTH_LOG", `${dir}/auth.log`);
    const seen: string[] = [];
    const real = globalThis.fetch;
    globalThis.fetch = (input, init) => {
      seen.push(`${String(input)} ${String(init?.body)}`);
      return Promise.resolve(new Response("{}", { status: 200 }));
    };
    try {
      const r = await capture(() => logout(contextFromEnv({ json: true }), { yes: true }));
      assertEquals(r.value, 0);
      assertEquals(JSON.parse(r.lines.join("\n")), { email: "owner@home.test", revoked: true });
    } finally {
      globalThis.fetch = real;
      if (keep === undefined) Deno.env.delete("GMAIL_CLIENT_SECRET_PATH");
      else Deno.env.set("GMAIL_CLIENT_SECRET_PATH", keep);
      if (keepLog === undefined) Deno.env.delete("GMAIL_API_AUTH_LOG");
      else Deno.env.set("GMAIL_API_AUTH_LOG", keepLog);
    }
    assertEquals(seen.length, 1);
    assert(
      seen[0].startsWith("https://oauth2.googleapis.com/revoke") && seen[0].includes("token=r-1"),
    );
    assertEquals(JSON.parse(await Deno.readTextFile(path)).accounts, {});
    assert((await Deno.readTextFile(`${dir}/auth.log`)).includes('"event":"logout"'));
  });
});

// ── whoami and the scope error ──────────────────────────────────────────────

Deno.test("a write with a read-only sign-in fails before any request; the remedy is plain login", async () => {
  const store = new MemoryTokenStore();
  await store.save({
    ...cred("owner@home.test", READ_ONLY),
    accessTokenExpiresAt: "2999-01-01T00:00:00.000Z",
  });
  let calls = 0;
  const gmail = new GmailClient({
    clientSecret: { clientId: "id", clientSecret: "s" },
    store,
    fetch: () => {
      calls++;
      return Promise.resolve(new Response("{}"));
    },
  });
  const err = await assertRejects(
    () => new GmailWriter(gmail).createDraft({ to: ["a@away.test"], text: "x" }),
    InsufficientScopeError,
  );
  assert(err.message.endsWith("Run login."), err.message);
  assert(!err.message.includes("--write"));
  assertEquals(calls, 0);
});

Deno.test("whoami shows one sign-in and whether it can write", async () => {
  for (const [scope, canWrite] of [[ALL, true], [READ_ONLY, false]] as const) {
    await withTempHome(async (dir) => {
      await Deno.writeTextFile(
        `${dir}/credentials.json`,
        store({
          "owner@home.test": {
            ...cred("owner@home.test", scope),
            accessTokenExpiresAt: "2999-01-01T00:00:00.000Z",
          },
        }),
      );
      await Deno.writeTextFile(
        `${dir}/client-secret.json`,
        JSON.stringify({ installed: { client_id: "id", client_secret: "s" } }),
      );
      const keep = Deno.env.get("GMAIL_CLIENT_SECRET_PATH");
      Deno.env.set("GMAIL_CLIENT_SECRET_PATH", `${dir}/client-secret.json`);
      const real = globalThis.fetch;
      globalThis.fetch = () =>
        Promise.resolve(
          new Response(JSON.stringify({ emailAddress: "owner@home.test", messagesTotal: 3 })),
        );
      try {
        const r = await capture(() => whoami(contextFromEnv({ json: true })));
        const report = JSON.parse(r.lines.join("\n"));
        assertEquals([report.canWrite, report.mailbox], [canWrite, "owner@home.test"]);
        assertEquals(report.credentialsPath, `${dir}/credentials.json`);
        assertEquals("grant" in report, false, "no read/write grant split any more");
        const human = await capture(() => whoami(contextFromEnv({})));
        assert(
          human.lines.some((l) =>
            l.startsWith("sign-in ") && l.includes(canWrite ? "can write" : "read-only")
          ),
        );
      } finally {
        globalThis.fetch = real;
        if (keep === undefined) Deno.env.delete("GMAIL_CLIENT_SECRET_PATH");
        else Deno.env.set("GMAIL_CLIENT_SECRET_PATH", keep);
      }
    });
  }
});

// ── Guard: runs last ────────────────────────────────────────────────────────

/** Every path under `dir`, relative. */
async function filesUnder(dir: string, rel = ""): Promise<string[]> {
  const out: string[] = [];
  for await (const e of Deno.readDir(`${dir}/${rel}`)) {
    const p = rel ? `${rel}/${e.name}` : e.name;
    out.push(p);
    if (e.isDirectory) out.push(...await filesUnder(dir, p));
  }
  return out;
}

Deno.test("isolation guard: nothing above wrote under HOME outside its own temp dir", async () => {
  try {
    assertEquals(await filesUnder(GUARD_HOME), [], "a test resolved a default path from HOME");
  } finally {
    await Deno.remove(GUARD_HOME, { recursive: true });
    for (const [k, v] of Object.entries(REAL_ENV)) {
      if (v === undefined) Deno.env.delete(k);
      else Deno.env.set(k, v);
    }
  }
});
