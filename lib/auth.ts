/**
 * Google OAuth 2.0 for an "installed" (desktop) client: loopback login with PKCE,
 * refresh, revoke. Plain HTTP, no SDK.
 *
 * Env-agnostic: everything (client secret, port, browser opener, logger) is passed in.
 * @module
 */

import { OAuthError } from "./errors.ts";
import type { ClientSecret, OAuthCredential } from "./types.ts";

/** The only scope this package uses unless a caller explicitly widens it. */
export const SCOPE_READONLY = "https://www.googleapis.com/auth/gmail.readonly";

const AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const REVOKE_ENDPOINT = "https://oauth2.googleapis.com/revoke";
const PROFILE_ENDPOINT = "https://gmail.googleapis.com/gmail/v1/users/me/profile";

/**
 * Parse a Cloud Console `client_secret*.json` download. Accepts the `installed` and
 * `web` wrappers and a bare `{client_id, client_secret}`.
 *
 * Errors name the source, never the contents.
 */
export function parseClientSecret(
  raw: string,
  source = "client secret",
): ClientSecret {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new OAuthError(`Could not parse ${source} as JSON.`);
  }
  const holder = parsed as Record<string, Record<string, string> | undefined>;
  const block = holder.installed ?? holder.web ??
    (parsed as Record<string, string>);
  const clientId = block?.client_id;
  const clientSecret = block?.client_secret;
  if (!clientId || !clientSecret) {
    throw new OAuthError(`${source} has no client_id/client_secret.`);
  }
  return { clientId, clientSecret };
}

/** Read a Google OAuth client-secret JSON file (Desktop-app client) and parse it. Never logs contents. */
export async function loadClientSecretFile(
  path: string,
): Promise<ClientSecret> {
  let raw: string;
  try {
    raw = await Deno.readTextFile(path);
  } catch {
    throw new OAuthError(
      `No OAuth client secret at ${path}.\n` +
        `  Download one from the Google Cloud Console (OAuth client ID, type "Desktop app").`,
    );
  }
  return parseClientSecret(raw, path);
}

function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function sha256Base64Url(input: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(input),
  );
  return base64url(new Uint8Array(digest));
}

function randomToken(bytes: number): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return base64url(buf);
}

const closeTabPage = (title: string, detail: string) =>
  `<html><body style="font-family:system-ui;max-width:420px;margin:80px auto;text-align:center">
    <h2>${title}</h2><p style="color:#666">${detail}</p></body></html>`;

/**
 * Bind the loopback callback BEFORE the browser opens. Fixed port: a redirect URI that
 * silently moved would not match what we told Google, and the failure would surface as
 * an opaque provider error.
 */
function bindCallback(port: number, expectedState: string): {
  code: Promise<string | null>;
  close: () => void;
} {
  const controller = new AbortController();
  let resolveCode!: (code: string | null) => void;
  const code = new Promise<string | null>((r) => (resolveCode = r));

  try {
    Deno.serve({
      hostname: "127.0.0.1",
      port,
      signal: controller.signal,
      onListen() {},
    }, (req) => {
      const url = new URL(req.url);
      if (url.pathname !== "/callback") {
        return new Response("Not found", { status: 404 });
      }
      const html = { headers: { "Content-Type": "text/html" } };
      // Validate `state` BEFORE accepting the code: otherwise any page in the browser
      // could hand us an authorisation code for a mailbox that isn't the user's.
      if (url.searchParams.get("state") !== expectedState) {
        resolveCode(null);
        return new Response(
          closeTabPage(
            "Sign-in did not complete",
            "The callback did not match this sign-in.",
          ),
          { status: 400, ...html },
        );
      }
      const err = url.searchParams.get("error");
      const got = url.searchParams.get("code");
      if (err || !got) {
        resolveCode(null);
        return new Response(
          closeTabPage(
            "Sign-in did not complete",
            err ?? "No authorisation code arrived.",
          ),
          { status: 400, ...html },
        );
      }
      resolveCode(got);
      return new Response(
        closeTabPage("Signed in to Gmail", "You can close this tab."),
        html,
      );
    });
  } catch {
    throw new OAuthError(
      `Could not bind 127.0.0.1:${port} — something else is using it. Free it and retry.`,
    );
  }
  return { code, close: () => controller.abort() };
}

/** Build the Google OAuth authorization URL for a PKCE (S256) code flow requesting exactly `scopes`, offline access, and a consent prompt. */
export function buildAuthUrl(input: {
  clientId: string;
  redirectUri: string;
  challenge: string;
  state: string;
  scopes: string[];
}): string {
  return `${AUTH_ENDPOINT}?` + new URLSearchParams({
    client_id: input.clientId,
    redirect_uri: input.redirectUri,
    response_type: "code",
    code_challenge: input.challenge,
    code_challenge_method: "S256",
    scope: input.scopes.join(" "),
    access_type: "offline",
    // Force consent so Google reliably returns a refresh token.
    prompt: "consent",
    state: input.state,
  });
}

/** Options for `loginInteractive`. */
export interface LoginOptions {
  /** The Desktop-app OAuth client to sign in with. */
  clientSecret: ClientSecret;
  /** Defaults to `[SCOPE_READONLY]`. Widening is a deliberate caller decision. */
  scopes?: string[];
  /** Loopback port for the redirect. */
  port: number;
  /** Called with the URL; default opens the platform browser. Return false to skip. */
  openBrowser?: (url: string) => boolean | void;
  /** Progress lines. Default: stderr. */
  log?: (line: string) => void;
  /** Reject a login that lands on a different mailbox. */
  expectedEmail?: string;
  /** Give up waiting for the browser after this many milliseconds. */
  timeoutMs?: number;
}

function defaultOpenBrowser(url: string): boolean {
  const cmd = Deno.build.os === "darwin"
    ? "open"
    : Deno.build.os === "windows"
    ? "start"
    : "xdg-open";
  try {
    new Deno.Command(cmd, { args: [url] }).spawn();
    return true;
  } catch {
    return false;
  }
}

/** Interactive login. Returns the credential; the caller decides where it is stored. */
export async function loginInteractive(
  opts: LoginOptions,
): Promise<OAuthCredential> {
  const log = opts.log ?? ((l) => console.error(l));
  const scopes = opts.scopes ?? [SCOPE_READONLY];
  const redirectUri = `http://127.0.0.1:${opts.port}/callback`;
  const timeoutMs = opts.timeoutMs ?? 5 * 60_000;

  const verifier = randomToken(32);
  const challenge = await sha256Base64Url(verifier);
  const state = randomToken(16);

  const { code: codePromise, close } = bindCallback(opts.port, state);
  const authUrl = buildAuthUrl({
    clientId: opts.clientSecret.clientId,
    redirectUri,
    challenge,
    state,
    scopes,
  });

  log(
    `Signing in to Google (${scopes.map((s) => s.split("/").at(-1)).join(", ")})`,
  );
  log(`  → ${authUrl}`);
  const opened = (opts.openBrowser ?? defaultOpenBrowser)(authUrl);
  if (opened === false) log("  (open the URL above in a browser)");
  log("Waiting for the browser to complete sign-in...");

  const code = await Promise.race([
    codePromise,
    new Promise<null>((r) => setTimeout(() => r(null), timeoutMs)),
  ]);
  // Let the browser receive the response body before the listener goes away.
  setTimeout(close, 250);
  if (!code) {
    throw new OAuthError("Sign-in did not complete (no authorisation code).");
  }

  const res = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: opts.clientSecret.clientId,
      client_secret: opts.clientSecret.clientSecret,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
      code_verifier: verifier,
    }),
  });
  if (!res.ok) {
    throw new OAuthError(
      `Token exchange failed (${res.status}): ${await res.text().catch(() => "")}`,
    );
  }
  const tok = await res.json() as {
    access_token: string;
    refresh_token?: string;
    expires_in: number;
    scope: string;
  };
  if (!tok.refresh_token) {
    throw new OAuthError(
      "Google returned no refresh token. Revoke this app at " +
        "https://myaccount.google.com/permissions and sign in again.",
    );
  }

  const email = await fetchProfileEmail(tok.access_token);
  if (
    opts.expectedEmail &&
    email.toLowerCase() !== opts.expectedEmail.toLowerCase()
  ) {
    // Revoke immediately: a refused login must leave no live grant behind.
    await revokeToken(tok.refresh_token).catch(() => {});
    throw new OAuthError(
      `Signed in as ${email}, expected ${opts.expectedEmail}. Grant revoked.`,
    );
  }

  const now = new Date();
  return {
    refreshToken: tok.refresh_token,
    accessToken: tok.access_token,
    accessTokenExpiresAt: new Date(now.getTime() + tok.expires_in * 1000)
      .toISOString(),
    email,
    scope: tok.scope,
    savedAt: now.toISOString(),
  };
}

async function fetchProfileEmail(accessToken: string): Promise<string> {
  const res = await fetch(PROFILE_ENDPOINT, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    throw new OAuthError(`Could not read mailbox profile (${res.status}).`);
  }
  const data = await res.json() as { emailAddress?: string };
  if (!data.emailAddress) {
    throw new OAuthError("Profile returned no emailAddress.");
  }
  return data.emailAddress;
}

/** Access token stale (or about to be) — refresh 60s early. */
export function isAccessTokenStale(
  cred: OAuthCredential,
  now: Date = new Date(),
): boolean {
  return new Date(cred.accessTokenExpiresAt).getTime() - now.getTime() < 60_000;
}

/** Mint a fresh access token. Throws {@link OAuthError} if Google rejects the refresh token. */
export async function refreshAccessToken(
  clientSecret: ClientSecret,
  cred: OAuthCredential,
): Promise<OAuthCredential> {
  const res = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      refresh_token: cred.refreshToken,
      client_id: clientSecret.clientId,
      client_secret: clientSecret.clientSecret,
      grant_type: "refresh_token",
    }),
  });
  if (!res.ok) {
    throw new OAuthError(
      `Google rejected the stored credential (${res.status}).`,
    );
  }
  const tok = await res.json() as { access_token: string; expires_in: number };
  return {
    ...cred,
    accessToken: tok.access_token,
    accessTokenExpiresAt: new Date(Date.now() + tok.expires_in * 1000)
      .toISOString(),
  };
}

/** Revoke a refresh (or access) token at Google. Resolves true on 200. */
export async function revokeToken(token: string): Promise<boolean> {
  const res = await fetch(REVOKE_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ token }),
  });
  return res.ok;
}
