/**
 * Offline stand-ins for Gmail and the decision model.
 *
 * `FakeMailbox` sits behind a real `GmailClient` through its injected `fetch`,
 * so the organiser is exercised through the same client it uses in production.
 * It understands only the search operators the organiser is expected to use,
 * and throws on anything else so a change of query is noticed.
 *
 * @module
 */

import { GmailClient, type Label, MemoryTokenStore } from "./deps.ts";
import { ANSWERS, type FixtureMessage, gmailMessage, OWNER, TRIAGE_IDS } from "./fixtures.ts";

export interface Call {
  method: string;
  /** Path under `/gmail/v1/users/me`, without the query string. */
  path: string;
  /** The `q` search parameter, if any. */
  q?: string;
  body?: unknown;
}

const SYSTEM = ["INBOX", "UNREAD", "SENT", "TRASH", "SPAM", "DRAFT", "CATEGORY_UPDATES"];

const json = (o: unknown, status = 200) =>
  new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });

const QUOTA_403 = {
  error: {
    code: 403,
    message: "Quota exceeded for quota metric 'Queries' and limit 'Queries per minute per user'",
    errors: [{ reason: "rateLimitExceeded", domain: "usageLimits" }],
    status: "PERMISSION_DENIED",
  },
};

/** Gmail's search spelling of a label name: lower case, `/` and spaces as `-`. */
const searchName = (name: string) => name.toLowerCase().replace(/[\/\s]+/g, "-");

function ymd(token: string): number {
  const [y, m, d] = token.split("/").map(Number);
  return Date.UTC(y, m - 1, d);
}

export class FakeMailbox {
  readonly messages = new Map<string, FixtureMessage>();
  readonly labels = new Map<string, Label>();
  readonly calls: Call[] = [];
  /** Full reads per message id. */
  readonly reads = new Map<string, number>();
  #nextLabel = 1;

  /**
   * @param messages The mailbox.
   * @param flaky Ids whose first full read is refused with 403 `rateLimitExceeded`.
   * @param pageSize Listing page size, small so paging is exercised.
   */
  constructor(messages: FixtureMessage[], readonly flaky = new Set<string>(), readonly pageSize = 4) {
    for (const m of messages) this.messages.set(m.id, structuredClone(m));
    for (const id of SYSTEM) this.labels.set(id, { id, name: id, type: "system" });
  }

  /** A user label that exists before the organiser runs. */
  addUserLabel(name: string, onIds: string[] = []): Label {
    const label: Label = { id: `Label_${this.#nextLabel++}`, name, type: "user" };
    this.labels.set(label.id, label);
    for (const id of onIds) this.messages.get(id)!.labelIds.push(label.id);
    return label;
  }

  labelByName(name: string): Label | undefined {
    return [...this.labels.values()].find((l) => l.name === name);
  }

  /** Names of the labels a message carries. */
  labelNames(id: string): string[] {
    return this.messages.get(id)!.labelIds.map((l) => this.labels.get(l)?.name ?? l).sort();
  }

  /** Every request that was not a read. */
  writes(): Call[] {
    return this.calls.filter((c) => c.method !== "GET");
  }

  /** A client over this mailbox with the given scopes. */
  client(scope: string): GmailClient {
    const store = new MemoryTokenStore();
    store.save({
      refreshToken: "r",
      accessToken: "a",
      accessTokenExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      email: OWNER,
      scope,
      savedAt: new Date().toISOString(),
    });
    return new GmailClient({
      clientSecret: { clientId: "id", clientSecret: "s" },
      store,
      fetch: (input, init) => this.#route(String(input), init),
    });
  }

  #matches(m: FixtureMessage, q: string): boolean {
    for (const token of q.trim().split(/\s+/).filter(Boolean)) {
      if (token === "in:sent") {
        if (!m.labelIds.includes("SENT")) return false;
      } else if (token === "-in:sent") {
        if (m.labelIds.includes("SENT")) return false;
      } else if (token === "-in:chats" || token === "-in:draft") {
        // nothing here is a chat or a draft
      } else if (token.startsWith("after:")) {
        if (m.internalDate < ymd(token.slice(6))) return false;
      } else if (token.startsWith("before:")) {
        if (m.internalDate >= ymd(token.slice(7))) return false;
      } else if (token.startsWith("label:")) {
        const want = token.slice(6);
        if (!m.labelIds.some((id) => searchName(this.labels.get(id)?.name ?? "") === want)) return false;
      } else {
        throw new Error(
          `FakeMailbox: unsupported search operator ${JSON.stringify(token)} in ${JSON.stringify(q)}`,
        );
      }
    }
    // Gmail leaves trash and spam out unless asked.
    return !m.labelIds.includes("TRASH") && !m.labelIds.includes("SPAM");
  }

  async #route(url: string, init?: RequestInit): Promise<Response> {
    await Promise.resolve();
    const u = new URL(url);
    const path = u.pathname.replace("/gmail/v1/users/me", "");
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    this.calls.push({ method, path, q: u.searchParams.get("q") ?? undefined, body });

    if (method === "GET" && path === "/profile") {
      return json({
        emailAddress: OWNER,
        messagesTotal: this.messages.size,
        threadsTotal: 0,
        historyId: "1",
      });
    }
    if (method === "GET" && path === "/labels") return json({ labels: [...this.labels.values()] });
    if (method === "POST" && path === "/labels") {
      if (this.labelByName(body.name)) return json({ error: { code: 409, message: "exists" } }, 409);
      const label: Label = { id: `Label_${this.#nextLabel++}`, name: body.name, type: "user" };
      this.labels.set(label.id, label);
      return json(label);
    }
    const labelGet = path.match(/^\/labels\/([^/]+)$/);
    if (method === "GET" && labelGet) {
      const l = this.labels.get(decodeURIComponent(labelGet[1]));
      return l ? json(l) : json({ error: { code: 404 } }, 404);
    }
    if (method === "GET" && path === "/messages") {
      const q = u.searchParams.get("q") ?? "";
      const max = Number(u.searchParams.get("maxResults") ?? 100);
      const offset = Number(u.searchParams.get("pageToken") ?? 0);
      const hits = [...this.messages.values()]
        .filter((m) => this.#matches(m, q))
        .sort((a, b) => b.internalDate - a.internalDate);
      const page = hits.slice(offset, offset + Math.min(max, this.pageSize));
      const next = offset + page.length < hits.length ? String(offset + page.length) : undefined;
      return json({
        messages: page.length ? page.map((m) => ({ id: m.id, threadId: m.threadId })) : undefined,
        nextPageToken: next,
        resultSizeEstimate: hits.length,
      });
    }
    const get = path.match(/^\/messages\/([^/]+)$/);
    if (method === "GET" && get) {
      const id = decodeURIComponent(get[1]);
      const m = this.messages.get(id);
      if (!m) return json({ error: { code: 404, errors: [{ reason: "notFound" }] } }, 404);
      const format = (u.searchParams.get("format") ?? "full") as "full" | "metadata";
      if (format === "full") {
        const n = (this.reads.get(id) ?? 0) + 1;
        this.reads.set(id, n);
        if (n === 1 && this.flaky.has(id)) return json(QUOTA_403, 403);
      }
      return json(gmailMessage(m, format));
    }
    if (method === "POST" && path === "/messages/batchModify") {
      if (body.ids.length > 1000) return json({ error: { code: 400, message: "too many ids" } }, 400);
      for (const id of body.ids as string[]) {
        const m = this.messages.get(id);
        if (!m) continue;
        const remove = new Set<string>(body.removeLabelIds ?? []);
        m.labelIds = m.labelIds.filter((l) => !remove.has(l));
        for (const l of body.addLabelIds ?? []) if (!m.labelIds.includes(l)) m.labelIds.push(l);
      }
      return new Response(null, { status: 204 });
    }
    return json({ error: { code: 404, message: `FakeMailbox has no route for ${method} ${path}` } }, 404);
  }
}

export interface JevCall {
  authorization: string | null;
  model: string;
  subject: string;
  context: unknown;
  questions: string[];
}

/**
 * The decision model, answering from `ANSWERS` by subject. Triage ids get their
 * Nouls; `project` gets a Choice; any other id gets an indifferent Noul.
 */
export class FakeJev {
  readonly calls: JevCall[] = [];
  /** Respond 429 to this many requests before answering. */
  throttleNext = 0;

  readonly fetch: typeof globalThis.fetch = async (input, init) => {
    await Promise.resolve();
    if (String(input) !== "https://api.typesafe.ai/v1/systemone" || init?.method !== "POST") {
      return new Response("not found", { status: 404 });
    }
    if (this.throttleNext > 0) {
      this.throttleNext--;
      return new Response("slow down", { status: 429 });
    }
    const raw = String(init.body);
    const body = JSON.parse(raw) as {
      state: Record<string, unknown>;
      model: string;
      questions: Record<string, unknown>;
    };
    const subject = String(body.state.subject ?? "");
    this.calls.push({
      authorization: new Headers(init.headers).get("authorization"),
      model: body.model,
      subject,
      context: body.state.context,
      questions: Object.keys(body.questions).sort(),
    });
    const known = ANSWERS[subject];
    if (!known && subject !== "A short message used only to prove connectivity.") {
      return new Response(`unknown subject ${subject}`, { status: 400 });
    }
    const answers: Record<string, unknown> = {};
    for (const id of Object.keys(body.questions)) {
      if (known && (TRIAGE_IDS as readonly string[]).includes(id)) {
        answers[id] = { type: "noul", noul: known.nouls[id as (typeof TRIAGE_IDS)[number]] };
      } else if (known && id === "project") {
        answers[id] = {
          type: "choice",
          choice: known.project,
          confidence: 0.8,
          probabilities: { alpha: 0.1, beta: 0.1, none: 0.1, [known.project]: 0.8 },
        };
      } else {
        answers[id] = { type: "noul", noul: 0.5 };
      }
    }
    return new Response(
      JSON.stringify({
        model: "jev-test-1",
        answers,
        usage: { input_tokens: Math.ceil(raw.length / 4), output_tokens: 0 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };
}
