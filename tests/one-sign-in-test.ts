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
