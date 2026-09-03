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
  }
}

/** The OAuth dance itself failed (bind, exchange, refresh, revoke). */
export class OAuthError extends Error {
  /** Error class name, stable across minification. */
  override name = "OAuthError";
}
