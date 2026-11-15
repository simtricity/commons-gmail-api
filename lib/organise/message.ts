/**
 * One fetched message in the shape every scheme decides on: what the model is
 * shown, and the delivery headers the routes read.
 *
 * @module
 */

import { header } from "../mime.ts";
import type { Message } from "../types.ts";
import { type Envelope, envelopeOf } from "./envelope.ts";
import { toState } from "./mail.ts";
import type { MailState } from "./types.ts";

/** One fetched message, as a run stores it. */
export interface OrganiseMessage {
  /** Gmail message id. */
  id: string;
  /** Gmail thread id. */
  threadId: string;
  /** ms since epoch, as Gmail reports it. */
  internalDate: string;
  /** Gmail label ids when the message was fetched. */
  labelIds?: string[];
  /** What the decision model is shown. */
  state: MailState;
  /** The delivery headers. */
  envelope: Envelope;
}

/**
 * The model's view of a message from its body, and the envelope from its headers.
 *
 * `bodyChars` caps the body text shown to the model. Pure: no request is made.
 */
export function toOrganiseMessage(msg: Message, bodyChars = 2000): OrganiseMessage {
  return {
    id: msg.id,
    threadId: msg.threadId,
    // fallback: a message fetched without its date sorts as the epoch, and labels as 1970.
    internalDate: msg.internalDate ?? "0",
    labelIds: msg.labelIds,
    state: toState(msg, bodyChars),
    envelope: envelopeOf((name) => header(msg.payload, name)),
  };
}
