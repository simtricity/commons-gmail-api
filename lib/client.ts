/**
 * `GmailClient` — typed reads against the Gmail REST API with transparent token refresh.
 *
 * Every method here is a GET. Write capability would need a wider scope at login AND
 * new methods; neither exists in this package by design.
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
}

/** Read-only Gmail REST client. Refreshes access tokens on demand and retries once on 401. */
export class GmailClient {
  /** Mailbox this client acts as; `undefined` means the store's default account. */
  readonly account?: string;
  private cred: OAuthCredential | null = null;
  private readonly log: (line: string) => void;

  /** Construct without touching the store; credentials load lazily on first call. */
  constructor(private readonly opts: GmailClientOptions) {
    this.account = opts.account;
    this.log = opts.log ?? (() => {});
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

  /** Authenticated GET against the Gmail API; on 401 refreshes once and retries, then throws `GmailApiError`. */
  private async get<T>(path: string, retry = true): Promise<T> {
    const token = await this.accessToken();
    const res = await fetch(`${API_BASE}${path}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.status === 401 && retry) {
      await res.body?.cancel();
      await this.accessToken(true);
      return this.get<T>(path, false);
    }
    if (!res.ok) {
      throw new GmailApiError(
        res.status,
        path,
        await res.text().catch(() => ""),
      );
    }
    return await res.json() as T;
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
