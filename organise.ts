/**
 * `@simtricity-commons/gmail-api/organise`: sort a mailbox with a decision model. Separate from
 * the core entry point so a plain Gmail user never downloads it.
 * @module
 */

export * from "./lib/organise/mod.ts";

/** Core message types the organise functions take, re-exported so their signatures resolve. */
export type { Message, MessagePart, MessagePartBody, MessagePartHeader } from "./mod.ts";
