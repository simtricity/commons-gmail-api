import { assert, assertEquals, assertThrows } from "@std/assert";
import type { Message } from "../../mod.ts";
import { CorpusBuilder, selfAddressesFrom } from "../../lib/organise/corpus.ts";
import type { Envelope } from "../../lib/organise/envelope.ts";
import { type OrganiseMessage, toOrganiseMessage } from "../../lib/organise/message.ts";
import { parsePolicy } from "../../lib/organise/policy.ts";
import { Relationships } from "../../lib/organise/relationships.ts";
import { type Answers, ProfileError } from "../../lib/organise/scheme.ts";
import {
  decide,
  type DecisionContext,
  type DecisionInput,
  factsOf,
  mergeThresholds,
  ROUTES,
} from "../../lib/organise/triage/decide.ts";
import { TRIAGE_DEFAULT_QUESTIONS } from "../../lib/organise/triage/questions.ts";
import { triageScheme } from "../../lib/organise/triage/scheme.ts";
import { sha256Hex } from "../../lib/mime.ts";
import {
  ANSWERS,
  gmailMessage,
  NOW,
  OWNER,
  RECEIVED,
  SENT,
  TRIAGE_EXPECTED,
  TRIAGE_IDS,
  TRIAGE_SENDERS,
} from "./fixtures.ts";

const noul = (v: number) => ({ type: "noul" as const, noul: v });

// ── the contract's synthetic mailbox ─────────────────────────────────────────

function contractRelationships(): Relationships {
  const sent = SENT.map((m) => gmailMessage(m) as Message);
  const self = selfAddressesFrom(
    sent.map((m) => m.payload?.headers?.find((h) => h.name === "From")?.value ?? ""),
    {
      profile: OWNER,
    },
  );
  const b = new CorpusBuilder({ selfAddresses: self });
  for (const m of sent) b.add(m);
  return new Relationships(b.finish("in:sent"));
}

function contractAnswers(subject: string): Answers {
  const known = ANSWERS[subject];
  return Object.fromEntries(TRIAGE_IDS.map((q) => [q, noul(known.nouls[q])]));
}

Deno.test("triageScheme decides exactly as decide() on every contract message", () => {
  const relationships = contractRelationships();
  const scheme = triageScheme({ senders: TRIAGE_SENDERS });
  const ctx: DecisionContext = {
    policy: parsePolicy(TRIAGE_SENDERS),
    relationships,
    thresholds: mergeThresholds(),
    now: NOW,
  };
  // Every received message the fake model can answer; r8 is the reply that grows r7's thread,
  // rejected at fetch and never judged.
  const judged = RECEIVED.filter((m) => ANSWERS[m.headers.Subject]);
  assertEquals(RECEIVED.filter((m) => !judged.includes(m)).map((m) => m.id), ["r8"]);
  for (const fixture of judged) {
    const msg = toOrganiseMessage(gmailMessage(fixture) as Message);
    const answers = contractAnswers(msg.state.subject);
    const viaScheme = scheme.decide(msg, answers, { now: NOW, relationships });
    const raw = decide(inputOf(msg, answers), ctx, ROUTES);
    assertEquals(
      [viaScheme.category, viaScheme.route, viaScheme.why],
      [raw.verdict, raw.route, raw.why],
      fixture.id,
    );
    assertEquals(viaScheme.scheme, "triage");
    assertEquals(viaScheme.sender, raw.sender.toLowerCase());
  }
});

Deno.test("triageScheme reproduces the contract's expected verdicts and routes", () => {
  const relationships = contractRelationships();
  const scheme = triageScheme({ senders: TRIAGE_SENDERS });
  for (const [id, want] of Object.entries(TRIAGE_EXPECTED)) {
    const msg = toOrganiseMessage(gmailMessage(RECEIVED.find((m) => m.id === id)!) as Message);
    const d = scheme.decide(msg, contractAnswers(msg.state.subject), { now: NOW, relationships });
    assertEquals({ verdict: d.category, route: d.route }, want, id);
  }
});

// ── defaults, options and refusals ───────────────────────────────────────────

Deno.test("triageScheme: defaults", () => {
  const s = triageScheme();
  assertEquals([s.id, s.kind, s.labelPattern, s.labelPrefix], [
    "triage",
    "triage",
    "organiser/{year}/{verdict}",
    "organiser/",
  ]);
  assertEquals([...s.categories], ["delete", "defer", "keep", "important"]);
  assertEquals(s.questions, TRIAGE_DEFAULT_QUESTIONS);
  assertEquals(s.label("important", String(Date.UTC(2019, 6, 1))), "organiser/2019/important");
});

Deno.test("triageScheme: a wording override replaces one question and keeps the rest", () => {
  const reworded = { type: "noul" as const, instructions: "Written to me by a person." };
  const s = triageScheme({ questions: { is_personal: reworded } });
  assertEquals(s.questions.is_personal, reworded);
  assertEquals(s.questions.is_a_record, TRIAGE_DEFAULT_QUESTIONS.is_a_record);
});

Deno.test("triageScheme: refusals are ProfileErrors", () => {
  assertThrows(
    () => triageScheme({ questions: { is_spam: { type: "noul", instructions: "x" } } }),
    ProfileError,
  );
  assertThrows(() => triageScheme({ labelPattern: "triage/fixed" }), ProfileError);
  assertThrows(() => triageScheme({ thresholds: { nosuch: {} } as never }), ProfileError, "nosuch");
  assertThrows(() => triageScheme({ senders: { archive: { "a@x.test": "n" } } }), ProfileError);
  assertThrows(
    () => triageScheme({ senders: { delete: { "a@x.test": "n" }, keep: { "A@x.test": "n" } } }),
    ProfileError,
  );
});

Deno.test("the default wording: eight Nouls, generic, with the reserved-sector phrase removed", async () => {
  assertEquals(Object.keys(TRIAGE_DEFAULT_QUESTIONS).sort(), [...TRIAGE_IDS].sort());
  const text = JSON.stringify(TRIAGE_DEFAULT_QUESTIONS);
  assert(!/backing/i.test(text));
  assert(text.includes("data exports"));
  // Pins the exact default text: any wording change must update this hash deliberately.
  assertEquals(
    (await sha256Hex(new TextEncoder().encode(text))).slice(0, 16),
    "fd5af9bedabeef39",
  );
});

// ── route order: one fixture per adjacent pair that both routes claim ────────

const RULED = "ruled@vendor.test";
const STRONG = "friend@strong.test";
const KNOWN = "acq@known.test";
const STRANGER = "nobody@cold.test";

/** Six genuine messages to STRONG across a year, one to KNOWN. */
const relationships = new Relationships({
  selfAddresses: ["me@home.test"],
  correspondents: [
    {
      address: STRONG,
      domain: "strong.test",
      kind: "person",
      genuine: 6,
      incidental: 0,
      firstSeen: "2025-01-01T00:00:00.000Z",
      lastSeen: "2026-01-01T00:00:00.000Z",
    },
    {
      address: KNOWN,
      domain: "known.test",
      kind: "person",
      genuine: 1,
      incidental: 0,
      firstSeen: "2025-06-01T00:00:00.000Z",
      lastSeen: "2025-06-01T00:00:00.000Z",
    },
  ],
});
const senders = { keep: { [RULED]: "ruled for the test" } };

interface Shape {
  from: string;
  subject?: string;
  headers?: Partial<Envelope>;
  /** Noul answers; an absent id is unanswered. */
  nouls: Partial<Record<(typeof TRIAGE_IDS)[number], number>>;
}

function shaped(s: Shape): { msg: OrganiseMessage; answers: Answers } {
  const subject = s.subject ?? "Neutral subject";
  const envelope: Envelope = {
    from: s.from,
    returnPath: "",
    sender: "",
    originalSender: "",
    listUnsubscribe: "",
    listId: "",
    listPost: "",
    precedence: "",
    autoSubmitted: "",
    ...s.headers,
  };
  const msg: OrganiseMessage = {
    id: "m",
    threadId: "t",
    internalDate: String(NOW - 30 * 86_400_000),
    state: {
      from: s.from,
      to: "me@home.test",
      subject,
      date: "",
      is_reply: false,
      has_list_unsubscribe: Boolean(envelope.listUnsubscribe),
      body: "",
    },
    envelope,
  };
  const answers = Object.fromEntries(Object.entries(s.nouls).map(([q, v]) => [q, noul(v!)]));
  return { msg, answers };
}

function inputOf(msg: OrganiseMessage, answers: Answers): DecisionInput {
  return {
    id: msg.id,
    from: msg.state.from,
    subject: msg.state.subject,
    date: msg.state.date,
    internalDate: msg.internalDate,
    envelope: msg.envelope,
    answers,
  };
}

const quiet = {
  is_personal: 0.5,
  is_a_record: 0.5,
  is_perishable: 0.5,
  needs_personal_response: 0.5,
};

/** [earlier route, later route, a message both claim]. */
const PAIRS: [string, string, Shape][] = [
  ["policy", "calendar", { from: RULED, subject: "Accepted: Review", nouls: quiet }],
  ["calendar", "auto-reply", {
    from: STRANGER,
    subject: "Accepted: Review",
    headers: { autoSubmitted: "auto-replied" },
    nouls: quiet,
  }],
  ["auto-reply", "incomplete", { from: STRANGER, subject: "Automatic reply: Lunch", nouls: {} }],
  ["incomplete", "important-record", {
    from: STRANGER,
    nouls: { is_a_record: 0.9, record_lives_elsewhere: 0.1, bulk_automated: 0.1 },
  }],
  ["important-record", "important-data", {
    from: STRANGER,
    nouls: {
      is_personal: 0.5,
      is_a_record: 0.9,
      is_perishable: 0.1,
      record_lives_elsewhere: 0.1,
      bulk_automated: 0.1,
      carries_private_data: 0.9,
    },
  }],
  ["important-data", "important-relationship", {
    from: STRONG,
    nouls: {
      is_personal: 0.9,
      is_a_record: 0.1,
      is_perishable: 0.1,
      bulk_automated: 0.1,
      carries_private_data: 0.9,
    },
  }],
  ["important-relationship", "list", {
    from: STRONG,
    headers: { listPost: "<mailto:list@forum.test>" },
    nouls: {
      is_personal: 0.2,
      is_a_record: 0.1,
      is_perishable: 0.1,
      needs_personal_response: 0.1,
      bulk_automated: 0.1,
      carries_private_data: 0.1,
    },
  }],
  ["list", "known-sender", {
    from: KNOWN,
    headers: { listPost: "<mailto:list@forum.test>" },
    nouls: {
      is_personal: 0.2,
      is_a_record: 0.1,
      is_perishable: 0.1,
      needs_personal_response: 0.1,
      bulk_automated: 0.1,
      carries_private_data: 0.1,
    },
  }],
  ["campaign", "perishable", {
    from: STRANGER,
    headers: { listUnsubscribe: "<mailto:unsubscribe@cold.test>" },
    nouls: {
      is_personal: 0.1,
      is_a_record: 0.1,
      is_perishable: 0.9,
      needs_personal_response: 0.1,
      bulk_automated: 0.5,
      carries_private_data: 0.1,
    },
  }],
  ["perishable", "bulk", {
    from: STRANGER,
    nouls: {
      is_personal: 0.1,
      is_a_record: 0.1,
      is_perishable: 0.9,
      needs_personal_response: 0.1,
      bulk_automated: 0.95,
      carries_private_data: 0.1,
    },
  }],
  ["bulk", "ops", {
    from: STRANGER,
    nouls: {
      is_personal: 0.1,
      is_a_record: 0.1,
      is_perishable: 0.1,
      needs_personal_response: 0.1,
      bulk_automated: 0.95,
      record_lives_elsewhere: 0.8,
      carries_private_data: 0.1,
      concerns_my_operations: 0.8,
    },
  }],
  ["ops", "perishable-machine", {
    from: STRANGER,
    nouls: {
      is_personal: 0.1,
      is_a_record: 0.3,
      is_perishable: 0.95,
      needs_personal_response: 0.1,
      bulk_automated: 0.97,
      record_lives_elsewhere: 0.8,
      carries_private_data: 0.1,
      concerns_my_operations: 0.8,
    },
  }],
  ["perishable-machine", "elsewhere", {
    from: STRANGER,
    nouls: {
      is_personal: 0.1,
      is_a_record: 0.3,
      is_perishable: 0.95,
      needs_personal_response: 0.1,
      bulk_automated: 0.97,
      record_lives_elsewhere: 0.97,
      carries_private_data: 0.1,
      concerns_my_operations: 0.1,
    },
  }],
  ["elsewhere", "stranger", {
    from: STRANGER,
    nouls: {
      is_personal: 0.1,
      is_a_record: 0.1,
      is_perishable: 0.1,
      needs_personal_response: 0.1,
      bulk_automated: 0.5,
      record_lives_elsewhere: 0.97,
      carries_private_data: 0.1,
      concerns_my_operations: 0.1,
    },
  }],
];

Deno.test("route order: every adjacent pair but one has a fixture both routes claim", () => {
  const names = ROUTES.map((r) => r.name);
  const covered = new Set(PAIRS.map(([a, b]) => `${a}|${b}`));
  const missing = names.slice(1).map((b, i) => `${names[i]}|${b}`).filter((p) => !covered.has(p));
  assertEquals(
    missing,
    ["known-sender|campaign"],
    "the one pair no message can reach (pinned below)",
  );
  for (const [a, b] of PAIRS) {
    assertEquals(names.indexOf(b), names.indexOf(a) + 1, `${a} → ${b} adjacent`);
  }
});

for (const [earlier, later, shape] of PAIRS) {
  Deno.test(`route order: ${earlier} decides before ${later}`, () => {
    const { msg, answers } = shaped(shape);
    const d = triageScheme({ senders }).decide(msg, answers, { now: NOW, relationships });
    assertEquals(d.route, earlier, "the earlier route decides");
    const ctx: DecisionContext = {
      policy: parsePolicy(senders),
      relationships,
      thresholds: mergeThresholds(),
      now: NOW,
    };
    const facts = factsOf(inputOf(msg, answers), ctx);
    assert(
      ROUTES.find((r) => r.name === later)!.decide(facts, ctx),
      `${later} would also claim it`,
    );
  });
}

Deno.test("route order: known-sender and campaign can never claim the same message", () => {
  // A campaign is an unsubscribe link or a mailing platform's envelope, and either one
  // removes the protection known-sender needs, before any relationship is consulted.
  const ctx: DecisionContext = {
    policy: parsePolicy({}),
    relationships,
    thresholds: mergeThresholds(),
    now: NOW,
  };
  const campaign = ROUTES.find((r) => r.name === "campaign")!;
  const known = ROUTES.find((r) => r.name === "known-sender")!;
  const envelopes: Partial<Envelope>[] = [
    { listUnsubscribe: "<mailto:u@strong.test>" },
    { returnPath: "<bounce-1=friend=strong.test@platform.test>" },
  ];
  for (const from of [STRONG, KNOWN]) {
    for (const headers of envelopes) {
      const { msg, answers } = shaped({
        from,
        headers,
        nouls: {
          is_personal: 0.1,
          is_a_record: 0.1,
          is_perishable: 0.95,
          needs_personal_response: 0.1,
        },
      });
      const f = factsOf(inputOf(msg, answers), ctx);
      assert(f.campaign, `${from} ${JSON.stringify(headers)} is a campaign`);
      assertEquals(f.protection, null, "a campaign is never protected");
      assert(campaign.decide(f, ctx), "campaign claims it");
      assertEquals(known.decide(f, ctx), undefined, "known-sender cannot");
    }
  }
});
