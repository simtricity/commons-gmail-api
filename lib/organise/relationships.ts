/**
 * How well you know a sender, read from the sent-mail corpus.
 *
 * Mail you have written to someone is the one signal in a mailbox a stranger
 * cannot fake. It is used two ways: knowing a sender makes their mail harder to
 * delete, and a sustained relationship makes their mail important.
 *
 * Pure. Build once per run from a corpus already on disk.
 *
 * @module
 */

import type { Corpus } from "./types.ts";

/**
 * - `strong`: genuine correspondence sustained over time.
 * - `known`: you have genuinely written to this address at least once.
 * - `none`: never.
 */
export type Strength = "strong" | "known" | "none";

export interface RelationshipOptions {
  /** Genuine messages sent before a relationship counts as strong. */
  strongMinGenuine?: number;
  /** Days between first and last genuine contact before it counts as strong. */
  strongMinSpanDays?: number;
  /** A domain inherits trust once you have sent it this many genuine messages… */
  domainMinSent?: number;
  /** …across at least this many distinct people. */
  domainMinContacts?: number;
}

export const RELATIONSHIP_DEFAULTS: Required<RelationshipOptions> = {
  strongMinGenuine: 5,
  strongMinSpanDays: 30,
  domainMinSent: 10,
  domainMinContacts: 2,
};

/**
 * Public mailbox providers. Thousands of unrelated people share each one, so
 * having written to some of them says nothing about the next: a spammer on the
 * same webmail as your friends inherits nothing.
 */
const SHARED_PROVIDER =
  /^(gmail|googlemail|yahoo|ymail|rocketmail|hotmail|outlook|live|msn|icloud|me|mac|aol|gmx|mail|protonmail|proton|pm|zoho|yandex|btinternet|btopenworld|talktalk|tiscali|virginmedia|ntlworld|blueyonder|sky|fastmail)\.[a-z.]+$/i;

export function isSharedProvider(domain: string): boolean {
  return SHARED_PROVIDER.test(domain);
}

interface Person {
  genuine: number;
  spanDays: number;
}

export class Relationships {
  readonly #people = new Map<string, Person>();
  readonly #domains = new Map<string, { contacts: number; sent: number }>();
  readonly #selfDomains: Set<string>;
  readonly #opts: Required<RelationshipOptions>;

  constructor(
    corpus: Pick<Corpus, "correspondents" | "selfAddresses">,
    opts: RelationshipOptions = {},
  ) {
    this.#opts = { ...RELATIONSHIP_DEFAULTS, ...opts };
    this.#selfDomains = new Set(
      (corpus.selfAddresses ?? []).map((a) => a.split("@").pop()!.toLowerCase()),
    );
    for (const c of corpus.correspondents) {
      // A mailing list is an audience, not a relationship.
      if (c.kind === "list") continue;
      const span = (Date.parse(c.lastSeen) - Date.parse(c.firstSeen)) / 86_400_000;
      this.#people.set(c.address.toLowerCase(), {
        genuine: c.genuine,
        spanDays: Number.isFinite(span) ? span : 0,
      });
      const d = this.#domains.get(c.domain) ?? { contacts: 0, sent: 0 };
      d.contacts++;
      d.sent += c.genuine;
      this.#domains.set(c.domain, d);
    }
  }

  strength(address: string): Strength {
    const p = this.#people.get(address.toLowerCase());
    if (!p) return "none";
    return p.genuine >= this.#opts.strongMinGenuine && p.spanDays >= this.#opts.strongMinSpanDays
      ? "strong"
      : "known";
  }

  /** Enough genuine correspondence with an organisation that its colleagues inherit trust. */
  trustedDomain(domain: string): boolean {
    if (isSharedProvider(domain)) return false;
    const d = this.#domains.get(domain.toLowerCase());
    return Boolean(d) && d!.sent >= this.#opts.domainMinSent &&
      d!.contacts >= this.#opts.domainMinContacts;
  }

  /** One of the operator's own domains. Mail "from" it is usually relayed, not written. */
  isSelfDomain(domain: string): boolean {
    return this.#selfDomains.has(domain.toLowerCase());
  }
}
