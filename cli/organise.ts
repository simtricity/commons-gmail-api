/**
 * `gmail-api organise <verb>`: sorting a mailbox into labels from the terminal.
 *
 * Every verb takes `--json`: stdout then carries only the verb's result as
 * JSON, and progress goes to stderr. Exit codes, for scripts to branch on:
 *
 *   0  done
 *   1  usage error, or anything unexpected
 *   2  not signed in, a missing grant or write scope, or a missing or rejected model key
 *   3  `score` found a critical failure
 *   4  `reconcile` found a mismatch
 *   5  a stage finished with failures; re-run it to resume
 *
 * This file and `commands.ts` are the only code that reads the environment
 * (`envDeps`). Everything else is injected, so the verbs run offline in tests.
 *
 * @module
 */

import { parseArgs } from "@std/cli/parse-args";
import {
  GmailWriter,
  GuardedWriter,
  InsufficientScopeError,
  NotSignedInError,
  OAuthError,
  SCOPE_COMPOSE,
  SCOPE_MODIFY,
} from "../lib/mod.ts";
import {
  type Judge,
  Organiser,
  type OrganiserGmail,
  type OrganiserIO,
  type OrganiserWriter,
  SystemOneError,
  SystemOneJudge,
} from "../organise.ts";
import { client, contextFromEnv } from "./commands.ts";

/** A command line the verbs cannot run. Exit 1. */
export class UsageError extends Error {
  /** Error class name, stable across minification. */
  override name = "UsageError";
}

/** No decision-model key in the environment or its env file. Exit 2. */
export class MissingKeyError extends Error {
  /** Error class name, stable across minification. */
  override name = "MissingKeyError";
}

/** The decision model, with the one-question liveness probe `whoami` uses. */
export type ModelClient = Judge & {
  whoami(): Promise<{ model: string; latencyMs: number; inputTokens: number }>;
};

/** A credential and what it grants. */
export interface Grant {
  email: string;
  scopes: string[];
}

/** What the verbs need from outside. `envDeps` builds it from the environment. */
export interface OrganiseDeps {
  /** The organiser's data directory. */
  dataDir: string;
  /** Base Gmail pacing; `fetch --rate`/`--concurrency` override it. Default: the organiser's. */
  pacing?: OrganiserIO["pacing"];
  /** The read grant. Called only by verbs that read Gmail. */
  gmail(): Promise<OrganiserGmail>;
  /** The write grant, through the guard. Called only by `apply --apply`. */
  writer(): Promise<OrganiserWriter>;
  /** The decision model. Throws {@link MissingKeyError} without a key. */
  judge(model: string): ModelClient;
  /** The read grant, live; the write grant if one is stored. */
  grants(): Promise<{ read: Grant; write?: Grant | { error: string } }>;
  /** stdout. */
  out(text: string): void;
  /** stderr. */
  err(text: string): void;
}

/** What a verb ended with: its result, or what it threw. */
export type Outcome = { verb: string; result: unknown } | { error: unknown };

/** The exit code for a verb's outcome; see the module notes for the table. */
export function exitCodeFor(o: Outcome): number {
  if ("error" in o) {
    const e = o.error;
    if (
      e instanceof NotSignedInError || e instanceof OAuthError ||
      e instanceof InsufficientScopeError || e instanceof MissingKeyError
    ) return 2;
    if (e instanceof SystemOneError && (e.status === 401 || e.status === 403)) return 2;
    return 1;
  }
  const r = (o.result ?? {}) as Record<string, unknown>;
  switch (o.verb) {
    case "whoami":
      return r.ready === false ? 2 : 0;
    case "score":
      return Number(r.criticalFailures) > 0 ? 3 : 0;
    case "reconcile":
      return r.ok === false ? 4 : 0;
    case "capture":
    case "fetch":
    case "judge":
      return Number(r.failures) > 0 ? 5 : 0;
  }
  return 0;
}

/** The value of a `TYPESAFE_API_KEY=` line in an env file's text, unquoted. */
export function keyFromEnvFile(text: string): string | undefined {
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?TYPESAFE_API_KEY\s*=\s*(.*)$/);
    if (!m) continue;
    let v = m[1].trim();
    if (v.length >= 2 && (v[0] === '"' || v[0] === "'") && v.at(-1) === v[0]) v = v.slice(1, -1);
    return v || undefined;
  }
  return undefined;
}

const STRINGS = [
  "account",
  "source",
  "overlap",
  "max",
  "min-genuine",
  "years",
  "run",
  "year",
  "query",
  "size",
  "seed",
  "rate",
  "concurrency",
  "scheme",
  "now",
  "message",
  "find",
  "is",
  "never",
  "note",
] as const;
const BOOLEANS = [
  "json",
  "help",
  "full",
  "single-message",
  "force",
  "show-moves",
  "apply",
  "sender",
] as const;

type Args = ReturnType<typeof parse>;

function parse(argv: string[]) {
  return parseArgs(argv, {
    string: [...STRINGS],
    boolean: [...BOOLEANS],
    alias: { h: "help" },
    unknown: (arg) => {
      if (arg.startsWith("-")) throw new UsageError(`unknown option ${arg}`);
      return true;
    },
  });
}

const USAGE = `gmail-api organise — sort a mailbox into labels with a decision model

Usage: deno task cli organise <verb> [options] [--json]

  whoami                               read and write grants, model key, profile, data dir
  capture   --source sent|received [--full] [--overlap N] [--max N]
  corpus    [--min-genuine N] [--years a,b]
  sample    --run R (--year Y | --query Q) [--size N] [--seed N] [--single-message] [--force]
  fetch     --run R [--rate N] [--concurrency N]
  judge     --run R [--scheme a,b] [--force] [--concurrency N]
  decide    --run R [--scheme a,b] [--now ISO] [--show-moves]
  score     --run R --scheme S
  apply     --run R --scheme S [--apply]          dry run unless --apply (needs the modify scope)
  reconcile --run R --scheme S
  explain   --run R --message ID --scheme S
  find      --run R --find TEXT
  rule      --scheme S (--message ID | --run R --find TEXT) --is CAT[,CAT]
            [--never a,b] [--note T] [--sender] [--run R]
  runs

--scheme may be left out when the profile has one scheme. Labels only: nothing is
sent, trashed or deleted.

Exit: 0 done · 1 usage/unexpected · 2 not signed in, no grant or model key · 3 score
critical failure · 4 reconcile mismatch · 5 finished with failures (re-run to resume)

Env: GMAIL_ORGANISE_DATA (default ~/.simt/gmail-api/organise), TYPESAFE_API_KEY
(or a TYPESAFE_API_KEY= line in ~/.simt/typesafe/env, path TYPESAFE_ENV_PATH),
TYPESAFE_ENDPOINT, and the gmail-api credential variables.`;

const list = (v?: string) => v?.split(",").map((s) => s.trim()).filter(Boolean);

function need(a: Args, name: (typeof STRINGS)[number], verb: string): string {
  const v = a[name];
  if (!v) throw new UsageError(`${verb} needs --${name}`);
  return v;
}

function int(a: Args, name: (typeof STRINGS)[number]): number | undefined {
  const v = a[name];
  if (v === undefined) return undefined;
  const n = Number(v);
  if (v.trim() === "" || !Number.isInteger(n)) {
    throw new UsageError(`--${name} must be a whole number`);
  }
  return n;
}

/** Resolve `--scheme`, or the profile's only scheme. */
function oneScheme(org: Organiser, a: Args, verb: string): string {
  if (a.scheme) return a.scheme;
  const ids = org.profile.schemes.map((s) => s.id);
  if (ids.length === 1) return ids[0];
  throw new UsageError(`${verb} needs --scheme: one of ${ids.join(", ")}`);
}

/** Gmail opened on first use, so local verbs never need a sign-in. */
function lazyGmail(get: () => Promise<OrganiserGmail>): OrganiserGmail {
  let p: Promise<OrganiserGmail> | undefined;
  const g = () => (p ??= get());
  return {
    listMessages: async (q, o) => await (await g()).listMessages(q, o),
    getMessage: async (id, f) => await (await g()).getMessage(id, f),
    listLabels: async () => await (await g()).listLabels(),
    profile: async () => await (await g()).profile(),
  };
}

const messageOf = (e: unknown) => e instanceof Error ? e.message : String(e);

async function whoami(deps: OrganiseDeps) {
  let read: Record<string, unknown>;
  let write: Record<string, unknown> | null = null;
  try {
    const g = await deps.grants();
    read = { ok: true, ...g.read };
    if (g.write) write = "error" in g.write ? { ok: false, ...g.write } : { ok: true, ...g.write };
  } catch (e) {
    read = { ok: false, error: messageOf(e) };
  }

  let profile: Record<string, unknown>;
  let modelName: string | undefined;
  try {
    const org = await Organiser.open(deps.dataDir, { gmail: lazyGmail(deps.gmail) });
    modelName = org.profile.model;
    profile = { ok: true, schemes: org.profile.schemes.map((s) => s.id), model: modelName };
  } catch (e) {
    profile = { ok: false, error: messageOf(e) };
  }

  let model: Record<string, unknown>;
  let keyBlocked = false;
  try {
    // fallback: an unreadable profile still gets the model probed, under the default model.
    model = { ok: true, ...await deps.judge(modelName ?? "jev-latest").whoami() };
  } catch (e) {
    keyBlocked = e instanceof MissingKeyError ||
      (e instanceof SystemOneError && (e.status === 401 || e.status === 403));
    model = { ok: false, error: messageOf(e) };
  }

  let exists = false;
  try {
    exists = (await Deno.stat(deps.dataDir)).isDirectory;
  } catch (e) {
    if (!(e instanceof Deno.errors.NotFound)) throw e;
  }
  return {
    ready: read.ok === true && !keyBlocked,
    read,
    write,
    model,
    profile,
    dataDir: { path: deps.dataDir, exists },
  };
}

async function run(verb: string, a: Args, deps: OrganiseDeps): Promise<unknown> {
  if (verb === "whoami") return await whoami(deps);
  const known = [
    "capture",
    "corpus",
    "sample",
    "fetch",
    "judge",
    "decide",
    "score",
    "apply",
    "reconcile",
    "explain",
    "find",
    "rule",
    "runs",
  ];
  if (!known.includes(verb)) throw new UsageError(`unknown verb "${verb}"; see organise --help`);

  const io: OrganiserIO = {
    gmail: lazyGmail(deps.gmail),
    log: (l) => deps.err(l),
    pacing: {
      ...deps.pacing,
      ...(verb === "fetch" && a.rate !== undefined ? { readsPerSecond: int(a, "rate") } : {}),
      ...(verb === "fetch" && a.concurrency !== undefined
        ? { concurrency: int(a, "concurrency") }
        : {}),
    },
  };
  let org = await Organiser.open(deps.dataDir, io);
  if (verb === "judge") {
    org = await Organiser.open(deps.dataDir, { ...io, judge: deps.judge(org.profile.model) });
  }
  if (verb === "apply" && a.apply) {
    org = await Organiser.open(deps.dataDir, { ...io, writer: await deps.writer() });
  }

  switch (verb) {
    case "capture": {
      const source = need(a, "source", verb);
      if (source !== "sent" && source !== "received") {
        throw new UsageError("--source must be sent or received");
      }
      return await org.capture({
        source,
        full: a.full,
        overlapDays: int(a, "overlap"),
        max: int(a, "max"),
      });
    }
    case "corpus":
      return await org.corpus({
        minGenuine: int(a, "min-genuine"),
        years: list(a.years)?.map((y) => {
          if (!/^\d{4}$/.test(y)) throw new UsageError("--years takes years like 2024,2025");
          return Number(y);
        }),
      });
    case "sample":
      if ((a.year === undefined) === (a.query === undefined)) {
        throw new UsageError("sample needs exactly one of --year and --query");
      }
      return await org.sample({
        run: need(a, "run", verb),
        year: int(a, "year"),
        query: a.query,
        size: int(a, "size"),
        seed: int(a, "seed"),
        singleMessage: a["single-message"],
        force: a.force,
      });
    case "fetch":
      return await org.fetch({ run: need(a, "run", verb) });
    case "judge":
      return await org.judge({
        run: need(a, "run", verb),
        schemes: list(a.scheme),
        force: a.force,
        concurrency: int(a, "concurrency"),
      });
    case "decide": {
      const now = a.now === undefined ? undefined : Date.parse(a.now);
      if (now !== undefined && !Number.isFinite(now)) {
        throw new UsageError("--now takes an ISO time");
      }
      return await org.decide({ run: need(a, "run", verb), schemes: list(a.scheme), now });
    }
    case "score":
      return await org.score({ run: need(a, "run", verb), scheme: oneScheme(org, a, verb) });
    case "apply":
      return await org.apply({
        run: need(a, "run", verb),
        scheme: oneScheme(org, a, verb),
        apply: a.apply,
      });
    case "reconcile":
      return await org.reconcile({ run: need(a, "run", verb), scheme: oneScheme(org, a, verb) });
    case "explain":
      return await org.explain({
        run: need(a, "run", verb),
        id: need(a, "message", verb),
        scheme: oneScheme(org, a, verb),
      });
    case "find":
      return await org.find({ run: need(a, "run", verb), text: need(a, "find", verb) });
    case "rule": {
      const scheme = oneScheme(org, a, verb);
      const is = list(need(a, "is", verb))!;
      if (!is.length) throw new UsageError("rule needs --is CAT[,CAT]");
      let id = a.message;
      if (!id) {
        if (!a.find || !a.run) throw new UsageError("rule needs --message ID, or --run R --find T");
        const found = await org.find({ run: a.run, text: a.find });
        if (found.length !== 1) {
          for (const m of found) deps.err(`  ${m.id}  ${m.state.from}  ${m.state.subject}`);
          throw new UsageError(
            `--find matched ${found.length} messages; rule needs exactly one (use --message)`,
          );
        }
        id = found[0].id;
      }
      return await org.rule({
        scheme,
        id,
        is: is.length === 1 ? is[0] : is,
        never: list(a.never),
        note: a.note,
        sender: a.sender,
        run: a.run,
      });
    }
    default:
      return await org.runs();
  }
}

/** A short human rendering of a verb's result. */
function human(verb: string, result: unknown, a: Args): string {
  const r = result as Record<string, unknown>;
  const kv = (o: Record<string, unknown>) =>
    Object.entries(o).map(([k, v]) =>
      `${k.padEnd(18)} ${typeof v === "object" ? JSON.stringify(v) : v}`
    )
      .join("\n");
  switch (verb) {
    case "decide":
      return Object.values(r as Record<string, Record<string, unknown>>).map((s) => {
        const lines = [`${s.scheme}: ${JSON.stringify(s.counts)}`];
        const moves = s.moves as Record<string, string[]>;
        for (const [k, ids] of Object.entries(moves)) {
          lines.push(`  ${k}: ${ids.length}${a["show-moves"] ? `  ${ids.join(" ")}` : ""}`);
        }
        return lines.join("\n");
      }).join("\n");
    case "apply":
      return `${r.dryRun ? "DRY RUN (re-run with --apply)\n" : ""}${kv(r)}`;
    case "runs":
      return (result as { id: string; createdAt: string }[])
        .map((m) => `${m.id.padEnd(20)} ${m.createdAt}`).join("\n") || "(no runs)";
    case "find":
      return (result as { id: string; state: { from: string; subject: string } }[])
        .map((m) => `${m.id}  ${m.state.from}  ${m.state.subject}`).join("\n") || "(none)";
    default:
      return kv(r);
  }
}

/**
 * Run one organise verb. `argv` excludes the word `organise`. Returns the exit
 * code; never calls `Deno.exit`.
 */
export async function runOrganise(
  argv: string[],
  makeDeps: (o: { account?: string }) => OrganiseDeps,
): Promise<number> {
  let a: Args;
  try {
    a = parse(argv);
  } catch (e) {
    makeDeps({}).err(`error: ${messageOf(e)}`);
    return 1;
  }
  const verb = a._[0] === undefined ? "" : String(a._[0]);
  if (!verb || a.help) {
    console.log(USAGE);
    return verb || a.help ? 0 : 1;
  }
  const deps = makeDeps({ account: a.account });
  try {
    const result = await run(verb, a, deps);
    deps.out(a.json ? JSON.stringify(result, null, 2) : human(verb, result, a));
    return exitCodeFor({ verb, result });
  } catch (e) {
    deps.err(`error: ${messageOf(e)}`);
    if (a.json) {
      deps.out(JSON.stringify({
        error: { name: e instanceof Error ? e.name : typeof e, message: messageOf(e) },
      }));
    }
    return exitCodeFor({ error: e });
  }
}

/** The model key: `TYPESAFE_API_KEY`, else its line in the TypeSafe env file. */
function typesafeKey(home: string): string {
  const key = Deno.env.get("TYPESAFE_API_KEY");
  if (key) return key;
  // fallback: the key already lives in ~/.simt/typesafe/env; read only its TYPESAFE_API_KEY= line.
  const path = Deno.env.get("TYPESAFE_ENV_PATH") ?? `${home}/.simt/typesafe/env`;
  let text: string;
  try {
    text = Deno.readTextFileSync(path);
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) {
      throw new MissingKeyError(`no TYPESAFE_API_KEY, and no key file at ${path}`);
    }
    throw e;
  }
  const found = keyFromEnvFile(text);
  if (!found) {
    throw new MissingKeyError(`no TYPESAFE_API_KEY, and no TYPESAFE_API_KEY= line in ${path}`);
  }
  return found;
}

/** {@link OrganiseDeps} from the environment: the only place organise reads it. */
export function envDeps(o: { account?: string }): OrganiseDeps {
  const home = Deno.env.get("HOME") ?? ".";
  const ctx = contextFromEnv({ account: o.account, json: true });
  const say = (l: string) => console.error(`  ${l}`);
  return {
    dataDir: Deno.env.get("GMAIL_ORGANISE_DATA") ?? `${home}/.simt/gmail-api/organise`,
    gmail: () => client(ctx),
    writer: async () =>
      new GuardedWriter(new GmailWriter(await client(ctx), { log: say }), {
        log: {
          path: ctx.credentialsPath.replace(/[^/]+$/, "writes.log"),
          via: "gmail-api-organise",
        },
      }),
    judge: (model) =>
      new SystemOneJudge({
        apiKey: typesafeKey(home),
        model,
        // fallback: an empty TYPESAFE_ENDPOINT means the default endpoint.
        endpoint: Deno.env.get("TYPESAFE_ENDPOINT") || undefined,
      }),
    grants: async () => {
      // One sign-in since 0.9.0: it is the write grant too when it holds modify and compose.
      const gmail = await client(ctx);
      const read = {
        email: (await gmail.profile()).emailAddress,
        scopes: await gmail.grantedScopes(),
      };
      const canWrite = [SCOPE_MODIFY, SCOPE_COMPOSE].every((s) => read.scopes.includes(s));
      return canWrite ? { read, write: read } : { read };
    },
    out: (t) => console.log(t),
    err: (t) => console.error(t),
  };
}
