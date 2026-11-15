import { assertEquals, assertThrows } from "@std/assert";
import {
  ageBar,
  decide,
  type DecisionContext,
  type DecisionInput,
  DEFAULT_THRESHOLDS,
  mergeThresholds,
} from "../../lib/organise/triage/decide.ts";
import { type Envelope, envelopeOf } from "../../lib/organise/envelope.ts";
import { parsePolicy } from "../../lib/organise/policy.ts";
import { Relationships } from "../../lib/organise/relationships.ts";
import type { Answer } from "../../lib/organise/types.ts";

const NOW = Date.UTC(2026, 8, 1);
const YEAR = 365.25 * 86_400_000;

/** Nouls by name, plus Choices written as `{ relevance: "directly_relevant" }`. */
function answers(nouls: Record<string, number>, choices: Record<string, string> = {}) {
  const out: Record<string, Answer> = {};
  for (const [q, noul] of Object.entries(nouls)) out[q] = { type: "noul", noul };
  for (const [q, choice] of Object.entries(choices)) {
    out[q] = { type: "choice", choice, confidence: 0.9 };
  }
  return out;
}

/** A message nothing claims: personal-ish, not perishable, not bulk. */
const NEUTRAL = {
  is_personal: 0.5,
  is_a_record: 0.5,
  is_perishable: 0.3,
  needs_personal_response: 0.1,
  bulk_automated: 0.3,
  record_lives_elsewhere: 0.2,
};

function msg(
  over: Partial<DecisionInput> & {
    nouls?: Record<string, number>;
    choices?: Record<string, string>;
    env?: Partial<Envelope>;
  } = {},
): DecisionInput {
  const { nouls, choices, env, ...rest } = over;
  const from = rest.from ?? "Vendor <info@vendor.test>";
  return {
    id: "m1",
    from,
    subject: "Hello",
    internalDate: String(NOW - 6 * YEAR),
    envelope: { ...envelopeOf(() => undefined), from, ...env },
    answers: answers({ ...NEUTRAL, ...nouls }, choices),
    ...rest,
  };
}

const ctx: DecisionContext = {
  policy: parsePolicy({
    delete: { "digest@social.test": "social digests" },
    keep: { "exports@data.test": "site data" },
  }),
  relationships: new Relationships({
    selfAddresses: ["me@home.test"],
    correspondents: [
      {
        address: "jo@partner.test",
        domain: "partner.test",
        kind: "person",
        genuine: 40,
        incidental: 0,
        firstSeen: "2015-01-01T00:00:00Z",
        lastSeen: "2024-01-01T00:00:00Z",
      },
    ],
  }),
  thresholds: DEFAULT_THRESHOLDS,
  now: NOW,
};

const verdictOf = (m: DecisionInput) => {
  const d = decide(m, ctx);
  return `${d.route}:${d.verdict}`;
};

const PERISHABLE = { is_personal: 0.05, is_a_record: 0.05, is_perishable: 0.95 };

// ── precedence ───────────────────────────────────────────────────────────────

Deno.test("a sender ruling outranks everything, even a record", () => {
  assertEquals(
    verdictOf(msg({ from: "digest@social.test", nouls: { is_a_record: 0.99 } })),
    "policy:delete",
  );
  assertEquals(verdictOf(msg({ from: "exports@data.test", nouls: PERISHABLE })), "policy:keep");
});

Deno.test("an auto-reply goes even from someone you know well", () => {
  assertEquals(
    verdictOf(msg({ from: "Jo <jo@partner.test>", subject: "Automatic reply: Lunch?" })),
    "auto-reply:delete",
  );
});

Deno.test("a calendar reply goes whoever sends it", () => {
  assertEquals(
    verdictOf(msg({ from: "jo@partner.test", subject: "Accepted: Site walk" })),
    "calendar:delete",
  );
});

Deno.test("missing core answers never delete", () => {
  const m = msg();
  delete m.answers.is_perishable;
  assertEquals(verdictOf(m), "incomplete:keep");
});

// ── known senders ────────────────────────────────────────────────────────────

Deno.test("a known sender is kept unless emphatically perishable", () => {
  assertEquals(verdictOf(msg({ from: "Jo <jo@partner.test>" })), "known-sender:keep");
  assertEquals(
    verdictOf(
      msg({
        from: "Jo <jo@partner.test>",
        nouls: { ...PERISHABLE, needs_personal_response: 0.05 },
      }),
    ),
    "known-sender:delete",
  );
});

Deno.test("a colleague at a trusted domain inherits nothing without enough history", () => {
  // One correspondent at partner.test is below the domain's contact threshold.
  assertEquals(decide(msg({ from: "new@partner.test" }), ctx).protected, null);
});

Deno.test("a machine address forfeits the protection its domain would give", () => {
  assertEquals(decide(msg({ from: "Jo <jo@partner.test>" }), ctx).protected, "address");
  const campaign = msg({
    from: "Jo <jo@partner.test>",
    env: { listUnsubscribe: "<mailto:u@x.test>" },
  });
  assertEquals(decide(campaign, ctx).protected, null);
  assertEquals(decide(msg({ from: "me@home.test" }), ctx).protected, null);
});

// ── judgement routes ─────────────────────────────────────────────────────────

Deno.test("impersonal, not a record and perishable is deleted", () => {
  assertEquals(verdictOf(msg({ nouls: PERISHABLE })), "perishable:delete");
});

Deno.test("bulk that asks nothing and records nothing is deleted", () => {
  assertEquals(
    verdictOf(
      msg({ nouls: { bulk_automated: 0.95, is_a_record: 0.1, needs_personal_response: 0.05 } }),
    ),
    "bulk:delete",
  );
});

Deno.test("a discussion list you can post into is deferred", () => {
  assertEquals(
    verdictOf(msg({ nouls: { is_personal: 0.2 }, env: { listPost: "<mailto:list@lists.test>" } })),
    "list:defer",
  );
});

Deno.test("operational machine mail whose record lives elsewhere is deferred", () => {
  const ops = { bulk_automated: 0.88, record_lives_elsewhere: 0.8, is_a_record: 0.4 };
  assertEquals(verdictOf(msg({ nouls: { ...ops, concerns_my_operations: 0.9 } })), "ops:defer");
  // The unstable relevance Choice no longer decides anything.
  assertEquals(
    verdictOf(
      msg({
        nouls: { ...ops, concerns_my_operations: 0.2 },
        choices: { relevance: "directly_relevant" },
      }),
    ),
    "none:keep",
  );
});

Deno.test("a known vendor's monitoring is deferred, not kept by the known-sender route", () => {
  const usage = {
    is_personal: 0.55,
    is_a_record: 0.68,
    needs_personal_response: 0.25,
    bulk_automated: 0.97,
    record_lives_elsewhere: 0.9,
    concerns_my_operations: 0.85,
  };
  assertEquals(
    verdictOf(msg({ from: "Jo <jo@partner.test>", nouls: usage })),
    "known-sender:defer",
  );
});

Deno.test("an unknown sender's notifications still meet the delete routes before ops", () => {
  const social = {
    is_personal: 0.1,
    is_a_record: 0.1,
    needs_personal_response: 0.05,
    bulk_automated: 0.97,
    record_lives_elsewhere: 0.9,
    concerns_my_operations: 0.85,
  };
  assertEquals(verdictOf(msg({ from: "notify@social.test", nouls: social })), "bulk:delete");
});

// ── important ────────────────────────────────────────────────────────────────

Deno.test("a durable record is important, even when it looks perishable", () => {
  assertEquals(
    verdictOf(msg({ nouls: { ...PERISHABLE, is_a_record: 0.92, record_lives_elsewhere: 0.1 } })),
    "important-record:important",
  );
});

Deno.test("a machine-sent record is kept, not important: a receipt is routine", () => {
  const receipt = msg({
    nouls: { is_a_record: 0.95, record_lives_elsewhere: 0.1, bulk_automated: 0.97 },
  });
  assertEquals(decide(receipt, ctx).verdict, "keep");
  const data = msg({ nouls: { carries_private_data: 0.9, bulk_automated: 0.95 } });
  assertEquals(decide(data, ctx).verdict, "keep");
});

Deno.test("word of a record held elsewhere is not itself important", () => {
  assertEquals(
    decide(msg({ nouls: { is_a_record: 0.92, record_lives_elsewhere: 0.8 } }), ctx).verdict,
    "keep",
  );
});

Deno.test("private operational data is important, unless it arrives as a campaign", () => {
  const data = { carries_private_data: 0.9 };
  assertEquals(verdictOf(msg({ nouls: data })), "important-data:important");
  assertEquals(
    decide(msg({ nouls: data, env: { listUnsubscribe: "<mailto:u@x.test>" } }), ctx).route,
    "none",
  );
});

Deno.test("a sustained relationship writing personally is important; a passing one is not", () => {
  assertEquals(
    verdictOf(msg({ from: "Jo <jo@partner.test>", nouls: { is_personal: 0.85 } })),
    "important-relationship:important",
  );
  assertEquals(
    verdictOf(msg({ from: "Jo <jo@partner.test>", nouls: { is_personal: 0.4 } })),
    "known-sender:keep",
  );
});

Deno.test("a strong relationship's working email is important even when it reads as impersonal", () => {
  const cc = { is_personal: 0.06, bulk_automated: 0.07, is_a_record: 0.36 };
  assertEquals(
    verdictOf(msg({ from: "Jo <jo@partner.test>", nouls: cc })),
    "important-relationship:important",
  );
  // A strong relationship's machine mail is not.
  assertEquals(
    verdictOf(msg({ from: "Jo <jo@partner.test>", nouls: { ...cc, bulk_automated: 0.6 } })),
    "known-sender:keep",
  );
});

Deno.test("the author behind a group rewrite is the one judged", () => {
  const post = msg({
    from: "'Jo' via Team <team@home.test>",
    env: { originalSender: "jo@partner.test" },
    nouls: { is_personal: 0.85 },
  });
  const d = decide(post, ctx);
  assertEquals([d.sender, d.verdict], ["jo@partner.test", "important"]);
});

// ── lists, campaigns and strangers ───────────────────────────────────────────

Deno.test("a LISTSERV list is a discussion list, deferred ahead of the delete routes", () => {
  assertEquals(
    verdictOf(msg({
      nouls: { ...PERISHABLE, bulk_automated: 0.95 },
      env: {
        returnPath: "<owner-stds-wg@listserv.lists.test>",
        listUnsubscribe: "<mailto:u@lists.test>",
      },
    })),
    "list:defer",
  );
});

Deno.test("your own relaying group is not a discussion list", () => {
  const own = msg({
    nouls: { is_personal: 0.2 },
    env: { listPost: "<mailto:team@home.test>", returnPath: "<team+bnc@home.test>" },
  });
  assertEquals(decide(own, ctx).route === "list", false);
});

Deno.test("a signed mass mailing goes even when it reads as a little personal", () => {
  assertEquals(
    verdictOf(msg({
      from: "Sam Partner <sam@lawfirm.test>",
      nouls: { is_personal: 0.3, is_a_record: 0.1, needs_personal_response: 0.05 },
      env: { returnPath: "<782-4823-me=home.test@bounce.platform.test>" },
    })),
    "campaign:delete",
  );
});

Deno.test("emphatically perishable machine mail goes despite a middling record score", () => {
  const cart = {
    bulk_automated: 0.97,
    is_perishable: 0.92,
    is_a_record: 0.44,
    is_personal: 0.38,
    needs_personal_response: 0.1,
  };
  assertEquals(
    verdictOf(msg({ from: "donotreply@shop.test", nouls: cart })),
    "perishable-machine:delete",
  );
  // A known sender's machine mail is judged by the known-sender route instead.
  assertEquals(
    decide(msg({ from: "Jo <jo@partner.test>", nouls: cart }), ctx).route,
    "known-sender",
  );
  // A receipt is a record, whatever its perishability.
  assertEquals(
    decide(msg({ from: "donotreply@shop.test", nouls: { ...cart, is_a_record: 0.9 } }), ctx)
      .verdict,
    "keep",
  );
});

Deno.test("cold outreach dressed as personal goes when it has nothing to do with your operations", () => {
  const pitch = {
    is_personal: 0.89,
    needs_personal_response: 0.46,
    is_a_record: 0.11,
    concerns_my_operations: 0.09,
  };
  assertEquals(verdictOf(msg({ from: "recruiter@agency.test", nouls: pitch })), "stranger:delete");
  // A stranger's genuine enquiry about your business stays.
  assertEquals(
    decide(
      msg({ from: "new.customer@firm.test", nouls: { ...pitch, concerns_my_operations: 0.8 } }),
      ctx,
    ).verdict,
    "keep",
  );
});

Deno.test("a stranger with nothing personal or operational goes", () => {
  const cold = {
    is_personal: 0.1,
    is_a_record: 0.05,
    needs_personal_response: 0.1,
    concerns_my_operations: 0.05,
  };
  assertEquals(verdictOf(msg({ from: "seo@webmail.test", nouls: cold })), "stranger:delete");
  // Unanswered, the operations question never deletes.
  const unasked = msg({ from: "seo@webmail.test", nouls: { is_personal: 0.1, is_a_record: 0.05 } });
  assertEquals(decide(unasked, ctx).route, "none");
});

Deno.test("a shared mailbox such as updates@ keeps the protection its address earned", () => {
  const rel = new Relationships({
    correspondents: [{
      address: "updates@partner.test",
      domain: "partner.test",
      kind: "person",
      genuine: 3,
      incidental: 0,
      firstSeen: "2020-01-01T00:00:00Z",
      lastSeen: "2020-02-01T00:00:00Z",
    }],
  });
  assertEquals(
    decide(msg({ from: "updates@partner.test" }), { ...ctx, relationships: rel }).protected,
    "address",
  );
  assertEquals(
    decide(msg({ from: "no-reply@partner.test" }), { ...ctx, relationships: rel }).protected,
    null,
  );
});

Deno.test("the elsewhere bar loosens with age", () => {
  const notice = (ageYears: number) =>
    msg({ nouls: { record_lives_elsewhere: 0.91 }, internalDate: String(NOW - ageYears * YEAR) });
  assertEquals(verdictOf(notice(1)), "none:keep");
  assertEquals(verdictOf(notice(6)), "elsewhere:delete");
});

Deno.test("a near-certain record is never deleted because its original lives elsewhere", () => {
  const signed = { record_lives_elsewhere: 0.93, is_a_record: 0.92, bulk_automated: 0.9 };
  assertEquals(decide(msg({ from: "noreply@esign.test", nouls: signed }), ctx).verdict, "keep");
  assertEquals(
    verdictOf(msg({ from: "noreply@esign.test", nouls: { ...signed, is_a_record: 0.5 } })),
    "elsewhere:delete",
  );
});

Deno.test("the residue is kept, with what held it back", () => {
  const d = decide(msg(), ctx);
  assertEquals(d.verdict, "keep");
  assertEquals(d.why, "record 0.50, personal 0.50, perishable 0.30");
});

// ── thresholds ───────────────────────────────────────────────────────────────

Deno.test("an override moves one number and leaves its group's others alone", () => {
  const t = mergeThresholds({ bulk: { bulkAtLeast: 0.8 } });
  assertEquals(t.bulk.bulkAtLeast, 0.8);
  assertEquals(t.bulk.recordUnder, DEFAULT_THRESHOLDS.bulk.recordUnder);
  assertEquals(DEFAULT_THRESHOLDS.bulk.bulkAtLeast, 0.9);
});

Deno.test("an unknown threshold group is a config error", () => {
  // deno-lint-ignore no-explicit-any
  assertThrows(() => mergeThresholds({ bulkk: {} } as any));
});

Deno.test("ageBar picks the first step the age falls under", () => {
  const steps = DEFAULT_THRESHOLDS.elsewhere.byAge;
  assertEquals(ageBar(steps, 1), 0.95);
  assertEquals(ageBar(steps, 7), 0.9);
  assertEquals(ageBar(steps, 40), 0.88);
  // fallback: no open-ended last step holds the oldest mail to the strictest bar.
  assertEquals(ageBar([{ underYears: 2, bar: 0.9 }, { underYears: 5, bar: 0.95 }], 9), 0.95);
});
