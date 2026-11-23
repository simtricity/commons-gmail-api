/**
 * Offline tests for token refresh: a refused sign-in is reported with Google's code and the
 * credential is kept; failures that can pass are retried; every outcome is recorded.
 */
import { assert, assertEquals, assertInstanceOf, assertRejects } from "@std/assert";
import {
  type AuthEvent,
  GmailClient,
  MemoryTokenStore,
  NotSignedInError,
  type OAuthCredential,
  OAuthError,
  refreshAccessToken,
  TokenEndpointError,
} from "../mod.ts";
import { appendAuthLog, errorText } from "../cli/commands.ts";

const TOKEN = "https://oauth2.googleapis.com/token";
const SECRET = { clientId: "id", clientSecret: "s" };

const json = (o: unknown, status = 200) =>
  new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });

/** A stale credential, so the first request refreshes. */
function stale(extra: Partial<OAuthCredential> = {}): OAuthCredential {
  return {
    refreshToken: "refresh-token-value",
    accessToken: "old",
    accessTokenExpiresAt: new Date(Date.now() - 60_000).toISOString(),
    email: "owner@home.test",
    scope: "https://www.googleapis.com/auth/gmail.readonly",
    savedAt: "2026-11-01T00:00:00.000Z",
    ...extra,
  };
}

/** Token answers in order (a Response, or "network" for a thrown fetch); Gmail always answers. */
function world(answers: (Response | "network")[], cred = stale()) {
  const store = new MemoryTokenStore();
  store.save(cred);
  const events: AuthEvent[] = [];
  let tokenCalls = 0;
  const fetch: typeof globalThis.fetch = (input) => {
    if (String(input) === TOKEN) {
      tokenCalls++;
      const next = answers.shift();
      if (!next) throw new Error("no more token answers");
      if (next === "network") return Promise.reject(new TypeError("connection reset"));
      return Promise.resolve(next);
    }
    return Promise.resolve(json({ emailAddress: cred.email, messagesTotal: 1, threadsTotal: 1 }));
  };
  const gmail = new GmailClient({
    clientSecret: SECRET,
    store,
    fetch,
    refreshRetryBaseMs: 1,
    onAuthEvent: (e) => events.push(e),
  });
  return { gmail, store, events, calls: () => tokenCalls };
}

const ok = () => json({ access_token: "new", expires_in: 3600 });
const kinds = (events: AuthEvent[]) => events.map((e) => e.event);

Deno.test("refresh: invalid_grant is reported with Google's code, and the credential is kept", async () => {
  const w = world([
    json({ error: "invalid_grant", error_description: "Token has been expired or revoked." }, 400),
  ]);
  const e = await assertRejects(() => w.gmail.profile(), NotSignedInError);
  assertEquals(
    e.message,
    "Google rejected the saved sign-in (invalid_grant: Token has been expired or revoked.). Run login.",
  );
  assertInstanceOf(e.cause, OAuthError);
  assertEquals([e.cause.status, e.cause.code], [400, "invalid_grant"]);
  assertEquals(w.calls(), 1, "a refusal is never retried");

  const kept = await w.store.load();
  assert(kept, "the credential survives a refused refresh");
  assertEquals(kept.refreshToken, "refresh-token-value");
  assertEquals(
    { ...kept.lastRefreshError, at: undefined },
    { at: undefined, status: 400, code: "invalid_grant", rejected: true },
  );
  assertEquals(kinds(w.events), ["refresh-rejected"]);
  assertEquals([w.events[0].status, w.events[0].code], [400, "invalid_grant"]);
  assert(!JSON.stringify(w.events).includes("refresh-token-value"), "no token in any event");
});

Deno.test("refresh: a 503 is retried and recovers; success is recorded and clears the last failure", async () => {
  const w = world(
    [json({ error: "backendError" }, 503), ok()],
    stale({ lastRefreshError: { at: "2026-11-02T00:00:00.000Z", status: 503, rejected: false } }),
  );
  assertEquals((await w.gmail.profile()).emailAddress, "owner@home.test");
  assertEquals(w.calls(), 2);
  assertEquals(kinds(w.events), ["refresh-retry", "refresh-recovered"]);
  assertEquals([w.events[0].attempt, w.events[0].status], [1, 503]);
  assertEquals(w.events[1].attempt, 2);
  const saved = (await w.store.load())!;
  assertEquals(saved.accessToken, "new");
  assertEquals(saved.lastRefreshError, undefined);
  assert(saved.lastRefreshAt);
});

Deno.test("refresh: retries run out on 5xx or no response; the credential is kept", async () => {
  const w = world([json({}, 500), json({}, 502), json({ error: "x" }, 503)]);
  const e = await assertRejects(() => w.gmail.profile(), TokenEndpointError);
  assertEquals([e.status, e.code], [503, "x"]);
  assertEquals(w.calls(), 3);
  assertEquals(kinds(w.events), ["refresh-retry", "refresh-retry", "refresh-failed"]);
  const kept = (await w.store.load())!;
  assertEquals([kept.lastRefreshError?.status, kept.lastRefreshError?.rejected], [503, false]);

  const n = world(["network", "network", "network"]);
  const ne = await assertRejects(() => n.gmail.profile(), TokenEndpointError);
  assertEquals(ne.status, undefined);
  assertInstanceOf(ne.cause, TypeError);
  assert(await n.store.load());
  assertEquals((await n.store.load())!.lastRefreshError?.status, undefined);
});

Deno.test("refresh: 429 is retried; invalid_client and other 4xx are refusals; a non-JSON body still reports", async () => {
  const r = world([json({ error: "rate_limit_exceeded" }, 429), ok()]);
  await r.gmail.profile();
  assertEquals(r.calls(), 2);

  const c = world([json({ error: "invalid_client", error_description: "Unauthorized" }, 401)]);
  const ce = await assertRejects(() => c.gmail.profile(), NotSignedInError);
  assertEquals((ce.cause as OAuthError).code, "invalid_client");
  assertEquals(c.calls(), 1);

  const h = world([new Response("<html>bad request</html>", { status: 400 })]);
  const he = await assertRejects(() => h.gmail.profile(), NotSignedInError);
  assertEquals(he.message, "Google rejected the saved sign-in (HTTP 400). Run login.");
  assertEquals((he.cause as OAuthError).code, undefined);
});

Deno.test("refreshAccessToken: attempts and onRetry are honoured", async () => {
  let n = 0;
  const seen: number[] = [];
  const f: typeof globalThis.fetch = () => {
    n++;
    return Promise.resolve(json({}, 500));
  };
  await assertRejects(
    () =>
      refreshAccessToken(SECRET, stale(), {
        fetch: f,
        attempts: 2,
        retryBaseMs: 1,
        onRetry: (x) => seen.push(x.attempt),
      }),
    TokenEndpointError,
  );
  assertEquals([n, seen], [2, [1]]);
});

Deno.test("cli errorText: refresh failures point at the auth log; others pass through", () => {
  const log = "/tmp/auth.log";
  const refused = new NotSignedInError(
    "Google rejected the saved sign-in (invalid_grant). Run login.",
    {
      cause: new OAuthError("x", { status: 400, code: "invalid_grant" }),
    },
  );
  assertEquals(
    errorText({ authLogPath: log }, refused),
    "Google rejected the saved sign-in (invalid_grant). Run login. Details: /tmp/auth.log",
  );
  assertEquals(
    errorText(
      { authLogPath: log },
      new TokenEndpointError("Google's token endpoint answered 503.", { status: 503 }),
    ),
    "Google's token endpoint answered 503. Details: /tmp/auth.log",
  );
  assertEquals(
    errorText({ authLogPath: log }, new NotSignedInError("Not signed in. Run login.")),
    "Not signed in. Run login.",
    "one sign-in: never login --write",
  );
  assertEquals(errorText({ authLogPath: log }, new Error("other")), "other");
});

Deno.test("cli appendAuthLog: one JSON line per event, 0600, tagged with scope names, never a token", async () => {
  const dir = await Deno.makeTempDir({ prefix: "gmail-auth-log-" });
  const path = `${dir}/sub/auth.log`;
  const credentialsPath = `${dir}/credentials.json`;
  await Deno.writeTextFile(
    credentialsPath,
    JSON.stringify({
      version: 1,
      default: "owner@home.test",
      accounts: {
        "owner@home.test": {
          email: "owner@home.test",
          refreshToken: "r",
          scope:
            "https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.modify",
          savedAt: "2026-11-23T00:00:00.000Z",
        },
      },
    }),
  );
  appendAuthLog({ credentialsPath, authLogPath: path }, {
    at: "2026-11-08T00:00:00.000Z",
    event: "refresh-rejected",
    account: "owner@home.test",
    status: 400,
    code: "invalid_grant",
  });
  appendAuthLog({ credentialsPath, authLogPath: path }, {
    at: "2026-11-08T00:00:01.000Z",
    event: "login",
    account: "owner@home.test",
    scopes: [
      "https://www.googleapis.com/auth/gmail.readonly",
      "https://www.googleapis.com/auth/gmail.modify",
      "https://www.googleapis.com/auth/gmail.compose",
    ],
  });
  const text = await Deno.readTextFile(path);
  const lines = text.trim().split("\n").map((l) => JSON.parse(l));
  assertEquals(lines.map((l) => [l.event, l.grant]), [
    ["refresh-rejected", ["readonly", "modify"]],
    ["login", ["readonly", "modify", "compose"]],
  ]);
  assert(!text.includes('"r"'), "never a token");
  assertEquals(((await Deno.stat(path)).mode ?? 0) & 0o777, 0o600);
  appendAuthLog({ credentialsPath: "/nope", authLogPath: "/dev/null/nope/auth.log" }, lines[0]); // never throws
  await Deno.remove(dir, { recursive: true });
});
