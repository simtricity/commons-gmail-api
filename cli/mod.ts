#!/usr/bin/env -S deno run --allow-net --allow-env --allow-read --allow-write --allow-run=open,xdg-open

/**
 * gmail-api CLI — read-only Gmail access from the terminal.
 *
 * Usage:
 *   deno task cli <command> [options]
 *
 * Commands:
 *   login        [--account <email>] [--write]    Sign in (browser). Read-only scope;
 *                --write asks for gmail.modify + gmail.compose too and stores the grant
 *                in credentials.modify.json, leaving the read-only credential untouched.
 *   logout       [--account <email>]              Revoke at Google and forget.
 *   whoami       [--write]                        Runtime, store, grant, mailbox — one line each.
 *   accounts     [--default <email>]              List signed-in mailboxes / set default.
 *   search       -q <gmail query> [--max N] [--threads]   Message ids + metadata, or grouped by
 *                thread with --threads. No bodies.
 *   read         --thread <id> | --message <id> [--max-chars N]   Headers + body text (default 8000/msg)
 *                [--headers] every header · [--links] body links, hosts, text/target mismatches.
 *                Always shows a DKIM/SPF/DMARC line with phishing flags.
 *   raw          --message <id> --out <dir>      Save the message as received, <id>.eml (0600)
 *   bounces      [--recipient <addr>] [--days N] [--max N]   Delivery failures, grouped by
 *                recipient, with status, reason and the remote server's words (default 90 days)
 *   attachments list  --thread <id> | --message <id>
 *   attachments fetch --thread <id> | --message <id> --out <dir>
 *                [--include <glob>]... [--filename <exact>]... [--inline] [--max-bytes N]
 *                [--skip-existing [dir]] [--dry-run]
 *
 *   Writes (use the write grant from `login --write`; never send, trash or delete mail):
 *   labels                                        List labels with ids
 *   label create <name>                           Create (nested "a/b/c" creates parents); idempotent
 *   label apply  <name> --ids a,b,c [--threads] [--apply]   Dry run unless --apply; max 25 ids
 *   label remove <name> --ids a,b,c [--threads] [--apply]   System labels refused
 *   draft create --to a@b --subject S --body TEXT | --reply-to <messageId> --body TEXT
 *                [--body-file <path>] [--attach <path>]...   (attachments total ≤ 25 MB)
 *                Creates a draft only. Applied writes append to ~/.simt/gmail-api/writes.log
 *
 * Global options:
 *   --account <email>   Mailbox to act as (default: the store's default)
 *   --json              Machine-readable output
 *   -h, --help
 *
 * Environment:
 *   GMAIL_CLIENT_SECRET_PATH   default ~/.simt/gmail-api/client-secret.json
 *   GMAIL_API_CREDENTIALS      default ~/.simt/gmail-api/credentials.json
 *   GMAIL_API_CREDENTIALS_MODIFY  default ~/.simt/gmail-api/credentials.modify.json (--write)
 *   GMAIL_API_LOOPBACK_PORT    default 8731
 *   GMAIL_NO_BROWSER=1         print the auth URL instead of opening a browser
 */

import { parseArgs } from "@std/cli/parse-args";
import * as commands from "./commands.ts";
import { GmailApiError, NotSignedInError, OAuthError } from "../lib/mod.ts";

const args = parseArgs(Deno.args, {
  // --skip-existing takes an optional dir; bare flag parses as "" → use --out
  string: [
    "account",
    "default",
    "q",
    "thread",
    "message",
    "out",
    "max",
    "max-bytes",
    "skip-existing",
    "ids",
    "subject",
    "body",
    "reply-to",
    "max-chars",
    "body-file",
    "recipient",
    "days",
  ],
  collect: ["include", "filename", "to", "cc", "attach"],
  boolean: ["help", "json", "inline", "dry-run", "write", "apply", "threads", "headers", "links"],
  alias: { h: "help" },
});

const [command, sub] = args._.map(String);

function usage(): void {
  console.log(`gmail-api — read-only Gmail from the terminal

Usage: deno task cli <command> [options]

Commands:
  login        [--account <email>] [--write]    Sign in via browser (gmail.readonly; --write adds modify+compose)
  labels                                        List labels with ids
  label create <name>                           Create label (parents too); idempotent   [write]
  label apply|remove <name> --ids a,b,c [--threads] [--apply]   Dry run unless --apply   [write]
  draft create --to <a> --subject <s> --body <t> | --reply-to <msgId> --body <t>        [write]
               [--body-file <path>] (instead of --body) [--attach <path>]... (total ≤ 25 MB)
  logout       [--account <email>]              Revoke at Google and forget
  whoami       [--write]                        Runtime, store, grant, mailbox
  accounts     [--default <email>]              List mailboxes / set default
  search       -q <gmail query> [--max N] [--threads]   Ids + metadata (grouped by thread with --threads)
  read         --thread <id> | --message <id> [--max-chars N]   Headers + body text + auth line
               [--headers] every header   [--links] body links, host counts, text/target mismatches
  raw          --message <id> --out <dir>     Save the message as received (<id>.eml) for forensics
  bounces      [--recipient <addr>] [--days N] [--max N]   Delivery failures by recipient (90 days)
  attachments list  --thread <id> | --message <id>
  attachments fetch --thread <id> | --message <id> --out <dir>
               [--include <glob>]... [--filename <exact>]... [--inline]
               [--max-bytes N] [--skip-existing [dir]] [--dry-run]
               --skip-existing: don't re-download files already in dir (default --out),
               matched on name + size, confirmed against a prior manifest.json

Options:
  --account <email>   Mailbox to act as (default: store default)
  --json              Machine-readable output
  -h, --help          This help

Env: GMAIL_CLIENT_SECRET_PATH, GMAIL_API_CREDENTIALS, GMAIL_API_CREDENTIALS_MODIFY, GMAIL_API_LOOPBACK_PORT, GMAIL_NO_BROWSER`);
}

if (!command || args.help) {
  usage();
  Deno.exit(command ? 0 : 1);
}

// Write commands always use the write credential file.
const WRITE_COMMANDS = ["label", "draft"];
const ctx = commands.contextFromEnv({
  account: args.account,
  json: args.json,
  write: args.write || WRITE_COMMANDS.includes(command ?? ""),
});

try {
  switch (command) {
    case "login":
      await commands.login(ctx);
      break;
    case "logout":
      await commands.logout(ctx);
      break;
    case "whoami":
      await commands.whoami(ctx);
      break;
    case "accounts":
      await commands.accounts(ctx, { setDefault: args.default });
      break;
    case "search":
      if (!args.q) throw new Error("search needs -q <gmail query>");
      await (args.threads ? commands.searchByThread : commands.search)(ctx, {
        q: args.q,
        max: args.max ? Number(args.max) : 20,
      });
      break;
    case "attachments": {
      const target = { thread: args.thread, message: args.message };
      if (sub === "list") {
        await commands.attachmentsList(ctx, target);
      } else if (sub === "fetch") {
        if (!args.out) throw new Error("attachments fetch needs --out <dir>");
        // `collect` yields undefined, not [], when the flag is absent.
        const include = ((args.include ?? []) as string[]).map(String);
        const filenames = ((args.filename ?? []) as string[]).map(String);
        await commands.attachmentsFetch(ctx, target, {
          outDir: args.out,
          include: include.length ? include : undefined,
          filenames: filenames.length ? filenames : undefined,
          includeInline: args.inline,
          maxBytes: args["max-bytes"] ? Number(args["max-bytes"]) : undefined,
          skipExisting: args["skip-existing"] === undefined
            ? undefined
            : (args["skip-existing"] || true),
          dryRun: args["dry-run"],
        });
      } else {
        throw new Error("attachments needs a subcommand: list | fetch");
      }
      break;
    }
    case "read":
      await commands.read(ctx, { thread: args.thread, message: args.message }, {
        maxChars: args["max-chars"] ? Number(args["max-chars"]) : 8000,
        headers: args.headers,
        links: args.links,
      });
      break;
    case "bounces":
      await commands.bounces(ctx, {
        recipient: args.recipient,
        days: args.days ? Number(args.days) : undefined,
        max: args.max ? Number(args.max) : undefined,
      });
      break;
    case "raw":
      if (!args.message) throw new Error("raw needs --message <id>");
      if (!args.out) throw new Error("raw needs --out <dir>");
      await commands.raw(ctx, { message: args.message, outDir: args.out });
      break;
    case "labels":
      await commands.labels(ctx);
      break;
    case "label": {
      const name = args._[2] !== undefined ? String(args._[2]) : undefined;
      if (!name) throw new Error("label <create|apply|remove> <name>");
      if (sub === "create") {
        await commands.labelCreate(ctx, name);
      } else if (sub === "apply" || sub === "remove") {
        await commands.labelApply(ctx, {
          name,
          ids: String(args.ids ?? "").split(",").map((x) => x.trim()).filter(Boolean),
          remove: sub === "remove",
          threads: args.threads,
          apply: args.apply,
        });
      } else {
        throw new Error("label needs a subcommand: create | apply | remove");
      }
      break;
    }
    case "draft":
      if (sub !== "create") throw new Error("draft needs a subcommand: create");
      if (!args.body && !args["body-file"]) {
        throw new Error("draft create needs --body <text> or --body-file <path>");
      }
      if (args.body && args["body-file"]) throw new Error("give --body or --body-file, not both");
      await commands.draftCreate(ctx, {
        to: (args.to as string[] | undefined)?.map(String),
        cc: (args.cc as string[] | undefined)?.map(String),
        subject: args.subject,
        text: args.body ?? await Deno.readTextFile(args["body-file"]!),
        replyTo: args["reply-to"],
        attach: (args.attach as string[] | undefined)?.map(String),
      });
      break;
    default:
      usage();
      Deno.exit(1);
  }
} catch (e) {
  if (
    e instanceof NotSignedInError || e instanceof OAuthError ||
    e instanceof GmailApiError
  ) {
    console.error(`error: ${e.message}`);
  } else if (e instanceof Error) {
    console.error(`error: ${e.message}`);
  } else {
    console.error(`error: ${String(e)}`);
  }
  Deno.exit(1);
}
