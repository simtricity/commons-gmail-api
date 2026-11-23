/**
 * CLI command bodies. This is the only layer that touches `Deno.env`.
 * @module
 */

import {
  type AuthEvent,
  type ClientSecret,
  DEFAULT_MAX_IDS,
  fetchMessageAttachments,
  fetchThreadAttachments,
  FileTokenStore,
  findBounces,
  GmailClient,
  GmailWriter,
  GuardedWriter,
  loadClientSecretFile,
  loginInteractive,
  NotSignedInError,
  OAuthError,
  parseGmailId,
  rawMessage,
  readMessages,
  SCOPES_ALL,
  searchThreads,
  sha256Hex,
  summarize,
  TokenEndpointError,
} from "../lib/mod.ts";
import type { FetchAttachmentsOptions } from "../lib/attachments.ts";
import type { ReadMessage } from "../lib/body.ts";
import { basename, dirname, join } from "@std/path";

export interface Context {
  account?: string;
  json: boolean;
  clientSecretPath: string;
  /** The one credential file: every command uses it (since 0.9.0). */
  credentialsPath: string;
  loopbackPort: number;
  noBrowser: boolean;
  store: FileTokenStore;
  /** JSON-lines log of sign-in events (logins, refresh failures); never tokens. */
  authLogPath: string;
}

export function contextFromEnv(
  input: { account?: string; json?: boolean },
): Context {
  const home = Deno.env.get("HOME") ?? ".";
  const clientSecretPath = Deno.env.get("GMAIL_CLIENT_SECRET_PATH") ??
    `${home}/.simt/gmail-api/client-secret.json`;
  // One sign-in, one file (0.9.0). The old write file is migrated by `migrateFromEnv`.
  const credentialsPath = Deno.env.get("GMAIL_API_CREDENTIALS") ??
    `${home}/.simt/gmail-api/credentials.json`;
  return {
    account: input.account ?? Deno.env.get("GMAIL_ACCOUNT") ?? undefined,
    json: input.json ?? false,
    clientSecretPath,
    credentialsPath,
    loopbackPort: Number(Deno.env.get("GMAIL_API_LOOPBACK_PORT") ?? "8731"),
    noBrowser: Deno.env.get("GMAIL_NO_BROWSER") === "1",
    store: new FileTokenStore({ path: credentialsPath }),
    authLogPath: Deno.env.get("GMAIL_API_AUTH_LOG") ?? `${home}/.simt/gmail-api/auth.log`,
  };
}

/** The printed form of `--write`, which 0.9.0 no longer needs. */
export const WRITE_FLAG_IGNORED =
  "--write is no longer needed: login grants read, labels and drafts in one sign-in.";

/** The scopes the CLI's `login` asks for: every scope the package uses, in one consent. */
export const LOGIN_SCOPES: readonly string[] = SCOPES_ALL;

/** Scope short names (`readonly`, `modify`, `compose`). */
export const scopeNames = (scope: string | string[]): string[] =>
  (Array.isArray(scope) ? scope : scope.split(" ")).filter(Boolean).map((s) =>
    s.split("/").at(-1)!.replace(/^gmail\./, "")
  );

/** The short scope names the stored sign-in for `account` holds; [] when unreadable. */
function storedGrant(credentialsPath: string, account: string | undefined): string[] {
  try {
    const file = JSON.parse(Deno.readTextFileSync(credentialsPath)) as {
      default?: string;
      accounts?: Record<string, { scope?: string }>;
    };
    const key = account?.toLowerCase() ?? file.default ?? "";
    return scopeNames(file.accounts?.[key]?.scope ?? "");
  } catch {
    return []; // fallback: no readable credential file; the event is still logged
  }
}

/**
 * Append one sign-in event to the auth log (0600), tagged with the stored sign-in's scope short
 * names. Synchronous, so the line is on disk before an error exits the process. Never throws.
 */
export function appendAuthLog(
  ctx: Pick<Context, "credentialsPath" | "authLogPath">,
  e: AuthEvent,
): void {
  try {
    Deno.mkdirSync(dirname(ctx.authLogPath), { recursive: true, mode: 0o700 });
    const grant = e.scopes ? scopeNames(e.scopes) : storedGrant(ctx.credentialsPath, e.account);
    const line = JSON.stringify({ ...e, grant }) + "\n";
    Deno.writeTextFileSync(ctx.authLogPath, line, { append: true, mode: 0o600 });
  } catch {
    // fallback: an unwritable log never breaks a Gmail command; the error still reaches the user.
  }
}

/** An error's message for this context: a refused or failed refresh points at the auth log. */
export function errorText(ctx: Pick<Context, "authLogPath">, e: unknown): string {
  const text = e instanceof Error ? e.message : String(e);
  const refresh = e instanceof TokenEndpointError ||
    (e instanceof NotSignedInError && e.cause instanceof OAuthError);
  return refresh ? `${text} Details: ${ctx.authLogPath}` : text;
}

function out(ctx: Context, data: unknown, human: () => void): void {
  if (ctx.json) console.log(JSON.stringify(data, null, 2));
  else human();
}

async function secret(ctx: Context): Promise<ClientSecret> {
  return await loadClientSecretFile(ctx.clientSecretPath);
}

/** A signed-in client for the context's grant. */
export async function client(ctx: Context): Promise<GmailClient> {
  return await GmailClient.fromStore({
    clientSecret: await secret(ctx),
    store: ctx.store,
    account: ctx.account,
    log: (l) => console.error(`  ${l}`),
    onAuthEvent: (e) => appendAuthLog(ctx, e),
  });
}

/** `login`: one browser consent for every scope the package uses, saved to the one file. */
export async function login(
  ctx: Context,
  deps: { loginInteractive?: typeof loginInteractive; clientSecret?: ClientSecret } = {},
): Promise<void> {
  const cred = await (deps.loginInteractive ?? loginInteractive)({
    clientSecret: deps.clientSecret ?? await secret(ctx),
    scopes: [...LOGIN_SCOPES],
    port: ctx.loopbackPort,
    expectedEmail: ctx.account,
    openBrowser: ctx.noBrowser ? () => false : undefined,
  });
  await ctx.store.save(cred);
  appendAuthLog(ctx, {
    at: new Date().toISOString(),
    event: "login",
    account: cred.email,
    scopes: cred.scope.split(" ").filter(Boolean),
  });
  out(
    ctx,
    { email: cred.email, scope: cred.scope, store: ctx.credentialsPath },
    () => {
      console.log(
        `Signed in as ${cred.email} (${
          cred.scope.split(" ").map((x) => x.split("/").at(-1)).join(", ")
        })`,
      );
      console.log(`Credential stored at ${ctx.credentialsPath}`);
    },
  );
}

export async function logout(ctx: Context): Promise<void> {
  const gmail = await client(ctx);
  const email = await gmail.email();
  const { revoked } = await gmail.logout();
  appendAuthLog(ctx, { at: new Date().toISOString(), event: "logout", account: email });
  out(ctx, { email, revoked }, () => {
    console.log(
      revoked
        ? `Revoked and forgot ${email}.`
        : `Forgot ${email}, but Google did not confirm the revoke — check https://myaccount.google.com/permissions`,
    );
  });
}

/** Exits non-zero when live access fails — infra probes rely on the exit code. */
export async function whoami(ctx: Context): Promise<void> {
  const report: Record<string, unknown> = {
    runtime: `deno ${Deno.version.deno}`,
    os: Deno.build.os,
    clientSecretPath: ctx.clientSecretPath,
    clientSecretPresent: await exists(ctx.clientSecretPath),
    credentialsPath: ctx.credentialsPath,
    accounts: await ctx.store.list(),
    defaultAccount: await ctx.store.defaultAccount(),
    requestedAccount: ctx.account ?? null,
    scopes: (await ctx.store.load(ctx.account))?.scope.split(" ").filter(Boolean) ?? [],
  };
  let live: string | undefined;
  let ok = false;
  try {
    const gmail = await client(ctx);
    const p = await gmail.profile();
    report.mailbox = p.emailAddress;
    report.messagesTotal = p.messagesTotal;
    live = `signed in as ${p.emailAddress} (${p.messagesTotal} messages)`;
    ok = true;
  } catch (e) {
    report.mailbox = null;
    report.error = { name: e instanceof Error ? e.name : typeof e, message: errorText(ctx, e) };
    live = `not signed in: ${errorText(ctx, e)}`;
  }
  // Read after the live call, which may have refreshed the token and recorded the outcome.
  const cred = await ctx.store.load(ctx.account);
  report.signedInAt = cred?.savedAt ?? null;
  report.grantAgeDays = cred
    ? Math.floor((Date.now() - Date.parse(cred.savedAt)) / 86_400_000)
    : null;
  report.lastRefreshAt = cred?.lastRefreshAt ?? null;
  report.lastRefreshError = cred?.lastRefreshError ?? null;
  report.authLogPath = ctx.authLogPath;
  out(ctx, report, () => {
    console.log(`runtime        ${report.runtime} on ${report.os}`);
    console.log(`scopes         ${scopeNames(report.scopes as string[]).join(", ") || "(none)"}`);
    console.log(
      `client secret  ${ctx.clientSecretPath} ${report.clientSecretPresent ? "✓" : "✗ missing"}`,
    );
    console.log(`credentials    ${ctx.credentialsPath}`);
    console.log(
      `accounts       ${(report.accounts as string[]).join(", ") || "(none)"}` +
        (report.defaultAccount ? `  default=${report.defaultAccount}` : ""),
    );
    console.log(`mailbox        ${live}`);
    if (cred) {
      console.log(
        `signed in      ${cred.savedAt} (${report.grantAgeDays} days ago)` +
          `; last refresh ${cred.lastRefreshAt ?? "not recorded"}`,
      );
      const f = cred.lastRefreshError;
      if (f) {
        console.log(
          `last failure   ${f.at} ${f.status ?? "no response"}${f.code ? ` ${f.code}` : ""} — ${
            f.rejected ? "Google refused the sign-in: run login" : "may pass; retry later"
          }`,
        );
      }
    }
    console.log(`auth log       ${ctx.authLogPath}`);
  });
  if (!ok) Deno.exit(2);
}

export async function accounts(
  ctx: Context,
  opts: { setDefault?: string },
): Promise<void> {
  if (opts.setDefault) await ctx.store.setDefault(opts.setDefault);
  const list = await ctx.store.list();
  const def = await ctx.store.defaultAccount();
  out(ctx, { accounts: list, default: def }, () => {
    if (!list.length) console.log("(no accounts — run login)");
    for (const a of list) console.log(`${a === def ? "*" : " "} ${a}`);
  });
}

export async function search(
  ctx: Context,
  opts: { q: string; max: number },
): Promise<void> {
  const gmail = await client(ctx);
  const page = await gmail.listMessages(opts.q, { maxResults: opts.max });
  const hits: ReturnType<typeof summarize>[] = [];
  for (const m of page.messages ?? []) {
    hits.push(summarize(await gmail.getMessage(m.id, "metadata")));
  }
  out(ctx, {
    query: opts.q,
    returned: hits.length,
    hasMore: !!page.nextPageToken,
    hits,
  }, () => {
    for (const h of hits) {
      const att = h.attachments.filter((a) => !a.inline).map((a) => a.filename);
      console.log(`${h.id}  ${h.date}\n  ${h.from}\n  ${h.subject}`);
      if (att.length) console.log(`  📎 ${att.join(", ")}`);
    }
    if (page.nextPageToken) {
      console.log(`(more results — narrow the query or raise --max)`);
    }
  });
}

type Target = { thread?: string; message?: string };

function resolveTarget(t: Target): { threadId?: string; messageId?: string } {
  if (t.thread && t.message) {
    throw new Error("pass --thread or --message, not both");
  }
  if (t.thread) return { threadId: parseGmailId(t.thread) };
  if (t.message) return { messageId: parseGmailId(t.message) };
  throw new Error("pass --thread <id> or --message <id>");
}

export async function attachmentsList(ctx: Context, t: Target): Promise<void> {
  const gmail = await client(ctx);
  const target = resolveTarget(t);
  const refs = target.threadId
    ? await gmail.listThreadAttachments(target.threadId)
    : await gmail.listMessageAttachments(target.messageId!);
  // attachmentId is ephemeral and long; leave it out of what we print.
  const rows = refs.map(({ attachmentId: _, ...rest }) => rest);
  out(ctx, { ...target, attachments: rows }, () => {
    if (!rows.length) console.log("(no attachments)");
    for (const r of rows) {
      console.log(
        `${r.messageId}  ${r.inline ? "[inline] " : ""}${r.filename}  ${r.mimeType}  ${r.size} B`,
      );
    }
  });
}

export async function attachmentsFetch(
  ctx: Context,
  t: Target,
  opts: FetchAttachmentsOptions,
): Promise<void> {
  const gmail = await client(ctx);
  const target = resolveTarget(t);
  const withLog = { ...opts, log: (l: string) => console.error(`  ${l}`) };
  const manifest = target.threadId
    ? await fetchThreadAttachments(gmail, target.threadId, withLog)
    : await fetchMessageAttachments(gmail, target.messageId!, withLog);
  out(ctx, manifest, () => {
    const verb = opts.dryRun ? "would write" : "wrote";
    console.log(
      `${verb} ${manifest.files.length} file(s) to ${manifest.outDir}`,
    );
    for (const f of manifest.files) {
      console.log(
        `  ${f.savedAs}  ${f.bytes} B${f.sha256 ? `  ${f.sha256.slice(0, 12)}…` : ""}`,
      );
    }
    for (const s of manifest.skipped) {
      console.log(`  skipped ${s.filename} (${s.reason})`);
    }
    if (!opts.dryRun) console.log(`  manifest.json`);
  });
}

async function exists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch {
    return false;
  }
}

// ── Writes (labels, drafts): the sign-in must hold modify and compose ─────────

/** Per-call ceiling for ids on the CLI. Bulk consumers use GmailWriter directly. */
export const CLI_MAX_IDS = DEFAULT_MAX_IDS;

/** The guarded writer. A read-only sign-in fails locally with `InsufficientScopeError`. */
async function guarded(ctx: Context): Promise<GuardedWriter> {
  const writer = new GmailWriter(await client(ctx), { log: (l) => console.error(`  ${l}`) });
  return new GuardedWriter(writer, {
    maxIds: CLI_MAX_IDS,
    log: { path: ctx.credentialsPath.replace(/[^/]+$/, "writes.log"), via: "gmail-api-cli" },
  });
}

export async function labels(ctx: Context): Promise<void> {
  const gmail = await client(ctx);
  const all = (await gmail.listLabels()).sort((a, b) => a.name.localeCompare(b.name));
  out(ctx, { labels: all.map((l) => ({ id: l.id, name: l.name, type: l.type })) }, () => {
    for (const l of all) {
      console.log(`${l.id.padEnd(14)} ${l.type === "system" ? "· " : "  "}${l.name}`);
    }
  });
}

export async function labelCreate(ctx: Context, name: string): Promise<void> {
  const r = await (await guarded(ctx)).createLabel(name);
  out(ctx, r, () => {
    console.log(`${r.created ? "created" : "exists"}  ${r.label.id}  ${r.label.name}`);
  });
}

export async function labelApply(
  ctx: Context,
  opts: { name: string; ids: string[]; remove: boolean; threads: boolean; apply: boolean },
): Promise<void> {
  const r = await (await guarded(ctx)).labelChange({
    name: opts.name,
    ids: opts.ids,
    remove: opts.remove,
    kind: opts.threads ? "thread" : "message",
    apply: opts.apply,
  });
  const verb = opts.remove ? "remove" : "apply";
  out(ctx, r, () => {
    if (r.dryRun) {
      console.log(
        `DRY RUN — would ${verb} ${r.label.name} (${r.label.id}) on ${r.count} ${r.kind}(s). Re-run with --apply.`,
      );
    } else {
      console.log(
        `${opts.remove ? "removed" : "applied"} ${r.label.name} on ${r.count} ${r.kind}(s)`,
      );
    }
  });
}

export async function draftCreate(
  ctx: Context,
  opts: {
    to?: string[];
    cc?: string[];
    bcc?: string[];
    subject?: string;
    text: string;
    html?: string;
    replyTo?: string;
    replyAll?: boolean;
    quote?: boolean;
    signature?: boolean;
    attach?: string[];
  },
): Promise<void> {
  // Files are read here, not in lib/: the library takes bytes and never touches paths.
  const attachments = await Promise.all(
    (opts.attach ?? []).map(async (p) => ({
      filename: basename(p),
      content: await Deno.readFile(p),
    })),
  );
  const r = await (await guarded(ctx)).createDraft({
    attachments: attachments.length ? attachments : undefined,
    to: opts.to,
    cc: opts.cc,
    bcc: opts.bcc,
    subject: opts.subject,
    text: opts.text,
    html: opts.html,
    replyToMessageId: opts.replyTo ? parseGmailId(opts.replyTo) : undefined,
    replyAll: opts.replyAll,
    quote: opts.quote,
    signature: opts.signature,
  });
  out(ctx, r, () => {
    const d = r.draft;
    console.log(
      `draft ${d.id} created (message ${d.message.id}${
        d.message.threadId ? `, thread ${d.message.threadId}` : ""
      }). Not sent.`,
    );
    printRecipients(r.recipients);
    if (r.quoted) console.log("   original quoted below");
    if (r.signature !== "off") {
      console.log(r.signature === "added" ? "   signature added" : "   no signature set");
    }
    for (const a of attachments) console.log(`   📎 ${a.filename} (${a.content.length} bytes)`);
    console.log(r.url);
  });
}

export async function draftForward(
  ctx: Context,
  opts: {
    message: string;
    to: string[];
    cc?: string[];
    bcc?: string[];
    text?: string;
    html?: string;
    files: "all" | "none" | string[];
    signature?: boolean;
  },
): Promise<void> {
  const r = await (await guarded(ctx)).forwardDraft({
    messageId: parseGmailId(opts.message),
    to: opts.to,
    cc: opts.cc,
    bcc: opts.bcc,
    text: opts.text,
    html: opts.html,
    attachments: opts.files,
    signature: opts.signature,
  });
  out(ctx, r, () => {
    const d = r.draft;
    console.log(
      `forward draft ${d.id} created (message ${d.message.id}${
        d.message.threadId ? `, thread ${d.message.threadId}` : ""
      }). Not sent.`,
    );
    printRecipients(r.recipients);
    console.log(`   ${r.carried.count} file(s) carried, ${r.carried.totalBytes} bytes`);
    if (r.skippedInline) {
      console.log(`   ⚠ ${r.skippedInline} inline image(s) not carried (logos, pasted images)`);
    }
    if (r.signature !== "off") {
      console.log(r.signature === "added" ? "   signature added" : "   no signature set");
    }
    console.log(r.url);
  });
}

export async function draftUpdate(
  ctx: Context,
  opts: {
    draftId: string;
    to?: string[];
    cc?: string[];
    bcc?: string[];
    subject?: string;
    text?: string;
    html?: string;
    attach?: string[];
    remove?: string[];
    quote?: boolean;
    signature?: boolean;
    expectMessageId?: string;
  },
): Promise<void> {
  // Files are read here, not in lib/: the library takes bytes and never touches paths.
  const add = await Promise.all(
    (opts.attach ?? []).map(async (p) => ({
      filename: basename(p),
      content: await Deno.readFile(p),
    })),
  );
  const g = await guarded(ctx);
  // Pass the message id read now, so an edit made in Gmail meanwhile is refused, not overwritten.
  const expectMessageId = opts.expectMessageId ??
    (await g.writer.client.getDraft(opts.draftId, "minimal")).message.id;
  const r = await g.updateDraft({
    draftId: opts.draftId,
    to: opts.to,
    cc: opts.cc,
    bcc: opts.bcc,
    subject: opts.subject,
    text: opts.text,
    html: opts.html,
    addAttachments: add.length ? add : undefined,
    removeAttachments: opts.remove,
    quote: opts.quote,
    signature: opts.signature,
    expectMessageId,
  });
  out(ctx, r, () => {
    console.log(
      `draft ${r.draft.id} updated (message ${r.previousMessageId} → ${r.draft.message.id}). Not sent.`,
    );
    printRecipients(r.recipients);
    console.log(`   body ${r.body}${r.quoted ? ", original quoted" : ""}`);
    console.log(
      `   ${r.kept.count} file(s) kept unchanged, ${r.added} added, ${r.removed} removed`,
    );
    console.log(r.url);
  });
}

/** To, Cc and Bcc on their own lines; Cc and Bcc only when present. */
function printRecipients(r: { to: string[]; cc: string[]; bcc: string[] }): void {
  console.log(`   To:  ${r.to.join(", ")}`);
  if (r.cc.length) console.log(`   Cc:  ${r.cc.join(", ")}`);
  if (r.bcc.length) console.log(`   Bcc: ${r.bcc.join(", ")}`);
}

export async function drafts(ctx: Context, opts: { max?: number; q?: string }): Promise<void> {
  const list = await (await client(ctx)).listDrafts(opts);
  out(ctx, list, () => {
    if (!list.length) return console.log("no drafts");
    for (const d of list) {
      console.log(`${d.id}  ${d.date}\n   ${d.subject || "(no subject)"}\n   To: ${d.to}`);
    }
  });
}

// ── Reading ─────────────────────────────────────────────────────────────────

export async function read(
  ctx: Context,
  t: Target,
  opts: { maxChars?: number; headers?: boolean; links?: boolean },
): Promise<void> {
  const target = resolveTarget(t);
  const messages = await readMessages(await client(ctx), target, opts);
  out(ctx, { ...target, messages }, () => {
    for (const m of messages) {
      console.log(
        `── ${m.id}  ${m.date}\n   From: ${m.from}\n   To: ${m.to}\n   Subject: ${m.subject}`,
      );
      console.log(`   Auth: ${authLine(m.auth)}`);
      if (m.attachments.length) {
        console.log(`   📎 ${m.attachments.map((a) => a.filename).join(", ")}`);
      }
      if (m.bounce) printBounce(m.bounce);
      if (m.headers) {
        console.log("\n   Headers:");
        for (const h of m.headers) console.log(`     ${h.name}: ${h.value}`);
      }
      if (m.links) {
        const l = m.links;
        console.log(
          `\n   Links: ${l.links.length}, hosts: ${
            l.hosts.map((h) => `${h.host}×${h.count}`).join(", ") || "none"
          }${l.mismatches ? `, ⚠ ${l.mismatches} text/target mismatch(es)` : ""}`,
        );
        for (const k of l.links) {
          const warn = k.mismatch ? `  ⚠ text names ${k.textHost}` : "";
          console.log(`     ${k.href}${k.text ? `  "${k.text.slice(0, 60)}"` : ""}${warn}`);
        }
      }
      console.log(`\n${m.text}\n`);
      if (m.truncatedChars) console.log("   (raise --max-chars to see the rest)\n");
    }
  });
}

function printBounce(b: NonNullable<ReadMessage["bounce"]>): void {
  console.log(`\n   Bounce (${b.kind}${b.reportingMta ? `, reported by ${b.reportingMta}` : ""}):`);
  for (const r of b.recipients) {
    console.log(
      `     ✗ ${r.address}  ${r.action}${r.status ? ` ${r.status}` : ""}  → ${r.reason}${
        r.remoteMta ? `  via ${r.remoteMta}` : ""
      }`,
    );
    if (r.diagnostic) console.log(`       ${r.diagnostic}`);
  }
  const o = b.original;
  if (o.subject || o.from) {
    console.log(
      `     original: ${o.subject ?? "(no subject)"}  from ${o.from ?? "?"}  ${o.date ?? ""}`,
    );
    if (o.to) console.log(`       to ${o.to}${o.cc ? `  cc ${o.cc}` : ""}`);
  }
}

export async function bounces(
  ctx: Context,
  opts: { recipient?: string; days?: number; max?: number },
): Promise<void> {
  const list = await findBounces(await client(ctx), opts);
  // Group by recipient: the first bounce of an address usually explains every later one.
  const byRecipient = new Map<
    string,
    { date: string; reason: string; status?: string; diagnostic?: string; bounceId: string }[]
  >();
  for (const b of list) {
    for (const r of b.recipients.filter((x) => x.action !== "delivered")) {
      const rows = byRecipient.get(r.address) ?? [];
      rows.push({
        date: b.date,
        reason: r.reason,
        status: r.status,
        diagnostic: r.diagnostic,
        bounceId: b.bounceId,
      });
      byRecipient.set(r.address, rows);
    }
  }
  const recipients = [...byRecipient].map(([address, history]) => ({
    address,
    count: history.length,
    history,
  }));
  out(ctx, { bounces: list, recipients }, () => {
    if (!list.length) console.log("(no bounces found)");
    for (const r of recipients) {
      console.log(`${r.address}  ${r.count} bounce(s)`);
      for (const h of r.history) {
        console.log(`  ${h.date}  ${h.reason}${h.status ? ` ${h.status}` : ""}  [${h.bounceId}]`);
        if (h.diagnostic) console.log(`    ${h.diagnostic.slice(0, 200)}`);
      }
    }
  });
}

/** One line: `dkim=pass d=x.com · spf=pass · dmarc=pass p=none · ⚠ flags`. */
function authLine(a: ReadMessage["auth"]): string {
  if (!a.authservId) return "⚠ no Authentication-Results";
  const dkim = a.dkim.length
    ? a.dkim.map((d) =>
      `dkim=${d.result}${d.domain ? ` d=${d.domain}` : ""}${d.selector ? ` s=${d.selector}` : ""}`
    ).join(", ")
    : "dkim=none";
  const spf = a.spf ? `spf=${a.spf.result}` : "spf=none";
  const dmarc = a.dmarc
    ? `dmarc=${a.dmarc.result}${a.dmarc.policy ? ` p=${a.dmarc.policy}` : ""}`
    : "dmarc=none";
  const flags = a.flags.length ? `  ⚠ ${a.flags.join(", ")}` : "";
  const notes = a.notes.length ? `  ℹ ${a.notes.join(", ")}` : "";
  return `${dkim} · ${spf} · ${dmarc} (${a.authservId})${flags}${notes}`;
}

export async function raw(ctx: Context, opts: { message: string; outDir: string }): Promise<void> {
  const id = parseGmailId(opts.message);
  const bytes = await rawMessage(await client(ctx), id);
  await Deno.mkdir(opts.outDir, { recursive: true });
  const path = join(opts.outDir, `${id}.eml`);
  await Deno.writeFile(path, bytes, { mode: 0o600 });
  const r = { messageId: id, path, bytes: bytes.length, sha256: await sha256Hex(bytes) };
  out(ctx, r, () => console.log(`wrote ${r.path}  ${r.bytes} B  ${r.sha256.slice(0, 12)}…`));
}

export async function searchByThread(
  ctx: Context,
  opts: { q: string; max: number },
): Promise<void> {
  const r = await searchThreads(await client(ctx), opts.q, { maxResults: opts.max });
  out(ctx, r, () => {
    if (!r.threads.length) console.log(`(no results for: ${r.query})`);
    for (const t of r.threads) {
      console.log(
        `${t.threadId}  ${t.latest}  [${t.messages} msg]\n  ${t.from.join("; ")}\n  ${t.subject}`,
      );
      if (t.attachments.length) console.log(`  📎 ${t.attachments.join(", ")}`);
    }
    if (r.hasMore) console.log("(more results — narrow the query or raise --max)");
  });
}
