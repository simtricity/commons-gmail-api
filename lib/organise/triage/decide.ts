/**
 * From typed judgements and headers to one verdict per message.
 *
 * Pure: no network, no filesystem, and the clock arrives as `now`. Retuning a
 * threshold and re-deciding a whole run costs nothing, which is what makes it
 * safe to iterate on. Routes are tried in order and the first to answer wins,
 * so the order is the policy: each route's position is deliberate.
 *
 * @module
 */

import type { Answer } from "../types.ts";
import type { Verdict } from "../verdict.ts";
import type { SenderPolicy } from "../policy.ts";
import type { Relationships, Strength } from "../relationships.ts";
import {
  type Envelope,
  isAutoReplied,
  isCalendarNotice,
  isCampaign,
  isDiscussionList,
  senderIdentity,
  sentViaPlatform,
} from "../envelope.ts";
import { senderOf } from "../mail.ts";

// ── thresholds ───────────────────────────────────────────────────────────────

/** One step of the age-graded bar: mail younger than `underYears` must clear `bar`. */
export interface AgeStep {
  /** Omit on the last step, which applies to everything older. */
  underYears?: number;
  bar: number;
}

/**
 * Every number the routes compare against. All are Noul probabilities, which
 * are stable between identical calls; Choice confidence is not, and gates
 * nothing here.
 */
export interface DecisionThresholds {
  /**
   * Important: a durable record held nowhere else, private data about your own
   * operations, or a sustained relationship writing to you personally.
   */
  important: {
    recordAtLeast: number;
    elsewhereUnder: number;
    dataAtLeast: number;
    personalAtLeast: number;
    /** Records and data count as important only when a person sent them. */
    machineUnder: number;
    /**
     * A strong relationship's mail is important, whatever the personal score,
     * when it was this clearly written by a person rather than a machine.
     */
    relationshipMachineUnder: number;
  };
  /** A discussion list you can post into, and nothing personal: defer. */
  list: { personalUnder: number; recordUnder: number; needsReplyUnder: number };
  /** A known sender's mail goes only if it is emphatically disposable. */
  known: {
    perishableAtLeast: number;
    recordUnder: number;
    needsReplyUnder: number;
    personalUnder: number;
  };
  /** A mass mailing, even one a person signed, that records nothing and asks nothing: delete. */
  campaign: { personalUnder: number; recordUnder: number; needsReplyUnder: number };
  /** Impersonal, not a record, and perishable: delete. */
  perishable: { personalUnder: number; recordUnder: number; perishableAtLeast: number };
  /** Machine-sent, not a record, asks nothing of you: delete. */
  bulk: { bulkAtLeast: number; recordUnder: number; needsReplyUnder: number };
  /** Machine mail about your own operations whose record lives in a system you control: defer. */
  ops: {
    concernsAtLeast: number;
    bulkAtLeast: number;
    elsewhereAtLeast: number;
    recordUnder: number;
    needsReplyUnder: number;
  };
  /**
   * Emphatically perishable machine mail from a sender you have no history with:
   * delete, even with a middling record score. The model hedges on record-ness
   * for anything mentioning an account or order; perishability is the stronger signal.
   */
  perishableMachine: {
    machineAtLeast: number;
    perishableAtLeast: number;
    recordUnder: number;
    needsReplyUnder: number;
    personalUnder: number;
  };
  /**
   * A notification whose record lives elsewhere: delete, more readily the older it is.
   * The loosest bar sits just above a tax return that scored 0.87.
   */
  elsewhere: {
    byAge: AgeStep[];
    needsReplyUnder: number;
    /**
     * A record this certain is never deleted on the word that its original lives
     * elsewhere: "You just signed <engagement letter>" scored 0.92 record and
     * 0.9 elsewhere, and was one template away from a must-keep tax return.
     */
    recordUnder: number;
  };
  /** Nobody you know, nothing personal, nothing to do with your operations: delete. */
  stranger: {
    personalUnder: number;
    recordUnder: number;
    needsReplyUnder: number;
    concernsUnder: number;
    /**
     * Below this, the personal and reply scores are ignored. Cold outreach is
     * written to read as personal and to demand a reply; a recruiter scored 0.89
     * personal. Having nothing to do with your operations is what gives it away.
     */
    concernsStrictUnder: number;
  };
}

export const DEFAULT_THRESHOLDS: DecisionThresholds = {
  important: {
    recordAtLeast: 0.85,
    elsewhereUnder: 0.50,
    dataAtLeast: 0.80,
    personalAtLeast: 0.70,
    machineUnder: 0.50,
    relationshipMachineUnder: 0.30,
  },
  list: { personalUnder: 0.50, recordUnder: 0.80, needsReplyUnder: 0.30 },
  known: { perishableAtLeast: 0.90, recordUnder: 0.20, needsReplyUnder: 0.15, personalUnder: 0.30 },
  campaign: { personalUnder: 0.50, recordUnder: 0.20, needsReplyUnder: 0.15 },
  perishable: { personalUnder: 0.15, recordUnder: 0.20, perishableAtLeast: 0.80 },
  bulk: { bulkAtLeast: 0.90, recordUnder: 0.20, needsReplyUnder: 0.15 },
  ops: {
    concernsAtLeast: 0.70,
    bulkAtLeast: 0.85,
    elsewhereAtLeast: 0.70,
    recordUnder: 0.80,
    needsReplyUnder: 0.30,
  },
  perishableMachine: {
    machineAtLeast: 0.95,
    perishableAtLeast: 0.90,
    recordUnder: 0.50,
    needsReplyUnder: 0.15,
    personalUnder: 0.50,
  },
  elsewhere: {
    byAge: [
      { underYears: 2, bar: 0.95 },
      { underYears: 5, bar: 0.92 },
      { underYears: 10, bar: 0.90 },
      { bar: 0.88 },
    ],
    needsReplyUnder: 0.30,
    recordUnder: 0.85,
  },
  stranger: {
    personalUnder: 0.30,
    recordUnder: 0.20,
    needsReplyUnder: 0.30,
    concernsUnder: 0.30,
    concernsStrictUnder: 0.15,
  },
};

/** Overrides are merged per group, so a config can move one number without restating the rest. */
export type ThresholdOverrides = {
  [K in keyof DecisionThresholds]?: Partial<DecisionThresholds[K]>;
};

export function mergeThresholds(overrides: ThresholdOverrides = {}): DecisionThresholds {
  const out = structuredClone(DEFAULT_THRESHOLDS) as unknown as Record<
    string,
    Record<string, unknown>
  >;
  for (const [group, values] of Object.entries(overrides)) {
    if (!(group in out)) throw new Error(`unknown threshold group "${group}"`);
    Object.assign(out[group], values);
  }
  return out as unknown as DecisionThresholds;
}

/** The bar a message of this age must clear. */
export function ageBar(steps: AgeStep[], ageYears: number): number {
  const step = steps.find((s) => s.underYears === undefined || ageYears < s.underYears);
  // fallback: a config whose last step has an age limit leaves the oldest mail unmatched,
  // so hold it to the strictest bar rather than none.
  return step?.bar ?? Math.max(...steps.map((s) => s.bar));
}

// ── inputs and outputs ───────────────────────────────────────────────────────

export interface DecisionInput {
  id: string;
  from: string;
  subject: string;
  /** The Date header. Used for age when `internalDate` is absent. */
  date?: string;
  /** ms since epoch as Gmail reports it: more reliable than a sender's Date header. */
  internalDate?: string;
  envelope?: Envelope;
  answers: Record<string, Answer | undefined>;
}

export interface DecisionContext {
  policy: SenderPolicy;
  relationships: Relationships;
  thresholds: DecisionThresholds;
  /** ms since epoch. Injected, so a decision is reproducible. */
  now: number;
}

/** Why a sender's mail is treated as correspondence. `null`: it is not. */
export type Protection = "address" | "domain" | null;

export interface Decision {
  id: string;
  verdict: Verdict;
  /** The route that decided. */
  route: string;
  why: string;
  sender: string;
  senderDomain: string;
  subject: string;
  protected: Protection;
}

// ── facts ────────────────────────────────────────────────────────────────────

/** Everything a route may look at, computed once per message. */
export interface Facts {
  sender: string;
  domain: string;
  subject: string;
  ageYears: number;
  envelope?: Envelope;
  /** A Noul probability, or NaN when the question was not answered. */
  p(question: string): number;
  choice(question: string): string | undefined;
  protection: Protection;
  /** How well the sent-mail corpus knows the sender. */
  strength: Strength;
  /** A mass mailing: an unsubscribe link or a mailing platform's envelope. */
  campaign: boolean;
  /** An outside discussion list you could post into. Your own relaying groups are not. */
  discussionList: boolean;
}

/**
 * Local parts that only machines use. A match forfeits the protection a known
 * sender's mail would otherwise get; it does not delete anything by itself.
 *
 * Deliberately narrow. Words like `updates`, `alerts` or `digest` are also real
 * shared mailboxes that people answer from, and campaigns are caught
 * structurally anyway, by their unsubscribe link or their platform envelope.
 */
const MACHINE_LOCAL_PART =
  /(^|[.\-_])(no-?reply|do-?not-?reply|bounces?|mailer-daemon|postmaster)([.\-_]|$)/i;

function protectionOf(
  sender: string,
  domain: string,
  env: Envelope | undefined,
  rel: Relationships,
): Protection {
  if (MACHINE_LOCAL_PART.test(sender.split("@")[0])) return null;
  if (env?.listUnsubscribe) return null; // a campaign, whoever signed it
  if (env && sentViaPlatform(env)) return null;
  if (rel.isSelfDomain(domain)) return null;
  if (rel.strength(sender) !== "none") return "address";
  if (rel.trustedDomain(domain)) return "domain";
  return null;
}

function ageInYears(input: DecisionInput, now: number): number {
  const t = input.internalDate ? Number(input.internalDate) : Date.parse(input.date ?? "");
  // fallback: an undated message is treated as new, which holds it to the strictest bar.
  return Number.isFinite(t) && t > 0 ? (now - t) / (365.25 * 86_400_000) : 0;
}

const domainPart = (address: string) => (address.includes("@") ? address.split("@").pop()! : "");

export function factsOf(input: DecisionInput, ctx: DecisionContext): Facts {
  const env = input.envelope;
  // The true author: a Google Group rewrites From to the group itself.
  const sender = env ? senderIdentity(env) : senderOf(input.from);
  const domain = domainPart(sender);
  // A list relayed through one of your own domains is your own group, not a
  // discussion you joined, so it is judged on its author like any other mail.
  const listHost = env ? domainPart(senderOf(env.returnPath) || senderOf(env.from)) : "";
  return {
    sender,
    domain,
    subject: input.subject ?? "",
    ageYears: ageInYears(input, ctx.now),
    envelope: env,
    p: (q) => input.answers[q]?.noul ?? NaN,
    choice: (q) => input.answers[q]?.choice,
    protection: protectionOf(sender, domain, env, ctx.relationships),
    strength: ctx.relationships.strength(sender),
    campaign: isCampaign(env),
    discussionList: Boolean(env) && isDiscussionList(env!) &&
      !ctx.relationships.isSelfDomain(listHost),
  };
}

// ── routes ───────────────────────────────────────────────────────────────────

export interface Outcome {
  verdict: Verdict;
  why: string;
}

export interface Route {
  name: string;
  decide(f: Facts, ctx: DecisionContext): Outcome | undefined;
}

const fmt = (n: number) => n.toFixed(2);

/**
 * The Noul question ids the routes read. The wording is the operator's, in
 * config; the ids are the contract. A missing question never deletes anything:
 * the routes that need it simply do not fire.
 */
export const VERDICT_QUESTIONS = [
  "is_personal",
  "is_a_record",
  "is_perishable",
  "needs_personal_response",
  "bulk_automated",
  "record_lives_elsewhere",
  "carries_private_data",
  "concerns_my_operations",
] as const;

/** The questions every judgement route needs. Without them only deterministic routes may act. */
const CORE_QUESTIONS = ["is_personal", "is_a_record", "is_perishable"];

/** Machine mail about your own operations whose record lives in a system you control. */
function operational(f: Facts, t: DecisionThresholds["ops"]): Outcome | undefined {
  const elsewhere = f.p("record_lives_elsewhere");
  return f.p("concerns_my_operations") >= t.concernsAtLeast &&
      f.p("bulk_automated") >= t.bulkAtLeast && elsewhere >= t.elsewhereAtLeast &&
      f.p("is_a_record") < t.recordUnder && f.p("needs_personal_response") < t.needsReplyUnder
    ? { verdict: "defer", why: `operational, record elsewhere ${fmt(elsewhere)}` }
    : undefined;
}

/**
 * Deterministic routes first, then importance, then the routes that defer or
 * delete. Importance sits ahead of every delete route that reads the model, so
 * no threshold tuned for junk can reach a record, private data or a real
 * relationship. It sits behind calendar and auto-reply, which are about the
 * kind of message rather than its sender: an out-of-office from a friend goes.
 */
export const ROUTES: Route[] = [
  {
    // An explicit ruling outranks every heuristic.
    name: "policy",
    decide: (f, ctx) => {
      const r = ctx.policy.get(f.sender);
      return r && { verdict: r.verdict, why: `sender policy: ${r.verdict}` };
    },
  },
  {
    name: "calendar",
    decide: (f) =>
      isCalendarNotice(f.sender, f.subject)
        ? { verdict: "delete", why: "calendar event, held in the calendar" }
        : undefined,
  },
  {
    name: "auto-reply",
    decide: (f) =>
      isAutoReplied(f.subject, f.envelope) ? { verdict: "delete", why: "auto-reply" } : undefined,
  },
  {
    // Missing answers never delete: keep, and let a re-judge settle it.
    name: "incomplete",
    decide: (f) =>
      CORE_QUESTIONS.some((q) => Number.isNaN(f.p(q)))
        ? { verdict: "keep", why: "incomplete judgement" }
        : undefined,
  },
  {
    // A durable record a person sent: a contract, a signed variation, a
    // certificate passed on by a colleague. Unless the record itself is held
    // elsewhere and this is only word of it.
    //
    // Machine-sent records (receipts, software-generated invoices, booking
    // confirmations) are worth keeping but routine, and would crowd out the
    // mail that matters, so they fall through to keep. So do repeating reports.
    name: "important-record",
    decide: (f, { thresholds: { important: t } }) => {
      const rec = f.p("is_a_record");
      return rec >= t.recordAtLeast && !(f.p("record_lives_elsewhere") >= t.elsewhereUnder) &&
          f.p("bulk_automated") < t.machineUnder
        ? { verdict: "important", why: `record ${fmt(rec)}, sent by a person` }
        : undefined;
    },
  },
  {
    // Data about your own operations that you could not easily get again, sent
    // by a person. A campaign is never private data, however many figures it quotes.
    name: "important-data",
    decide: (f, { thresholds: { important: t } }) => {
      const data = f.p("carries_private_data");
      return data >= t.dataAtLeast && !f.campaign && f.p("bulk_automated") < t.machineUnder
        ? { verdict: "important", why: `private data ${fmt(data)}, sent by a person` }
        : undefined;
    },
  },
  {
    // Someone you have corresponded with over time, writing to you personally,
    // or plainly writing as a person. The model reads a working email with you
    // on copy among colleagues as impersonal (one scored 0.06), but the corpus
    // knows every recipient: the sender's history is the better witness.
    name: "important-relationship",
    decide: (f, { thresholds: { important: t } }) => {
      if (f.protection !== "address" || f.strength !== "strong") return undefined;
      const p = f.p("is_personal");
      if (p >= t.personalAtLeast) {
        return { verdict: "important", why: `strong relationship, personal ${fmt(p)}` };
      }
      const machine = f.p("bulk_automated");
      return machine < t.relationshipMachineUnder
        ? {
          verdict: "important",
          why: `strong relationship, written by a person (machine ${fmt(machine)})`,
        }
        : undefined;
    },
  },
  {
    // A discussion list is sector traffic worth holding a while, not junk: it
    // sits ahead of the delete routes that would otherwise read it as bulk.
    name: "list",
    decide: (f, { thresholds: { list: t } }) =>
      f.discussionList && f.p("is_personal") < t.personalUnder &&
        f.p("is_a_record") < t.recordUnder && f.p("needs_personal_response") < t.needsReplyUnder
        ? { verdict: "defer", why: "discussion list, not personal" }
        : undefined,
  },
  {
    // Knowing the sender raises the bar; it does not suspend judgement.
    name: "known-sender",
    decide: (f, { thresholds }) => {
      if (!f.protection) return undefined;
      const t = thresholds.known;
      const per = f.p("is_perishable");
      if (
        per >= t.perishableAtLeast && f.p("is_a_record") < t.recordUnder &&
        f.p("needs_personal_response") < t.needsReplyUnder && f.p("is_personal") < t.personalUnder
      ) {
        return { verdict: "delete", why: `known ${f.protection}, but perishable ${fmt(per)}` };
      }
      // A known vendor's monitoring is still monitoring: defer it rather than keep it.
      return operational(f, thresholds.ops) ?? { verdict: "keep", why: `known ${f.protection}` };
    },
  },
  {
    // A person's name on a mass mailing makes it read as personal to the model.
    // The envelope says otherwise, so the personal bar here is looser.
    name: "campaign",
    decide: (f, { thresholds: { campaign: t } }) =>
      f.campaign && f.p("is_personal") < t.personalUnder && f.p("is_a_record") < t.recordUnder &&
        f.p("needs_personal_response") < t.needsReplyUnder
        ? { verdict: "delete", why: "mass mailing, not a record" }
        : undefined,
  },
  {
    name: "perishable",
    decide: (f, { thresholds: { perishable: t } }) =>
      f.p("is_personal") < t.personalUnder && f.p("is_a_record") < t.recordUnder &&
        f.p("is_perishable") >= t.perishableAtLeast
        ? { verdict: "delete", why: "impersonal, not a record, perishable" }
        : undefined,
  },
  {
    name: "bulk",
    decide: (f, { thresholds: { bulk: t } }) => {
      const bulk = f.p("bulk_automated");
      return bulk >= t.bulkAtLeast && f.p("is_a_record") < t.recordUnder &&
          f.p("needs_personal_response") < t.needsReplyUnder
        ? { verdict: "delete", why: `bulk ${fmt(bulk)}` }
        : undefined;
    },
  },
  {
    // Deferred deletion. After the delete routes, so social and marketing
    // notifications about your accounts still go; ahead of `elsewhere`, which
    // would otherwise take the monitoring.
    name: "ops",
    decide: (f, { thresholds: { ops: t } }) => operational(f, t),
  },
  {
    // After ops and list, so monitoring and discussion lists are deferred first.
    name: "perishable-machine",
    decide: (f, { thresholds: { perishableMachine: t } }) => {
      const per = f.p("is_perishable");
      return !f.protection && f.p("bulk_automated") >= t.machineAtLeast &&
          per >= t.perishableAtLeast &&
          f.p("is_a_record") < t.recordUnder &&
          f.p("needs_personal_response") < t.needsReplyUnder &&
          f.p("is_personal") < t.personalUnder
        ? { verdict: "delete", why: `machine mail, perishable ${fmt(per)}` }
        : undefined;
    },
  },
  {
    name: "elsewhere",
    decide: (f, { thresholds: { elsewhere: t } }) => {
      const elsewhere = f.p("record_lives_elsewhere");
      const bar = ageBar(t.byAge, f.ageYears);
      return elsewhere >= bar && f.p("needs_personal_response") < t.needsReplyUnder &&
          f.p("is_a_record") < t.recordUnder
        ? { verdict: "delete", why: `record elsewhere ${fmt(elsewhere)} (bar ${bar})` }
        : undefined;
    },
  },
  {
    // Cold outreach, spam and marketing from companies you have no dealings with.
    // Last, so every route that might keep or defer has had its turn.
    name: "stranger",
    decide: (f, { thresholds: { stranger: t } }) => {
      if (f.protection || f.strength !== "none" || !(f.p("is_a_record") < t.recordUnder)) {
        return undefined;
      }
      const concerns = f.p("concerns_my_operations");
      if (concerns < t.concernsStrictUnder) {
        return { verdict: "delete", why: `unknown sender, nothing operational (${fmt(concerns)})` };
      }
      return f.p("is_personal") < t.personalUnder &&
          f.p("needs_personal_response") < t.needsReplyUnder &&
          concerns < t.concernsUnder
        ? { verdict: "delete", why: "unknown sender, nothing personal or operational" }
        : undefined;
    },
  },
];

/** What held a message back, for the residue that no route claimed. */
function heldBecause(f: Facts, t: DecisionThresholds): string {
  const held: string[] = [];
  if (!(f.p("is_a_record") < t.perishable.recordUnder)) {
    held.push(`record ${fmt(f.p("is_a_record"))}`);
  }
  if (!(f.p("is_personal") < t.perishable.personalUnder)) {
    held.push(`personal ${fmt(f.p("is_personal"))}`);
  }
  if (!(f.p("is_perishable") >= t.perishable.perishableAtLeast)) {
    held.push(`perishable ${fmt(f.p("is_perishable"))}`);
  }
  return held.join(", ") || "no route";
}

export function decide(
  input: DecisionInput,
  ctx: DecisionContext,
  routes: Route[] = ROUTES,
): Decision {
  const f = factsOf(input, ctx);
  const base = {
    id: input.id,
    sender: f.sender,
    senderDomain: f.domain,
    subject: f.subject,
    protected: f.protection,
  };
  for (const route of routes) {
    const out = route.decide(f, ctx);
    if (out) return { ...base, ...out, route: route.name };
  }
  return { ...base, verdict: "keep", route: "none", why: heldBecause(f, ctx.thresholds) };
}
