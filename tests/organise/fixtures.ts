/**
 * Synthetic mailbox for the organise contract test.
 *
 * Plain data and builders only: no imports, so the same fixtures drive both the
 * contract test (against gmail-api's `organise`) and the check against the
 * gmail-organiser engine it is ported from. Every address and name is invented.
 *
 * @module
 */

/** The mailbox owner. */
export const OWNER = "me@home.test";

/** The clock every decision in the contract runs at: 2026-09-01T00:00:00Z. */
export const NOW = Date.UTC(2026, 8, 1);

/** One message as the fake Gmail holds it. */
export interface FixtureMessage {
  id: string;
  threadId: string;
  /** ms since epoch. */
  internalDate: number;
  labelIds: string[];
  /** Header name → value, in the order Gmail would list them. */
  headers: Record<string, string>;
  body: string;
}

const at = (iso: string) => Date.parse(iso);

function received(
  id: string,
  when: string,
  from: string,
  subject: string,
  extra: Record<string, string> = {},
  threadId = `t-${id}`,
  body = `Body of ${subject}.`,
): FixtureMessage {
  return {
    id,
    threadId,
    internalDate: at(when),
    labelIds: ["INBOX", "UNREAD", "CATEGORY_UPDATES"],
    headers: { From: from, To: OWNER, Subject: subject, Date: new Date(at(when)).toUTCString(), ...extra },
    body,
  };
}

function sent(id: string, when: string, to: string, subject: string, threadId = `t-${id}`): FixtureMessage {
  return {
    id,
    threadId,
    internalDate: at(when),
    labelIds: ["SENT"],
    headers: { From: `Me <${OWNER}>`, To: to, Subject: subject, Date: new Date(at(when)).toUTCString() },
    body: `Sent: ${subject}.`,
  };
}

/**
 * Sent mail. Six genuine messages to alice across more than 30 days make her a
 * strong relationship; the reply to bob puts his thread off limits to sampling.
 */
export const SENT: FixtureMessage[] = [
  sent("s1", "2019-01-10T09:00:00Z", "Alice <alice@partner.test>", "Kick-off"),
  sent("s2", "2019-02-15T09:00:00Z", "alice@partner.test", "Drawings"),
  sent("s3", "2019-04-01T09:00:00Z", "alice@partner.test", "Revised drawings"),
  sent("s4", "2019-06-01T09:00:00Z", "alice@partner.test", "Site access"),
  sent("s5", "2019-09-01T09:00:00Z", "alice@partner.test", "Commissioning"),
  sent("s6", "2020-02-01T09:00:00Z", "alice@partner.test", "Handover"),
  sent("s7", "2020-05-02T09:00:00Z", "bob@partner2.test", "Re: contract terms", "t-replied"),
];

/** Received mail. Ids r1… are referenced by the expectations below. */
export const RECEIVED: FixtureMessage[] = [
  received("r1", "2020-01-14T08:00:00Z", "Letters <news@letters.test>", "Weekly digest #12", {
    "List-Unsubscribe": "<mailto:unsubscribe@letters.test>",
  }),
  received("r2", "2020-02-20T10:00:00Z", "Alice <alice@partner.test>", "Site visit next week?"),
  received(
    "r3",
    "2020-03-05T11:00:00Z",
    "Vendor Billing <billing@vendor.test>",
    "Invoice INV-1001 for March",
  ),
  received("r4", "2020-04-01T12:00:00Z", "Carol <carol@client.test>", "Accepted: Quarterly review"),
  received("r5", "2020-04-20T13:00:00Z", "Dave <dave@friend.test>", "Automatic reply: Lunch?", {
    "Auto-Submitted": "auto-replied",
  }),
  received("r6", "2020-05-01T14:00:00Z", "Bob <bob@partner2.test>", "contract terms", {}, "t-replied"),
  received("r7", "2020-07-01T15:00:00Z", "Erin <erin@other.test>", "Quick question", {}, "t-grown"),
  received("r8", "2021-01-05T15:00:00Z", "Erin <erin@other.test>", "Re: Quick question", {}, "t-grown"),
  received("r9", "2020-08-10T16:00:00Z", "Sam Sales <sales@cold.test>", "Grow your pipeline 10x"),
  received("r10", "2020-09-01T07:00:00Z", "Social <digest@social.test>", "Your weekly social roundup"),
  received("r11", "2020-10-01T09:30:00Z", "Pat <person@neutral.test>", "Notes from Thursday"),
  received("r12", "2020-11-11T11:00:00Z", "Forum <list@forum.test>", "[forum] Thread about inverters", {
    "List-Post": "<mailto:list@forum.test>",
    "List-Id": "Forum <forum.forum.test>",
  }),
];

/** Message ids whose first full read is refused with 403 `rateLimitExceeded`. */
export const FLAKY = new Set(["r11"]);

/** The triage question ids the routes read (gmail-organiser `VERDICT_QUESTIONS`). */
export const TRIAGE_IDS = [
  "is_personal",
  "is_a_record",
  "is_perishable",
  "needs_personal_response",
  "bulk_automated",
  "record_lives_elsewhere",
  "carries_private_data",
  "concerns_my_operations",
] as const;

type Nouls = Record<(typeof TRIAGE_IDS)[number], number>;

const n = (
  personal: number,
  record: number,
  perishable: number,
  needs: number,
  bulk: number,
  elsewhere: number,
  data: number,
  ops: number,
): Nouls => ({
  is_personal: personal,
  is_a_record: record,
  is_perishable: perishable,
  needs_personal_response: needs,
  bulk_automated: bulk,
  record_lives_elsewhere: elsewhere,
  carries_private_data: data,
  concerns_my_operations: ops,
});

/**
 * What the fake decision model answers, keyed by subject (the model sees the
 * message state, and subjects are unique here). `project` is the Choice the
 * declarative scheme asks.
 */
export const ANSWERS: Record<string, { nouls: Nouls; project: string }> = {
  "Weekly digest #12": { nouls: n(0.05, 0.05, 0.95, 0.02, 0.97, 0.3, 0.02, 0.05), project: "none" },
  "Site visit next week?": { nouls: n(0.92, 0.3, 0.4, 0.75, 0.03, 0.1, 0.2, 0.6), project: "alpha" },
  "Invoice INV-1001 for March": { nouls: n(0.3, 0.95, 0.1, 0.1, 0.35, 0.1, 0.5, 0.8), project: "beta" },
  "Accepted: Quarterly review": { nouls: n(0.6, 0.2, 0.7, 0.1, 0.8, 0.9, 0.05, 0.4), project: "none" },
  "Automatic reply: Lunch?": { nouls: n(0.7, 0.05, 0.9, 0.05, 0.9, 0.1, 0.01, 0.1), project: "none" },
  "contract terms": { nouls: n(0.9, 0.6, 0.2, 0.8, 0.05, 0.1, 0.3, 0.7), project: "alpha" },
  "Quick question": { nouls: n(0.8, 0.2, 0.3, 0.8, 0.05, 0.1, 0.1, 0.3), project: "none" },
  "Grow your pipeline 10x": { nouls: n(0.2, 0.05, 0.6, 0.2, 0.6, 0.1, 0.02, 0.05), project: "none" },
  "Your weekly social roundup": { nouls: n(0.1, 0.02, 0.95, 0.01, 0.98, 0.5, 0.01, 0.05), project: "none" },
  "Notes from Thursday": { nouls: n(0.5, 0.5, 0.3, 0.1, 0.3, 0.2, 0.1, 0.3), project: "none" },
  "[forum] Thread about inverters": { nouls: n(0.3, 0.2, 0.5, 0.1, 0.7, 0.2, 0.05, 0.2), project: "none" },
};

/** Sender rulings in force for the triage scheme. */
export const TRIAGE_SENDERS = { delete: { "digest@social.test": "social roundups" } };

/** Which received messages a 2020 single-message sample must contain. */
export const SAMPLED_2020 = ["r1", "r2", "r3", "r4", "r5", "r7", "r9", "r10", "r11", "r12"];
/** Sampled, then rejected at fetch because the thread grew in 2021. */
export const REJECTED_2020 = ["r7"];

/**
 * Verdict and route per message for the triage scheme at {@link NOW}. Proven
 * against the gmail-organiser engine (`lib/decide.ts`, branch
 * `worktree-four-verdicts`) before handover; a faithful port reproduces it.
 */
export const TRIAGE_EXPECTED: Record<string, { verdict: string; route: string }> = {
  r1: { verdict: "delete", route: "campaign" },
  r2: { verdict: "important", route: "important-relationship" },
  r3: { verdict: "important", route: "important-record" },
  r4: { verdict: "delete", route: "calendar" },
  r5: { verdict: "delete", route: "auto-reply" },
  r9: { verdict: "delete", route: "stranger" },
  r10: { verdict: "delete", route: "policy" },
  r11: { verdict: "keep", route: "none" },
  r12: { verdict: "defer", route: "list" },
};

/** Category per message for the `project` choice scheme. */
export const PROJECT_EXPECTED: Record<string, string> = {
  r1: "none",
  r2: "alpha",
  r3: "beta",
  r4: "none",
  r5: "none",
  r9: "none",
  r10: "none",
  r11: "none",
  r12: "none",
};

const b64url = (s: string) =>
  btoa(String.fromCharCode(...new TextEncoder().encode(s))).replaceAll("+", "-").replaceAll("/", "_")
    .replace(/=+$/, "");

/**
 * The message as Gmail's `users.messages.get` returns it. `metadata` omits the
 * body, as Gmail does.
 */
export function gmailMessage(m: FixtureMessage, format: "full" | "metadata" = "full") {
  const headers = Object.entries(m.headers).map(([name, value]) => ({ name, value }));
  return {
    id: m.id,
    threadId: m.threadId,
    labelIds: [...m.labelIds],
    snippet: m.body.slice(0, 80),
    historyId: "1",
    internalDate: String(m.internalDate),
    sizeEstimate: m.body.length + 200,
    payload: {
      partId: "",
      mimeType: "text/plain",
      filename: "",
      headers,
      body: format === "full" ? { size: m.body.length, data: b64url(m.body) } : { size: m.body.length },
    },
  };
}
