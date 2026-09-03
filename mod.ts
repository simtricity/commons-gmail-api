/**
 * Gmail REST API — typed Deno client with loopback OAuth, read-only by default, and
 * thread-level attachment download.
 *
 * @example
 * ```ts
 * import {
 *   FileTokenStore,
 *   GmailClient,
 *   fetchThreadAttachments,
 *   loadClientSecretFile,
 * } from "@simtricity-commons/gmail-api";
 *
 * const home = Deno.env.get("HOME")!;
 * const clientSecret = await loadClientSecretFile(`${home}/.simt/gmail-api/client-secret.json`);
 * const store = new FileTokenStore({ path: `${home}/.simt/gmail-api/credentials.json` });
 * const gmail = await GmailClient.fromStore({ clientSecret, store });
 *
 * const manifest = await fetchThreadAttachments(gmail, "18c9f0a1b2d3e4f5", { outDir: "./out" });
 * console.log(manifest.files.map((f) => `${f.savedAs} ${f.sha256}`));
 * ```
 *
 * @module
 */

export * from "./lib/mod.ts";
