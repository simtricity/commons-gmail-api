/**
 * `GmailClient` — typed reads against the Gmail REST API with transparent token refresh.
 *
 * Every typed method here is a GET. Writes live on `GmailWriter` (`./writes.ts`), which needs a
 * wider grant at login (`SCOPES_WRITE`) and is a separate import by design.
 * @module
 */

import { isAccessTokenStale, refreshAccessToken, revokeToken } from "./auth.ts";
import { GmailApiError, NotSignedInError, OAuthError } from "./errors.ts";
import { decodeBase64Url, listAttachments } from "./mime.ts";
import type {
  AttachmentRef,
  ClientSecret,
  Label,
  Message,
  MessageFormat,
  MessageListResponse,
  OAuthCredential,
  Profile,
  Thread,
  TokenStore,
} from "./types.ts";

const API_BASE = "https://gmail.googleapis.com/gmail/v1/users/me";

/** Options for constructing a `GmailClient`. */
export interface GmailClientOptions {
  /** The OAuth client used to refresh access tokens. */
  clientSecret: ClientSecret;
  /** Where the refresh token and cached access token live. */
  store: TokenStore;
  /** Mailbox to act as. Omitted → the store's default. */
  account?: string;
  /** Diagnostics (token refreshes etc). Default: silent. */
  log?: (line: string) => void;
  /** Transport override for tests. Default: global `fetch`. */
  fetch?: typeof globalThis.fetch;
}

/** Read-only Gmail REST client. Refreshes access tokens on demand and retries once on 401. */
export class GmailClient {
  /** Mailbox this client acts as; `undefined` means the store's default account. */
  readonly account?: string;
  private cred: OAuthCredential | null = null;
  private readonly log: (line: string) => void;
  private readonly fetchImpl: typeof globalThis.fetch;

  /** Construct without touching the store; credentials load lazily on first call. */
  constructor(private readonly opts: GmailClientOptions) {
    this.account = opts.account;
    this.log = opts.log ?? (() => {});
    this.fetchImpl = opts.fetch ?? globalThis.fetch;
  }

  /** Load the credential now so a missing login fails before any work starts. */
  static async fromStore(opts: GmailClientOptions): Promise<GmailClient> {
    const client = new GmailClient(opts);
    await client.credential();
    return client;
  }

  /** The signed-in mailbox address. */
  async email(): Promise<string> {
    return (await this.credential()).email;
  }

  /** Scopes Google actually granted to this credential (a user can untick scopes at consent). */
  async grantedScopes(): Promise<string[]> {
    return (await this.credential()).scope.split(/\s+/).filter(Boolean);
  }

  /** Load the credential from the store once and cache it; throws `NotSignedInError` if absent. */
  private async credential(): Promise<OAuthCredential> {
    if (this.cred) return this.cred;
    const loaded = await this.opts.store.load(this.account);
    if (!loaded) {
      throw new NotSignedInError(
        this.account ? `Not signed in as ${this.account}. Run login.` : "Not signed in. Run login.",
      );
    }
    this.cred = loaded;
    return loaded;
  }

  /** Return a fresh access token, refreshing via the OAuth client when stale or when `force` is set. */
  private async accessToken(force = false): Promise<string> {
    let cred = await this.credential();
    if (force || isAccessTokenStale(cred)) {
      this.log(`refreshing access token for ${cred.email}`);
      try {
        cred = await refreshAccessToken(this.opts.clientSecret, cred);
      } catch (e) {
        if (e instanceof OAuthError) {
          // Rejected upstream (revoked, secret rotated): the stored value is worthless.
          await this.opts.store.delete(cred.email);
          this.cred = null;
          throw new NotSignedInError(`${e.message} Run login.`);
        }
        throw e;
      }
      this.cred = cred;
      await this.opts.store.save(cred);
    }
    return cred.accessToken;
  }

  /**
   * Low-level authenticated request. On 401 refreshes the token once and retries; any other
   * non-2xx throws `GmailApiError`. A 204 resolves to `undefined`. Prefer the typed methods;
   * this exists for `GmailWriter` and for endpoints not yet wrapped.
   * @param method HTTP method.
   * @param path Path under `users/me`, e.g. `/labels`.
   * @param body JSON body for POST/PUT/PATCH.
   */
  async request<T>(
    method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
    path: string,
    body?: unknown,
  ): Promise<T> {
    return await this.send<T>(method, path, body, true);
  }

  /** Transport with one 401 refresh-and-retry; `request()` is the public face. */
  private async send<T>(
    method: string,
    path: string,
    body: unknown,
    retry: boolean,
  ): Promise<T> {
    const token = await this.accessToken();
    const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const res = await this.fetchImpl(`${API_BASE}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (res.status === 401 && retry) {
      await res.body?.cancel();
      await this.accessToken(true);
      return this.send<T>(method, path, body, false);
    }
    if (!res.ok) {
      throw new GmailApiError(res.status, path, await res.text().catch(() => ""));
    }
    if (res.status === 204) {
      await res.body?.cancel();
      return undefined as T;
    }
    return await res.json() as T;
  }

  /** Authenticated GET; see {@link request}. */
  private get<T>(path: string): Promise<T> {
    return this.request<T>("GET", path);
  }

  /** Revoke the grant at Google and delete it from the store. Delete is unconditional. */
  async logout(): Promise<{ revoked: boolean }> {
    const cred = await this.credential();
    let revoked = false;
    try {
      revoked = await revokeToken(cred.refreshToken);
    } finally {
      await this.opts.store.delete(cred.email);
      this.cred = null;
    }
    return { revoked };
  }

  // ── Reads ──────────────────────────────────────────────────────────────────

  /** The signed-in mailbox's profile: address and message/thread counts. */
  profile(): Promise<Profile> {
    return this.get<Profile>("/profile");
  }

  /** All labels visible to the mailbox. */
  listLabels(): Promise<Label[]> {
    return this.get<{ labels?: Label[] }>("/labels").then((r) => r.labels ?? []);
  }

  /**
   * Metadata-only search. `q` is Gmail search syntax. Returns ids; call
   * {@link getMessage} for detail. Caller is responsible for bounding `q` by date.
   */
  listMessages(
    q: string,
    opts: {
      maxResults?: number;
      pageToken?: string;
      includeSpamTrash?: boolean;
    } = {},
  ): Promise<MessageListResponse> {
    const params = new URLSearchParams({ q });
    if (opts.maxResults) params.set("maxResults", String(opts.maxResults));
    if (opts.pageToken) params.set("pageToken", opts.pageToken);
    if (opts.includeSpamTrash) params.set("includeSpamTrash", "true");
    return this.get<MessageListResponse>(`/messages?${params}`);
  }

  /** Fetch one message. `format` follows Gmail's `users.messages.get` semantics. */
  getMessage(id: string, format: MessageFormat = "full"): Promise<Message> {
    return this.get<Message>(
      `/messages/${encodeURIComponent(id)}?format=${format}`,
    );
  }

  /** Fetch one thread with all its messages. `format` follows Gmail's `users.threads.get` semantics. */
  getThread(id: string, format: MessageFormat = "full"): Promise<Thread> {
    return this.get<Thread>(
      `/threads/${encodeURIComponent(id)}?format=${format}`,
    );
  }

  /** Attachments in one message. Ids are ephemeral: fetch, use, discard. */
  async listMessageAttachments(messageId: string): Promise<AttachmentRef[]> {
    return listAttachments(await this.getMessage(messageId));
  }

  /** Attachments across every message in a thread, in message order. */
  async listThreadAttachments(threadId: string): Promise<AttachmentRef[]> {
    const thread = await this.getThread(threadId);
    return (thread.messages ?? []).flatMap(listAttachments);
  }

  /** Raw bytes of one attachment. */
  async getAttachment(
    messageId: string,
    attachmentId: string,
  ): Promise<Uint8Array> {
    const res = await this.get<{ data: string; size: number }>(
      `/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}`,
    );
    return decodeBase64Url(res.data);
  }
}
