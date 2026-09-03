/**
 * CLI command bodies. This is the only layer that touches `Deno.env`.
 * @module
 */

import {
  type ClientSecret,
  fetchMessageAttachments,
  fetchThreadAttachments,
  FileTokenStore,
  GmailClient,
  loadClientSecretFile,
  loginInteractive,
  parseGmailId,
  SCOPE_READONLY,
  summarize,
} from "../lib/mod.ts";
import type { FetchAttachmentsOptions } from "../lib/attachments.ts";

export interface Context {
  account?: string;
  json: boolean;
  clientSecretPath: string;
  credentialsPath: string;
  loopbackPort: number;
  noBrowser: boolean;
  store: FileTokenStore;
}

export function contextFromEnv(
  input: { account?: string; json?: boolean },
): Context {
  const home = Deno.env.get("HOME") ?? ".";
  const clientSecretPath = Deno.env.get("GMAIL_CLIENT_SECRET_PATH") ??
    `${home}/.simt/gmail-api/client-secret.json`;
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
  };
}

function out(ctx: Context, data: unknown, human: () => void): void {
  if (ctx.json) console.log(JSON.stringify(data, null, 2));
  else human();
}

async function secret(ctx: Context): Promise<ClientSecret> {
  return await loadClientSecretFile(ctx.clientSecretPath);
}

async function client(ctx: Context): Promise<GmailClient> {
  return await GmailClient.fromStore({
    clientSecret: await secret(ctx),
    store: ctx.store,
    account: ctx.account,
    log: (l) => console.error(`  ${l}`),
  });
}

export async function login(ctx: Context): Promise<void> {
  const cred = await loginInteractive({
    clientSecret: await secret(ctx),
    scopes: [SCOPE_READONLY],
    port: ctx.loopbackPort,
    expectedEmail: ctx.account,
    openBrowser: ctx.noBrowser ? () => false : undefined,
  });
  await ctx.store.save(cred);
  out(
    ctx,
    { email: cred.email, scope: cred.scope, store: ctx.credentialsPath },
    () => {
      console.log(
        `Signed in as ${cred.email} (${cred.scope.split("/").at(-1)})`,
      );
      console.log(`Credential stored at ${ctx.credentialsPath}`);
    },
  );
}

export async function logout(ctx: Context): Promise<void> {
  const gmail = await client(ctx);
  const email = await gmail.email();
  const { revoked } = await gmail.logout();
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
    live = `not signed in: ${e instanceof Error ? e.message : String(e)}`;
  }
  out(ctx, report, () => {
    console.log(`runtime        ${report.runtime} on ${report.os}`);
    console.log(
      `client secret  ${ctx.clientSecretPath} ${report.clientSecretPresent ? "✓" : "✗ missing"}`,
    );
    console.log(`credentials    ${ctx.credentialsPath}`);
    console.log(
      `accounts       ${(report.accounts as string[]).join(", ") || "(none)"}` +
        (report.defaultAccount ? `  default=${report.defaultAccount}` : ""),
    );
    console.log(`mailbox        ${live}`);
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
