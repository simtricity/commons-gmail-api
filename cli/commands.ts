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
  GmailWriter,
  loadClientSecretFile,
  loginInteractive,
  parseGmailId,
  SCOPE_READONLY,
  SCOPES_WRITE,
  summarize,
} from "../lib/mod.ts";
import type { FetchAttachmentsOptions } from "../lib/attachments.ts";

export interface Context {
  account?: string;
  json: boolean;
  clientSecretPath: string;
  credentialsPath: string;
  /** True when --write selected the modify/compose credential file. */
  write: boolean;
  loopbackPort: number;
  noBrowser: boolean;
  store: FileTokenStore;
}

export function contextFromEnv(
  input: { account?: string; json?: boolean; write?: boolean },
): Context {
  const home = Deno.env.get("HOME") ?? ".";
  const clientSecretPath = Deno.env.get("GMAIL_CLIENT_SECRET_PATH") ??
    `${home}/.simt/gmail-api/client-secret.json`;
  // The write grant lives in its own file so read-only consumers never inherit it.
  const credentialsPath = input.write
    ? Deno.env.get("GMAIL_API_CREDENTIALS_MODIFY") ??
      `${home}/.simt/gmail-api/credentials.modify.json`
    : Deno.env.get("GMAIL_API_CREDENTIALS") ?? `${home}/.simt/gmail-api/credentials.json`;
  return {
    account: input.account ?? Deno.env.get("GMAIL_ACCOUNT") ?? undefined,
    json: input.json ?? false,
    clientSecretPath,
    credentialsPath,
    write: input.write ?? false,
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
    scopes: ctx.write ? [...SCOPES_WRITE] : [SCOPE_READONLY],
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
    grant: ctx.write ? "write" : "readonly",
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
    live = `not signed in: ${e instanceof Error ? e.message : String(e)}`;
  }
  out(ctx, report, () => {
    console.log(`runtime        ${report.runtime} on ${report.os}`);
    console.log(
      `grant          ${report.grant}: ${
        (report.scopes as string[]).map((x) => x.split("/").at(-1)).join(", ") || "(none)"
      }`,
    );
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

// ── Writes (labels, drafts) — need --write / credentials.modify.json ────────

/** Per-call ceiling for ids on the CLI. Bulk consumers use the library's batchModifyMessages. */
export const CLI_MAX_IDS = 25;

async function writer(ctx: Context): Promise<GmailWriter> {
  if (!ctx.write) {
    throw new Error(
      "write commands need the write grant: run `login --write` (uses credentials.modify.json)",
    );
  }
  return new GmailWriter(await client(ctx), { log: (l) => console.error(`  ${l}`) });
}

/** Append one JSON line per applied mutation next to the credential files. */
async function logWrite(ctx: Context, entry: Record<string, unknown>): Promise<void> {
  const path = ctx.credentialsPath.replace(/[^/]+$/, "writes.log");
  const line = JSON.stringify({
    at: new Date().toISOString(),
    account: ctx.account ?? null,
    ...entry,
  });
  await Deno.writeTextFile(path, line + "\n", { append: true, mode: 0o600 });
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
  const w = await writer(ctx);
  const existed = await w.findLabel(name);
  const label = await w.ensureLabel(name);
  if (!existed) await logWrite(ctx, { op: "label.create", name, id: label.id });
  out(ctx, { label, created: !existed }, () => {
    console.log(`${existed ? "exists" : "created"}  ${label.id}  ${label.name}`);
  });
}

export async function labelApply(
  ctx: Context,
  opts: { name: string; ids: string[]; remove: boolean; threads: boolean; apply: boolean },
): Promise<void> {
  const w = await writer(ctx);
  if (!opts.ids.length) throw new Error("--ids <a,b,c> is required");
  if (opts.ids.length > CLI_MAX_IDS) {
    throw new Error(`refusing ${opts.ids.length} ids; the CLI caps at ${CLI_MAX_IDS} per call`);
  }
  const label = await w.findLabel(opts.name);
  if (!label) {
    throw new Error(`no label named ${JSON.stringify(opts.name)}; run \`label create\` first`);
  }
  if (label.type === "system") throw new Error(`refusing system label ${label.name}`);
  const change = opts.remove ? { removeLabelIds: [label.id] } : { addLabelIds: [label.id] };
  const kind = opts.threads ? "thread" : "message";
  const plan = {
    op: opts.remove ? "label.remove" : "label.apply",
    label: { id: label.id, name: label.name },
    [`${kind}Ids`]: opts.ids,
    count: opts.ids.length,
  };
  if (!opts.apply) {
    out(ctx, { dryRun: true, ...plan }, () => {
      console.log(
        `DRY RUN — would ${
          opts.remove ? "remove" : "apply"
        } ${label.name} (${label.id}) on ${opts.ids.length} ${kind}(s). Re-run with --apply.`,
      );
    });
    return;
  }
  if (opts.threads) {
    for (const id of opts.ids) await w.modifyThread(id, change);
  } else {
    await w.batchModifyMessages(opts.ids, change);
  }
  await logWrite(ctx, plan);
  out(ctx, { applied: true, ...plan }, () => {
    console.log(
      `${opts.remove ? "removed" : "applied"} ${label.name} on ${opts.ids.length} ${kind}(s)`,
    );
  });
}

export async function draftCreate(
  ctx: Context,
  opts: { to?: string[]; cc?: string[]; subject?: string; text: string; replyTo?: string },
): Promise<void> {
  const w = await writer(ctx);
  const draft = await w.createDraft({
    to: opts.to,
    cc: opts.cc,
    subject: opts.subject,
    text: opts.text,
    replyToMessageId: opts.replyTo,
  });
  const url = `https://mail.google.com/mail/u/0/#drafts?compose=${draft.message.id}`;
  await logWrite(ctx, {
    op: "draft.create",
    draftId: draft.id,
    messageId: draft.message.id,
    threadId: draft.message.threadId ?? null,
    replyTo: opts.replyTo ?? null,
  });
  out(ctx, { draft, url, sent: false }, () => {
    console.log(
      `draft ${draft.id} created (message ${draft.message.id}${
        draft.message.threadId ? `, thread ${draft.message.threadId}` : ""
      }). Not sent.`,
    );
    console.log(url);
  });
}
