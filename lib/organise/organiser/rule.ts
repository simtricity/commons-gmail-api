/**
 * The rule stage: recording a person's verdict on a message.
 *
 * @module
 */

import { type GoldenCase, parseGolden } from "../golden.ts";
import { parseProfile } from "../profile.ts";
import { withRuling, withSenderRuling } from "../rulings.ts";
import { ProfileError, type SchemeDecision } from "../scheme.ts";
import { categoriesOf, schemeOf, type StageContext } from "./context.ts";
import { decide, decisionsOf, runs } from "./decide.ts";
import { readJsonOr, safeName, writeJson } from "./store.ts";
import type { RuleOptions, RuleResult } from "./types.ts";

/** The message's decision in `run`, or in the newest run that decided it. */
async function decisionFor(
  ctx: StageContext,
  o: RuleOptions,
): Promise<SchemeDecision | undefined> {
  const candidates = o.run ? [safeName("run", o.run)] : (await runs(ctx)).map((m) => m.id);
  for (const run of candidates) {
    try {
      const d = (await decisionsOf(ctx, run, o.scheme)).decisions.find((x) => x.id === o.id);
      if (d) return d;
    } catch (e) {
      // fallback: a run not yet decided under this scheme cannot name the sender; try the next.
      if (!(e instanceof Deno.errors.NotFound)) throw e;
    }
  }
  return undefined;
}

/**
 * Record a golden case, replacing any earlier one for the same scheme and
 * message, and with `sender` also rule the message's sender into the one
 * category. Everything is validated before either rulings file is written.
 * The profile and golden set are then rebuilt, and with `run` the scheme is
 * re-decided for that run and the message's new decision returned.
 */
export async function rule(ctx: StageContext, o: RuleOptions): Promise<RuleResult> {
  const scheme = schemeOf(ctx, o.scheme);
  const ruling: GoldenCase = {
    id: o.id,
    scheme: scheme.id,
    expect: o.is,
    ...(o.never?.length ? { never: o.never } : {}),
    ...(o.note !== undefined ? { note: o.note } : {}),
  };
  const golden = parseGolden(
    { cases: withRuling(ctx.golden, ruling) },
    categoriesOf(ctx.profile),
  );
  const written = golden.find((c) => c.id === o.id && c.scheme === scheme.id)!;

  let senders = ctx.senders;
  let sender: RuleResult["sender"];
  if (o.sender) {
    if (Array.isArray(o.is) && o.is.length !== 1) {
      throw new ProfileError("a sender ruling needs exactly one category");
    }
    const category = Array.isArray(o.is) ? o.is[0] : o.is;
    const d = await decisionFor(ctx, o);
    if (!d) {
      throw new Error(
        `message ${o.id} is not decided under ${scheme.id} in ${
          o.run ? `run ${o.run}` : "any run"
        }; its sender is unknown until it is decided`,
      );
    }
    const address = d.sender.trim().toLowerCase();
    senders = {
      ...ctx.senders,
      [scheme.id]: withSenderRuling(
        ctx.senders[scheme.id] ?? {},
        address,
        category,
        o.note ?? "",
        scheme.categories,
      ),
    };
    sender = { address, category };
  }

  // Rebuild before writing, so a ruling the profile cannot take leaves both files as they were.
  // fallback: no profile file means the empty profile, as open reads it.
  const profile = parseProfile(await readJsonOr<unknown>(ctx.files.profile, {}), senders);
  await writeJson(ctx.files.golden, { cases: golden });
  if (sender) await writeJson(ctx.files.senders, senders);
  ctx.profile = profile;
  ctx.senders = senders;
  ctx.golden = golden;

  if (!o.run) return { case: written, ...(sender ? { sender } : {}) };
  await decide(ctx, { run: o.run, schemes: [scheme.id] });
  const decision = (await decisionsOf(ctx, o.run, scheme.id)).decisions.find((d) => d.id === o.id);
  return {
    case: written,
    ...(sender ? { sender } : {}),
    ...(decision ? { decision } : {}),
  };
}
