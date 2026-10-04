/**
 * CLI command bodies. This is the only layer that touches `Deno.env`.
 * @module
 */

import {
  type ClientSecret,
  DEFAULT_MAX_IDS,
  fetchMessageAttachments,
  fetchThreadAttachments,
  FileTokenStore,
  GmailClient,
  GmailWriter,
  GuardedWriter,
  loadClientSecretFile,
  loginInteractive,
  parseGmailId,
  rawMessage,
  readMessages,
  SCOPE_READONLY,
  SCOPES_WRITE,
  searchThreads,
  sha256Hex,
  summarize,
} from "../lib/mod.ts";
import type { FetchAttachmentsOptions } from "../lib/attachments.ts";
import type { ReadMessage } from "../lib/body.ts";
import { basename, join } from "@std/path";

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

/** Per-call ceiling for ids on the CLI. Bulk consumers use GmailWriter directly. */
export const CLI_MAX_IDS = DEFAULT_MAX_IDS;

async function guarded(ctx: Context): Promise<GuardedWriter> {
  if (!ctx.write) {
    throw new Error(
      "write commands need the write grant: run `login --write` (uses credentials.modify.json)",
    );
  }
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
    subject?: string;
    text: string;
    replyTo?: string;
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
    subject: opts.subject,
    text: opts.text,
    replyToMessageId: opts.replyTo ? parseGmailId(opts.replyTo) : undefined,
  });
  out(ctx, r, () => {
    const d = r.draft;
    console.log(
      `draft ${d.id} created (message ${d.message.id}${
        d.message.threadId ? `, thread ${d.message.threadId}` : ""
      }). Not sent.`,
    );
    for (const a of attachments) console.log(`   📎 ${a.filename} (${a.content.length} bytes)`);
    console.log(r.url);
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
