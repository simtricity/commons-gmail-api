/**
 * Recipients for replies: splitting address headers, recognising the account holder's own
 * addresses, and computing reply-all as Gmail does. Pure; no client, no network.
 *
 * @module
 */

/**
 * Split an address-list header into its entries as written, so display names survive:
 * `"Doe, Jo" <jo@x.test>, b@y.test` → `['"Doe, Jo" <jo@x.test>', 'b@y.test']`. Commas inside
 * quotes, angle brackets or comments do not split.
 */
export function splitAddresses(value: string | undefined): string[] {
  if (!value) return [];
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  let angle = 0;
  let comment = 0;
  for (let i = 0; i < value.length; i++) {
    const c = value[i];
    if (quoted) {
      cur += c;
      if (c === "\\" && i + 1 < value.length) cur += value[++i];
      else if (c === '"') quoted = false;
      continue;
    }
    if (c === '"') quoted = true;
    else if (c === "<") angle++;
    else if (c === ">") angle = Math.max(0, angle - 1);
    else if (c === "(") comment++;
    else if (c === ")") comment = Math.max(0, comment - 1);
    else if (c === "," && !angle && !comment) {
      if (cur.trim()) out.push(cur.trim());
      cur = "";
      continue;
    }
    cur += c;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/**
 * The bare address of one entry, lower-cased: the angle-bracket address when there is one (so a
 * display name that happens to contain an address is ignored), else the first bare address.
 */
export function bareAddress(entry: string): string {
  const angled = entry.match(/<\s*([^<>\s]+@[^<>\s]+)\s*>/);
  if (angled) return angled[1].trim().toLowerCase();
  const bare = entry.match(/[\w.!#$%&'*+/=?^`{|}~-]+@[\w-]+(?:\.[\w-]+)+/);
  return bare ? bare[0].toLowerCase() : entry.trim().toLowerCase();
}

/** Entries in order, dropping any whose bare address is in `drop` or already seen. */
function distinct(entries: string[], drop: Set<string>): string[] {
  const seen = new Set(drop);
  const out: string[] = [];
  for (const e of entries) {
    const a = bareAddress(e);
    if (!a || seen.has(a)) continue;
    seen.add(a);
    out.push(e);
  }
  return out;
}

/** The original's address headers, as written. */
export interface ReplyHeaders {
  /** `From`. */
  from?: string;
  /** `Reply-To`. */
  replyTo?: string;
  /** `To`. */
  to?: string;
  /** `Cc`. */
  cc?: string;
}

/**
 * Where a reply to your own message goes: its To without you, or, when it went only to you (a
 * note to yourself, a send-as alias), its To as written. Gmail does the same.
 */
function ownTo(h: ReplyHeaders, self: Set<string>): string[] {
  const others = distinct(splitAddresses(h.to), self);
  return others.length ? others : distinct(splitAddresses(h.to), new Set());
}

/**
 * Plain-reply recipients, as Gmail chooses them: the original's Reply-To, else its From; but when
 * the original is your own message, its To (without you, unless it went only to you).
 */
export function replyRecipients(h: ReplyHeaders, self: Set<string>): string[] {
  return self.has(bareAddress(h.from ?? ""))
    ? ownTo(h, self)
    : distinct(splitAddresses(h.replyTo || h.from), new Set());
}

/**
 * Reply-all recipients for an original, given the account holder's own addresses (bare,
 * lower-cased). From someone else: `to` is the Reply-To, else From; `cc` is the original's To
 * and Cc. From yourself: `to` is the original's To and `cc` its Cc. Self is removed (except from
 * `to` when the original went only to you, which then keeps its To as written), `cc` never
 * repeats `to`, and Bcc is never computed.
 */
export function replyAllRecipients(
  h: ReplyHeaders,
  self: Set<string>,
): { to: string[]; cc: string[] } {
  const fromSelf = self.has(bareAddress(h.from ?? ""));
  if (fromSelf) {
    const to = ownTo(h, self);
    const cc = distinct(splitAddresses(h.cc), new Set([...self, ...to.map(bareAddress)]));
    return { to, cc };
  }
  const to = distinct(splitAddresses(h.replyTo || h.from), new Set());
  const cc = distinct(
    [...splitAddresses(h.to), ...splitAddresses(h.cc)],
    new Set([...self, ...to.map(bareAddress)]),
  );
  return { to, cc };
}

/** `extra` appended to `base`, skipping addresses `base` (or `skip`) already holds. */
export function addRecipients(base: string[], extra: string[], skip: string[] = []): string[] {
  return [...base, ...distinct(extra, new Set([...base, ...skip].map(bareAddress)))];
}
