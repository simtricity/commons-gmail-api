/**
 * Error types. Callers branch on `instanceof`, never on message text.
 * @module
 */

/** No usable credential for the requested account. Remedy: interactive login. */
export class NotSignedInError extends Error {
  override name = "NotSignedInError";
}

/** Google returned a non-2xx from the Gmail REST API. */
export class GmailApiError extends Error {
  override name = "GmailApiError";
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
  override name = "OAuthError";
}
