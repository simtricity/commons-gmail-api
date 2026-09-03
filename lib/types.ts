/**
 * Wire and domain types for the Gmail REST API subset this package covers.
 * @module
 */

/** The `installed`/`web` block of a Google Cloud Console OAuth client download. */
export interface ClientSecret {
  clientId: string;
  clientSecret: string;
}

/** One mailbox's OAuth grant as persisted by a {@link TokenStore}. */
export interface OAuthCredential {
  /** Long-lived at Google until revoked. The secret that matters. */
  refreshToken: string;
  /** ~1h. Refreshed transparently by the client. */
  accessToken: string;
  /** ISO 8601 UTC. */
  accessTokenExpiresAt: string;
  /** Mailbox address, from `users.getProfile`. Used as the store key. */
  email: string;
  /** Space-separated scopes Google actually granted. */
  scope: string;
  /** ISO 8601 UTC of the login that minted the refresh token. */
  savedAt: string;
}

/**
 * Where credentials live. The library ships {@link FileTokenStore}; callers with their
 * own policy (TTL sweeps, keychains, per-tenant keying) implement this instead.
 */
export interface TokenStore {
  /** `account` omitted → the store's default account, or null if none. */
  load(account?: string): Promise<OAuthCredential | null>;
  save(cred: OAuthCredential): Promise<void>;
  delete(account: string): Promise<void>;
  /** Mailbox addresses with a stored credential. */
  list(): Promise<string[]>;
}

// ── Gmail API wire shapes (the fields we read; the API returns more) ──────────

export interface MessagePartHeader {
  name: string;
  value: string;
}

export interface MessagePartBody {
  attachmentId?: string;
  size?: number;
  /** base64url. Present for small inline bodies, absent when `attachmentId` is set. */
  data?: string;
}

export interface MessagePart {
  partId?: string;
  mimeType?: string;
  filename?: string;
  headers?: MessagePartHeader[];
  body?: MessagePartBody;
  parts?: MessagePart[];
}

export interface Message {
  id: string;
  threadId: string;
  labelIds?: string[];
  snippet?: string;
  historyId?: string;
  /** ms since epoch as a string. */
  internalDate?: string;
  sizeEstimate?: number;
  payload?: MessagePart;
  /** Only with `format=raw`. */
  raw?: string;
}

export interface Thread {
  id: string;
  historyId?: string;
  messages?: Message[];
}

export interface MessageListResponse {
  messages?: { id: string; threadId: string }[];
  nextPageToken?: string;
  resultSizeEstimate?: number;
}

export interface Profile {
  emailAddress: string;
  messagesTotal: number;
  threadsTotal: number;
  historyId: string;
}

export interface Label {
  id: string;
  name: string;
  type?: "system" | "user";
  messagesTotal?: number;
  messagesUnread?: number;
  threadsTotal?: number;
  threadsUnread?: number;
}

export type MessageFormat = "full" | "metadata" | "minimal" | "raw";

// ── Domain shapes this package adds ──────────────────────────────────────────

/**
 * An attachment located in a message's MIME tree.
 *
 * `attachmentId` is NOT stable across `messages.get` calls — fetch, use, discard. Never
 * persist one and look it up later.
 */
export interface AttachmentRef {
  messageId: string;
  filename: string;
  attachmentId: string;
  mimeType: string;
  /** Bytes, per Gmail's `body.size`. */
  size: number;
  /** `Content-Disposition: inline` with a `Content-ID` — an embedded image, usually. */
  inline: boolean;
}

/** One file written by a fetch. */
export interface ManifestEntry {
  messageId: string;
  /** As sent, including Gmail's ` (1)` suffixes. */
  filename: string;
  /** Basename actually written; differs from `filename` only on a collision. */
  savedAs: string;
  /** Absolute path of the written file. Absent on `dryRun`. */
  path?: string;
  mimeType: string;
  bytes: number;
  /** Hex. Absent on `dryRun`. */
  sha256?: string;
}

export interface Manifest {
  /** Thread id, or the single message id for a message-scoped fetch. */
  source: { threadId?: string; messageId?: string };
  account: string;
  /** ISO 8601 UTC. */
  fetchedAt: string;
  outDir: string;
  files: ManifestEntry[];
  /** Attachments present but excluded by `include`/`inline` rules. */
  skipped: { messageId: string; filename: string; reason: string }[];
}
