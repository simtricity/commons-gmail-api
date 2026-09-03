#!/usr/bin/env -S deno run --allow-net --allow-env --allow-read --allow-write --allow-run=open,xdg-open

/**
 * gmail-api CLI — read-only Gmail access from the terminal.
 *
 * Usage:
 *   deno task cli <command> [options]
 *
 * Commands:
 *   login        [--account <email>]              Sign in (browser). Read-only scope.
 *   logout       [--account <email>]              Revoke at Google and forget.
 *   whoami                                        Runtime, store, mailbox — one line each.
 *   accounts     [--default <email>]              List signed-in mailboxes / set default.
 *   search       -q <gmail query> [--max N]       Message ids + metadata. No bodies.
 *   attachments list  --thread <id> | --message <id>
 *   attachments fetch --thread <id> | --message <id> --out <dir>
 *                [--include <glob>]... [--filename <exact>]... [--inline] [--max-bytes N] [--dry-run]
 *
 * Global options:
 *   --account <email>   Mailbox to act as (default: the store's default)
 *   --json              Machine-readable output
 *   -h, --help
 *
 * Environment:
 *   GMAIL_CLIENT_SECRET_PATH   default ~/.simt/gmail-api/client-secret.json
 *   GMAIL_API_CREDENTIALS      default ~/.simt/gmail-api/credentials.json
 *   GMAIL_API_LOOPBACK_PORT    default 8731
 *   GMAIL_NO_BROWSER=1         print the auth URL instead of opening a browser
 */

import { parseArgs } from "@std/cli/parse-args";
import * as commands from "./commands.ts";
import { GmailApiError, NotSignedInError, OAuthError } from "../lib/mod.ts";

const args = parseArgs(Deno.args, {
  string: ["account", "default", "q", "thread", "message", "out", "max", "max-bytes"],
  collect: ["include", "filename"],
  boolean: ["help", "json", "inline", "dry-run"],
  alias: { h: "help" },
});

const [command, sub] = args._.map(String);

function usage(): void {
  console.log(`gmail-api — read-only Gmail from the terminal

Usage: deno task cli <command> [options]

Commands:
  login        [--account <email>]              Sign in via browser (gmail.readonly)
  logout       [--account <email>]              Revoke at Google and forget
  whoami                                        Runtime, store, mailbox
  accounts     [--default <email>]              List mailboxes / set default
  search       -q <gmail query> [--max N]       Ids + metadata, no bodies
  attachments list  --thread <id> | --message <id>
  attachments fetch --thread <id> | --message <id> --out <dir>
               [--include <glob>]... [--filename <exact>]... [--inline]
               [--max-bytes N] [--dry-run]

Options:
  --account <email>   Mailbox to act as (default: store default)
  --json              Machine-readable output
  -h, --help          This help

Env: GMAIL_CLIENT_SECRET_PATH, GMAIL_API_CREDENTIALS, GMAIL_API_LOOPBACK_PORT, GMAIL_NO_BROWSER`);
}

if (!command || args.help) {
  usage();
  Deno.exit(command ? 0 : 1);
}

const ctx = commands.contextFromEnv({ account: args.account, json: args.json });

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
      await commands.search(ctx, { q: args.q, max: args.max ? Number(args.max) : 20 });
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
          dryRun: args["dry-run"],
        });
      } else {
        throw new Error("attachments needs a subcommand: list | fetch");
      }
      break;
    }
    default:
      usage();
      Deno.exit(1);
  }
} catch (e) {
  if (e instanceof NotSignedInError || e instanceof OAuthError || e instanceof GmailApiError) {
    console.error(`error: ${e.message}`);
  } else if (e instanceof Error) {
    console.error(`error: ${e.message}`);
  } else {
    console.error(`error: ${String(e)}`);
  }
  Deno.exit(1);
}
