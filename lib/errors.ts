/**
 * Error types. Callers branch on `instanceof`, never on message text.
 * @module
 */

/** No usable credential for the requested account. Remedy: interactive login. */
export class NotSignedInError extends Error {
  /** Error class name, stable across minification. */
  override name = "NotSignedInError";
}

/** Google returned a non-2xx from the Gmail REST API. */
export class GmailApiError extends Error {
  /** Error class name, stable across minification. */
  override name = "GmailApiError";
  /**
   * Build from a failed response; the message includes status, path and body text.
   * @param status HTTP status returned by Gmail.
   * @param path Request path.
   * @param body Response body text, if any.
   */
  constructor(
    readonly status: number,
    readonly path: string,
    readonly body: string,
  ) {
    super(`Gmail API ${status} on ${path}${body ? `: ${body}` : ""}`);
    this.reason = parseReason(body);
  }
  /**
   * Google's machine-readable reason, e.g. `rateLimitExceeded`, `insufficientPermissions`,
   * `notFound`. Quota exhaustion is a 403 with `rateLimitExceeded`, so branch on this, not status.
   */
  readonly reason?: string;
}

function parseReason(body: string): string | undefined {
  try {
    const j = JSON.parse(body) as {
      error?: { errors?: { reason?: string }[]; status?: string };
    };
    return j.error?.errors?.[0]?.reason ?? j.error?.status;
  } catch {
    return undefined;
  }
}

/** A write was attempted with a credential whose grant lacks the needed scope. Thrown before any network call. */
export class InsufficientScopeError extends Error {
  /** Error class name, stable across minification. */
  override name = "InsufficientScopeError";
  /**
   * Build with the missing scope and what was granted; the message names both and the remedy.
   * @param required The scope the operation needs.
   * @param granted Scopes the credential actually holds.
   */
  constructor(readonly required: string, readonly granted: string[]) {
    super(
      `This credential does not grant ${required.split("/").at(-1)}. Granted: ${
        granted.map((g) => g.split("/").at(-1)).join(", ") || "(none)"
      }. Run login --write.`,
    );
  }
}

/** Google's OAuth error detail, when the failure was an HTTP response from it. */
export interface OAuthErrorDetail {
  /** HTTP status. */
  status?: number;
  /** Google's OAuth `error` code, e.g. `invalid_grant`. */
  code?: string;
  /** Google's `error_description`. */
  description?: string;
}

/**
 * The OAuth dance itself failed (bind, exchange, refresh, revoke). For a refresh, this means
 * Google refused the saved sign-in outright (`invalid_grant`, `invalid_client`, any other 4xx):
 * retrying will not help, and only a new login will.
 */
export class OAuthError extends Error {
  /** Error class name, stable across minification. */
  override name = "OAuthError";
  /** HTTP status from Google, when there was one. */
  readonly status?: number;
  /** Google's OAuth `error` code, e.g. `invalid_grant`. */
  readonly code?: string;
  /** Google's `error_description`. */
  readonly description?: string;

  /**
   * Build with Google's detail.
   * @param message Human-readable reason; never carries a token or secret.
   * @param detail Google's status, error code and description, when known.
   */
  constructor(message: string, detail: OAuthErrorDetail = {}) {
    super(message);
    if (detail.status !== undefined) this.status = detail.status;
    if (detail.code !== undefined) this.code = detail.code;
    if (detail.description !== undefined) this.description = detail.description;
  }
}

/**
 * Google's token endpoint failed in a way that can pass: 429, a 5xx, or no response at all.
 * Thrown after the refresh's own retries. The saved sign-in is kept; try again later.
 */
export class TokenEndpointError extends Error {
  /** Error class name, stable across minification. */
  override name = "TokenEndpointError";
  /** HTTP status of the last attempt; absent when Google could not be reached. */
  readonly status?: number;
  /** Google's OAuth `error` code from the last attempt, when it sent one. */
  readonly code?: string;

  /**
   * Build with the last attempt's detail.
   * @param message Human-readable reason.
   * @param detail Status and error code of the last attempt.
   * @param options `cause`: the network error, when there was no response.
   */
  constructor(message: string, detail: OAuthErrorDetail = {}, options?: ErrorOptions) {
    super(message, options);
    if (detail.status !== undefined) this.status = detail.status;
    if (detail.code !== undefined) this.code = detail.code;
  }
}
