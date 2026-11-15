/**
 * A small in-memory Gmail for the drafting tests: messages with parts and attachments, drafts,
 * send-as entries and the profile, behind a real `GmailClient`. Synthetic data only.
 */
import { GmailClient, GmailWriter, GuardedWriter, MemoryTokenStore } from "../mod.ts";
import { SCOPE_COMPOSE, SCOPE_MODIFY, SCOPE_READONLY } from "../mod.ts";
import { leaves, readRaw } from "./mime-read.ts";

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
    {
      id: string;
      message: { id: string; threadId?: string; raw?: string; fixture?: FixtureMessage };
    }
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

  /** Put a draft in place as a fixture: for shapes the builder cannot write (inline images). */
  seedDraft(id: string, message: FixtureMessage): void {
    this.drafts.set(id, {
      id,
      message: { id: message.id, threadId: message.threadId, fixture: message },
    });
  }

  /** Someone edits the draft in Gmail: its message id moves on, content unchanged. */
  touchDraft(id: string): void {
    const d = this.drafts.get(id)!;
    const fixture = this.#draftMessage(d.message.id)!;
    const next = `${d.message.id}-edited`;
    d.message = { id: next, threadId: d.message.threadId, fixture: { ...fixture, id: next } };
  }

  /** A draft's message as a fixture: seeded, or read back from the raw message it was written as. */
  #draftMessage(messageId: string): FixtureMessage | undefined {
    const d = [...this.drafts.values()].find((x) => x.message.id === messageId);
    if (!d) return undefined;
    if (d.message.fixture) return d.message.fixture;
    const m = readRaw(d.message.raw!);
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(m.headers)) {
      if (!k.startsWith("content-") && k !== "mime-version") headers[k] = v;
    }
    const dec = (b: Uint8Array) => new TextDecoder().decode(b);
    const out: FixtureMessage = {
      id: d.message.id,
      threadId: d.message.threadId ?? `t-${d.id}`,
      headers,
      files: [],
    };
    for (const l of leaves(m)) {
      const disp = l.headers["content-disposition"];
      if (!disp && l.type === "text/plain" && out.text === undefined) out.text = dec(l.body);
      else if (!disp && l.type === "text/html" && out.html === undefined) out.html = dec(l.body);
      else if (disp) {
        const name = /filename="([^"]+)"/.exec(disp)?.[1] ??
          decodeURIComponent(/filename\*=UTF-8''([^;]+)/.exec(disp)?.[1] ?? "file");
        out.files!.push({
          filename: name,
          mimeType: l.type,
          bytes: l.body,
          inline: disp.startsWith("inline") && !!l.headers["content-id"],
        });
      }
    }
    return out;
  }

  /** A message by id: a fixture, or a draft's message. */
  #message(id: string): FixtureMessage | undefined {
    return this.messages.get(id) ?? this.#draftMessage(id);
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
      const m = this.#message(att[1]);
      const i = Number(att[2].split("-att-").pop());
      const f = m?.files?.[i];
      return f
        ? json({ size: f.bytes.length, data: b64url(f.bytes) })
        : json({ error: { code: 404 } }, 404);
    }
    const msg = path.match(/^\/messages\/([^/]+)$/);
    if (msg && method === "GET") {
      const m = this.#message(decodeURIComponent(msg[1]));
      if (!m) return json({ error: { code: 404, message: "not found" } }, 404);
      return json({
        id: m.id,
        threadId: m.threadId,
        payload: this.#payload(m, u.searchParams.get("format") ?? "full"),
      });
    }
    const thread = path.match(/^\/threads\/([^/]+)$/);
    if (thread && method === "GET") {
      const fmt = u.searchParams.get("format") ?? "full";
      const msgs = [...this.messages.values()].filter((m) => m.threadId === thread[1]);
      return json({
        id: thread[1],
        messages: msgs.map((m) => ({
          id: m.id,
          threadId: m.threadId,
          payload: this.#payload(m, fmt),
        })),
      });
    }
    const draft = path.match(/^\/drafts\/([^/]+)$/);
    if (draft && method === "GET") {
      const d = this.drafts.get(draft[1]);
      if (!d) return json({ error: { code: 404, message: "no draft" } }, 404);
      const fmt = u.searchParams.get("format") ?? "full";
      const m = this.#draftMessage(d.message.id)!;
      return json({
        id: d.id,
        message: {
          id: m.id,
          threadId: m.threadId,
          ...(fmt === "minimal" ? {} : { payload: this.#payload(m, fmt) }),
        },
      });
    }
    if (draft && method === "PUT") {
      const d = this.drafts.get(draft[1]);
      if (!d) return json({ error: { code: 404, message: "no draft" } }, 404);
      const n = Number(/-(\d+)$/.exec(d.message.id)?.[1] ?? 1) + 1;
      d.message = {
        id: `m-${d.id}-${n}`,
        threadId: body.message.threadId ?? d.message.threadId,
        raw: body.message.raw,
      };
      return json({ id: d.id, message: { id: d.message.id, threadId: d.message.threadId } });
    }
    if (path === "/drafts" && method === "GET") {
      const q = u.searchParams.get("q");
      const max = Number(u.searchParams.get("maxResults") ?? 100);
      const all = [...this.drafts.values()].reverse()
        .filter((d) => !q || this.#draftMessage(d.message.id)!.headers["subject"]?.includes(q))
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
