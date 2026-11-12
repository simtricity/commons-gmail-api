/**
 * A small in-memory Gmail for the drafting tests: messages with parts and attachments, drafts,
 * send-as entries and the profile, behind a real `GmailClient`. Synthetic data only.
 */
import { GmailClient, GmailWriter, GuardedWriter, MemoryTokenStore } from "../mod.ts";
import { SCOPE_COMPOSE, SCOPE_MODIFY, SCOPE_READONLY } from "../mod.ts";
import { readRaw } from "./mime-read.ts";

export const OWNER = "owner@home.test";
export const WRITE = `${SCOPE_READONLY} ${SCOPE_MODIFY} ${SCOPE_COMPOSE}`;

const b64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const enc = (s: string) => new TextEncoder().encode(s);

/** A file on a fixture message. */
export interface FixtureFile {
  filename: string;
  mimeType: string;
  bytes: Uint8Array;
  /** Inline image (Content-ID, disposition inline). */
  inline?: boolean;
  /** Bytes in the part itself (`body.data`), as Gmail does for some small files. */
  embedded?: boolean;
  /** `body.size` to declare instead of the real length (to test limits without the bytes). */
  declaredSize?: number;
}

/** A fixture message, as Gmail's `full` format would describe it. */
export interface FixtureMessage {
  id: string;
  threadId: string;
  headers: Record<string, string>;
  text?: string;
  html?: string;
  files?: FixtureFile[];
}

type Call = { method: string; path: string; body?: unknown };

/** The fake: `messages`, `drafts` and `sendAs` are open for tests to arrange and inspect. */
export class FakeGmail {
  readonly messages = new Map<string, FixtureMessage>();
  readonly calls: Call[] = [];
  readonly drafts = new Map<
    string,
    { id: string; message: { id: string; threadId?: string; raw: string } }
  >();
  sendAs: {
    sendAsEmail: string;
    displayName?: string;
    signature?: string;
    isPrimary?: boolean;
    isDefault?: boolean;
  }[] = [
    { sendAsEmail: OWNER, isPrimary: true, isDefault: true },
  ];
  /** Attachment downloads, by attachment id; a test can make one fail. */
  readonly downloads: string[] = [];
  failDownloads = false;
  #draftSeq = 0;

  constructor(messages: FixtureMessage[] = []) {
    for (const m of messages) this.messages.set(m.id, m);
  }

  /** A real client, signed in with `scope`, talking to this fake. */
  client(scope = WRITE): GmailClient {
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
      fetch: (input, init) => Promise.resolve(this.#route(String(input), init)),
    });
  }

  /** A writer and the guard over it, as the CLI and the skill build them. */
  writers(log?: string) {
    const writer = new GmailWriter(this.client());
    const guard = new GuardedWriter(writer, log ? { log: { path: log, via: "test" } } : {});
    return { writer, guard };
  }

  /** Writes seen, excluding reads. */
  writes(): Call[] {
    return this.calls.filter((c) => c.method !== "GET");
  }

  /** A draft's message as a fixture, from the raw message it was created with. */
  #draftMessage(messageId: string): FixtureMessage | undefined {
    const d = [...this.drafts.values()].find((x) => x.message.id === messageId);
    if (!d) return undefined;
    const h = readRaw(d.message.raw).headers;
    const pick = ["subject", "to", "cc", "date", "from"].filter((k) => h[k] !== undefined);
    return {
      id: d.message.id,
      threadId: d.message.threadId ?? `t-${d.id}`,
      headers: Object.fromEntries(pick.map((k) => [k[0].toUpperCase() + k.slice(1), h[k]])),
    };
  }

  #payload(m: FixtureMessage, format: string) {
    const headers = Object.entries(m.headers).map(([name, value]) => ({ name, value }));
    if (format === "metadata") return { mimeType: "multipart/mixed", headers };
    const body: unknown[] = [];
    if (m.text !== undefined) {
      body.push({
        mimeType: "text/plain",
        headers: [],
        body: { size: m.text.length, data: b64url(enc(m.text)) },
      });
    }
    if (m.html !== undefined) {
      body.push({
        mimeType: "text/html",
        headers: [],
        body: { size: m.html.length, data: b64url(enc(m.html)) },
      });
    }
    const alt = { mimeType: "multipart/alternative", headers: [], body: { size: 0 }, parts: body };
    const files = (m.files ?? []).map((f, i) => ({
      partId: `1.${i}`,
      mimeType: f.mimeType,
      filename: f.filename,
      headers: [
        { name: "Content-Type", value: `${f.mimeType}; name="${f.filename}"` },
        {
          name: "Content-Disposition",
          value: `${f.inline ? "inline" : "attachment"}; filename="${f.filename}"`,
        },
        ...(f.inline ? [{ name: "Content-ID", value: `<img${i}@fake>` }] : []),
      ],
      body: f.embedded
        ? { size: f.bytes.length, data: b64url(f.bytes) }
        : { size: f.declaredSize ?? f.bytes.length, attachmentId: `${m.id}-att-${i}` },
    }));
    return { mimeType: "multipart/mixed", headers, body: { size: 0 }, parts: [alt, ...files] };
  }

  #route(url: string, init?: RequestInit): Response {
    const u = new URL(url);
    const path = u.pathname.replace("/gmail/v1/users/me", "");
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    this.calls.push({ method, path: path + u.search, body });
    const json = (o: unknown, status = 200) =>
      new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });

    if (path === "/profile") {
      return json({ emailAddress: OWNER, messagesTotal: 1, threadsTotal: 1 });
    }
    if (path === "/settings/sendAs") return json({ sendAs: this.sendAs });
    const att = path.match(/^\/messages\/([^/]+)\/attachments\/([^/]+)$/);
    if (att) {
      this.downloads.push(att[2]);
      if (this.failDownloads) {
        return json({ error: { code: 500, message: "download failed" } }, 500);
      }
      const m = this.messages.get(att[1]);
      const i = Number(att[2].split("-att-")[1]);
      const f = m?.files?.[i];
      return f
        ? json({ size: f.bytes.length, data: b64url(f.bytes) })
        : json({ error: { code: 404 } }, 404);
    }
    const msg = path.match(/^\/messages\/([^/]+)$/);
    if (msg && method === "GET") {
      const m = this.messages.get(decodeURIComponent(msg[1])) ?? this.#draftMessage(msg[1]);
      if (!m) return json({ error: { code: 404, message: "not found" } }, 404);
      return json({
        id: m.id,
        threadId: m.threadId,
        payload: this.#payload(m, u.searchParams.get("format") ?? "full"),
      });
    }
    if (path === "/drafts" && method === "GET") {
      const q = u.searchParams.get("q");
      const max = Number(u.searchParams.get("maxResults") ?? 100);
      const all = [...this.drafts.values()].reverse()
        .filter((d) => !q || readRaw(d.message.raw).headers["subject"]?.includes(q))
        .slice(0, max)
        .map((d) => ({ id: d.id, message: { id: d.message.id, threadId: d.message.threadId } }));
      return json(all.length ? { drafts: all } : {});
    }
    if (path === "/drafts" && method === "POST") {
      const id = `d${++this.#draftSeq}`;
      const d = {
        id,
        message: { id: `m-${id}-1`, threadId: body.message.threadId, raw: body.message.raw },
      };
      this.drafts.set(id, d);
      return json({ id, message: { id: d.message.id, threadId: d.message.threadId ?? `t-${id}` } });
    }
    return json({ error: { code: 404, message: `fake has no route for ${method} ${path}` } }, 404);
  }
}
