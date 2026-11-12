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

/** The OAuth dance itself failed (bind, exchange, refresh, revoke). */
export class OAuthError extends Error {
  /** Error class name, stable across minification. */
  override name = "OAuthError";
}

/** The files would take a draft over Gmail's limit. Checked before anything is downloaded. */
export class AttachmentLimitError extends Error {
  /** Error class name, stable across minification. */
  override name = "AttachmentLimitError";
  /**
   * Build with the sizes that tripped the check.
   * @param totalBytes The files' total, as declared, plus any the caller adds.
   * @param limit The limit checked against.
   */
  constructor(readonly totalBytes: number, readonly limit: number) {
    super(`attachments total ${totalBytes} bytes; Gmail's limit is ${limit}`);
  }
}

/**
 * A draft cannot be edited without losing something the user put in it. Nothing was written.
 * `inline_parts`: it holds inline images, which this release does not carry. `download_failed`:
 * one of its files could not be read back.
 */
export class DraftNotEditableError extends Error {
  /** Error class name, stable across minification. */
  override name = "DraftNotEditableError";
  /**
   * Build with the draft and the reason.
   * @param draftId The draft refused.
   * @param reason Why: `inline_parts` or `download_failed`.
   * @param options Standard error options; `cause` carries a failed download's error.
   */
  constructor(
    readonly draftId: string,
    readonly reason: "inline_parts" | "download_failed",
    options?: ErrorOptions,
  ) {
    super(
      reason === "inline_parts"
        ? `draft ${draftId} has inline images; editing it would drop them, so it was left unchanged`
        : `a file on draft ${draftId} could not be read back; it was left unchanged`,
      options,
    );
  }
}

/** The draft changed in Gmail since it was read (its message id moved). Nothing was written. */
export class DraftChangedError extends Error {
  /** Error class name, stable across minification. */
  override name = "DraftChangedError";
  /**
   * Build with the ids compared.
   * @param draftId The draft.
   * @param expected The message id the caller read.
   * @param actual The draft's message id now.
   */
  constructor(readonly draftId: string, readonly expected: string, readonly actual: string) {
    super(`draft ${draftId} changed since it was read (message ${expected} is now ${actual})`);
  }
}
