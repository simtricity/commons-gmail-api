/**
 * Building a corpus of people and organisations you have genuinely emailed.
 *
 * Your sent mail is the strongest evidence of who matters to you, and it costs
 * nothing but metadata reads. It is also the least reliable thing in the mailbox
 * if taken at face value, because a vacation auto-responder writes to everyone
 * who happened to email you, including newsletters and bounce addresses.
 *
 * So every recipient is counted twice: once for genuine correspondence, once for
 * contact that only ever happened incidentally. Callers decide which to trust.
 *
 * @module
 */

import { header } from "../mime.ts";
import type { Message } from "../types.ts";
import { addressesIn, isAutoReply, isListMail, senderOf } from "./mail.ts";
import type { Corpus, Correspondent } from "./types.ts";

/** How one sent message reached its recipients. */
export type SendKind = "genuine" | "auto-reply" | "list-post";

/**
 * Detecting a post to a mailing list, from the sent copy alone.
 *
 * `List-Id` and `List-Post` are added by the list server on delivery, so an
 * outgoing copy never carries them and header inspection cannot work. In
 * calibration on one mailbox, every sent message to a list had only the ordinary
 * `From`/`To`/`Subject`/`References` set.
 *
 * Two things do work. Gmail's own `list:<list-id>` search operator resolves list
 * membership server-side and does match sent copies, which is how the CLI learns
 * a list's posting address. Once that address is known, matching it against the
 * recipients is exact and free.
 *
 * Do **not** try to learn list addresses by harvesting `To` and `Cc` from
 * delivered list mail. A list delivery carries other individual recipients
 * alongside the list, and doing so misidentified 39 real colleagues as mailing
 * lists on a 428-correspondent corpus.
 */
export function classifySend(msg: Message, listAddresses?: ReadonlySet<string>): SendKind {
  if (isAutoReply(msg)) return "auto-reply";
  if (isListMail(msg)) return "list-post";
  if (listAddresses?.size) {
    for (const h of ["To", "Cc", "Bcc"]) {
      for (const a of addressesIn(header(msg.payload, h) ?? "")) {
        if (listAddresses.has(a)) return "list-post";
      }
    }
  }
  return "genuine";
}

interface Acc {
  genuine: number;
  incidental: number;
  first: number;
  last: number;
}

/**
 * Accumulates recipients across a stream of sent messages.
 *
 * Kept as a class so a long run can fold messages in as they arrive rather than
 * holding half a mailbox in memory.
 */
export interface CorpusOptions {
  /** Known mailing-list posting addresses. See {@link classifySend}. */
  listAddresses?: ReadonlySet<string>;
  /** The operator's own addresses, never counted as correspondents. */
  selfAddresses?: ReadonlySet<string>;
}

export class CorpusBuilder {
  #people = new Map<string, Acc>();
  #scanned = 0;
  #auto = 0;
  #list = 0;
  #opts: CorpusOptions;

  constructor(opts: CorpusOptions = {}) {
    this.#opts = opts;
  }

  add(msg: Message): SendKind {
    const kind = classifySend(msg, this.#opts.listAddresses);
    this.#scanned++;
    if (kind === "auto-reply") this.#auto++;
    if (kind === "list-post") this.#list++;

    const when = Number(msg.internalDate ?? 0);
    const recipients = new Set<string>();
    for (const h of ["To", "Cc", "Bcc"]) {
      for (const a of addressesIn(header(msg.payload, h) ?? "")) {
        // Forwarding something to yourself is not correspondence.
        if (this.#opts.selfAddresses?.has(a)) continue;
        recipients.add(a);
      }
    }

    for (const address of recipients) {
      const acc = this.#people.get(address) ??
        { genuine: 0, incidental: 0, first: when || Date.now(), last: 0 };
      if (kind === "genuine") acc.genuine++;
      else acc.incidental++;
      if (when) {
        acc.first = Math.min(acc.first || when, when);
        acc.last = Math.max(acc.last, when);
      }
      this.#people.set(address, acc);
    }
    return kind;
  }

  /** `minGenuine` drops one-off contacts; 1 keeps everyone written to once. */
  finish(query: string, minGenuine = 1): Corpus {
    const correspondents: Correspondent[] = [];
    for (const [address, acc] of this.#people) {
      const isList = this.#opts.listAddresses?.has(address) ?? false;
      // A list is never "genuine correspondence" by construction, so the
      // minimum applies to people only. Lists are kept and marked, not dropped:
      // the list itself is a real entity even though it is not a relationship.
      if (!isList && acc.genuine < minGenuine) continue;
      correspondents.push({
        address,
        domain: address.split("@").pop() ?? address,
        kind: isList ? "list" : "person",
        genuine: acc.genuine,
        incidental: acc.incidental,
        firstSeen: acc.first ? new Date(acc.first).toISOString() : "",
        lastSeen: acc.last ? new Date(acc.last).toISOString() : "",
      });
    }
    correspondents.sort((a, b) => b.genuine - a.genuine || a.address.localeCompare(b.address));
    return {
      builtAt: new Date().toISOString(),
      query,
      scanned: this.#scanned,
      autoReplies: this.#auto,
      listPosts: this.#list,
      selfAddresses: [...(this.#opts.selfAddresses ?? [])].sort(),
      correspondents,
    };
  }

  /** Recipients seen only through auto-replies or list posts. */
  incidentalOnly(): string[] {
    return [...this.#people].filter(([, a]) => a.genuine === 0).map(([address]) => address);
  }
}

/** Domains with at least one genuine exchange, and how many people at each. */
export function domainsOf(corpus: Corpus): { domain: string; people: number; messages: number }[] {
  const byDomain = new Map<string, { people: number; messages: number }>();
  for (const c of corpus.correspondents) {
    if (c.kind === "list") continue;
    const d = byDomain.get(c.domain) ?? { people: 0, messages: 0 };
    d.people++;
    d.messages += c.genuine;
    byDomain.set(c.domain, d);
  }
  return [...byDomain]
    .map(([domain, v]) => ({ domain, ...v }))
    .sort((a, b) => b.messages - a.messages || a.domain.localeCompare(b.domain));
}

/** Fast membership tests for whitelisting a classification run. */
export function lookups(corpus: Corpus): { addresses: Set<string>; domains: Set<string> } {
  const people = corpus.correspondents.filter((c) => c.kind !== "list");
  return {
    addresses: new Set(people.map((c) => c.address)),
    domains: new Set(people.map((c) => c.domain)),
  };
}

/** Mailing lists you post to, separated from the people. */
export function listsOf(corpus: Corpus): Correspondent[] {
  return corpus.correspondents.filter((c) => c.kind === "list");
}

/**
 * Which addresses this mailbox sends as.
 *
 * An operator accumulates aliases over a working life, and every one of them
 * must be kept out of the correspondent list — writing as yourself is not
 * correspondence. The addresses cannot be asked for directly: the settings API
 * that lists them needs a wider OAuth scope than a read-only tool should hold,
 * so they are inferred from who the sent mail says it is from.
 *
 * Two rules keep the inference honest:
 *
 * - Only the angle-bracket sender counts. See {@link senderOf}.
 * - An alias must have been used `minSends` times. A mailbox picks up the odd
 *   message that it did not send — a forward saved to Sent, mail imported from
 *   another provider, a message composed on someone else's machine. In
 *   calibration on one mailbox, every genuine alias appeared at least three
 *   times while every false one appeared exactly once, so a single sighting is
 *   no evidence at all.
 *
 * `profile` is the account's own address and is always included, however rarely
 * it is used.
 */
export function selfAddressesFrom(
  senders: Iterable<string>,
  opts: { profile?: string; minSends?: number } = {},
): Set<string> {
  const minSends = opts.minSends ?? 2;
  const counts = new Map<string, number>();
  for (const raw of senders) {
    const a = senderOf(raw);
    if (a) counts.set(a, (counts.get(a) ?? 0) + 1);
  }
  const self = new Set<string>();
  if (opts.profile) self.add(opts.profile.toLowerCase());
  for (const [a, n] of counts) if (n >= minSends) self.add(a);
  return self;
}
