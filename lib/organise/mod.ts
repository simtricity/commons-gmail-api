/**
 * The organiser engine: sort a mailbox with typed judgements and pure routes. Imported only
 * through the package's `./organise` entry point; the core entry point never loads it.
 * @module
 */

export * from "./capture.ts";
export * from "./corpus.ts";
export * from "./envelope.ts";
export * from "./golden.ts";
export * from "./mail.ts";
export * from "./message.ts";
export * from "./policy.ts";
export * from "./relationships.ts";
export * from "./sample.ts";
export * from "./throttle.ts";
export * from "./types.ts";
export * from "./verdict.ts";
export * from "./triage/decide.ts";
