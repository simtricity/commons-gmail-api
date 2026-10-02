/**
 * `GmailWriter` — the only write surface in this package: labels and drafts.
 *
 * Separate from `GmailClient` on purpose: importing the read client can never mutate a mailbox,
 * and this module can be left out of a read-only vendored copy. Needs a credential granted with
 * `SCOPES_WRITE` (`login --write`); every method checks the granted scope locally and throws
 * `InsufficientScopeError` before any network call.
 *
 * Not here, deliberately: send, trash, permanent delete, filters, settings.
 * @module
 */

import { SCOPE_COMPOSE, SCOPE_MODIFY } from "./auth.ts";
import type { GmailClient } from "./client.ts";
import { GmailApiError, InsufficientScopeError } from "./errors.ts";
import { buildRawMessage, header } from "./mime.ts";
import type {
  Draft,
  DraftInput,
  Label,
  LabelChange,
  LabelOptions,
  Message,
  Thread,
} from "./types.ts";

/** Labels a `LabelChange` refuses without `allowSystem`, because touching them archives or trashes. */
export const GUARDED_SYSTEM_LABELS: readonly string[] = ["TRASH", "SPAM", "INBOX"];

/** Total attachment bytes `createDraft` accepts: Gmail's 25 MB limit on what can be sent. */
export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

/** Gmail's per-call ceiling for `messages.batchModify`. */
export const BATCH_MODIFY_MAX = 1000;

/** Options for `GmailWriter`. */
export interface GmailWriterOptions {
  /** Diagnostics. Default: silent. */
  log?: (line: string) => void;
}

/** Label and draft writes over a `GmailClient` whose grant includes the write scopes. */
export class GmailWriter {
  private readonly log: (line: string) => void;
  private labelCache: Label[] | null = null;

  /**
   * Wrap a client. No network call; the scope check happens per operation.
   * @param client A client loaded from the write credential store.
   * @param opts Diagnostics.
   */
  constructor(readonly client: GmailClient, opts: GmailWriterOptions = {}) {
    this.log = opts.log ?? (() => {});
  }

  /** Throw `InsufficientScopeError` unless the credential grants `scope`. */
  async requireScope(scope: string): Promise<void> {
    const granted = await this.client.grantedScopes();
    if (!granted.includes(scope)) throw new InsufficientScopeError(scope, granted);
  }

  // ── Labels ─────────────────────────────────────────────────────────────────

  /** All labels, cached for the writer's lifetime; `refresh` forces a re-read. */
  async listLabels(refresh = false): Promise<Label[]> {
    if (!this.labelCache || refresh) this.labelCache = await this.client.listLabels();
    return this.labelCache;
  }

  /** Find a label by exact name (case-sensitive, as Gmail stores it). */
  async findLabel(name: string): Promise<Label | undefined> {
    return (await this.listLabels()).find((l) => l.name === name);
  }

  /** Create a label. `name` may contain `/` for nesting; parents are NOT created (see `ensureLabel`). */
  async createLabel(name: string, opts: LabelOptions = {}): Promise<Label> {
    await this.requireScope(SCOPE_MODIFY);
    const label = await this.client.request<Label>("POST", "/labels", { name, ...opts });
    this.labelCache?.push(label);
    return label;
  }

  /**
   * Find by exact name, else create — including every missing parent of a nested name, in order,
   * because Gmail creates only the leaf. Idempotent; a 409 from a concurrent run is treated as
   * "exists" and re-resolved.
   */
  async ensureLabel(name: string, opts: LabelOptions = {}): Promise<Label> {
    await this.requireScope(SCOPE_MODIFY);
    const parts = name.split("/").filter(Boolean);
    let result: Label | undefined;
    for (let i = 1; i <= parts.length; i++) {
      const prefix = parts.slice(0, i).join("/");
      const isLeaf = i === parts.length;
      let label = await this.findLabel(prefix);
      if (!label) {
        try {
          label = await this.createLabel(prefix, isLeaf ? opts : {});
          this.log(`created label ${prefix}`);
        } catch (e) {
          if (!(e instanceof GmailApiError && e.status === 409)) throw e;
          // fallback: another process created it between our list and create; re-read and resolve
          label = (await this.listLabels(true)).find((l) => l.name === prefix);
          if (!label) throw e;
        }
      }
      result = label;
    }
    if (!result) throw new Error(`ensureLabel: empty name ${JSON.stringify(name)}`);
    return result;
  }

  /** Rename or change visibility. */
  async updateLabel(id: string, patch: LabelOptions & { name?: string }): Promise<Label> {
    await this.requireScope(SCOPE_MODIFY);
    const label = await this.client.request<Label>(
      "PATCH",
      `/labels/${encodeURIComponent(id)}`,
      patch,
    );
    this.labelCache = null;
    return label;
  }

  /** Delete the label object. Messages that carried it are untouched. */
  async deleteLabel(id: string): Promise<void> {
    await this.requireScope(SCOPE_MODIFY);
    await this.client.request<void>("DELETE", `/labels/${encodeURIComponent(id)}`);
    this.labelCache = null;
  }

  // ── Messages / threads ─────────────────────────────────────────────────────

  /** Refuse guarded system labels unless allowed; strip empty arrays. */
  private guard(change: LabelChange): { addLabelIds?: string[]; removeLabelIds?: string[] } {
    const touched = [...(change.addLabelIds ?? []), ...(change.removeLabelIds ?? [])];
    const hit = touched.filter((id) => GUARDED_SYSTEM_LABELS.includes(id));
    if (hit.length && !change.allowSystem) {
      throw new Error(
        `refusing to change system label(s) ${hit.join(", ")} without allowSystem (archive/trash)`,
      );
    }
    const body: { addLabelIds?: string[]; removeLabelIds?: string[] } = {};
    if (change.addLabelIds?.length) body.addLabelIds = change.addLabelIds;
    if (change.removeLabelIds?.length) body.removeLabelIds = change.removeLabelIds;
    return body;
  }

  /** Add and/or remove labels on one message. Returns the updated message. */
  async modifyMessage(id: string, change: LabelChange): Promise<Message> {
    await this.requireScope(SCOPE_MODIFY);
    const body = this.guard(change);
    return await this.client.request<Message>(
      "POST",
      `/messages/${encodeURIComponent(id)}/modify`,
      body,
    );
  }

  /**
   * The same change across many messages, chunked at 1000 ids per call. Gmail returns no
   * per-message result (204), so a caller needing confirmation re-reads. Empty `ids` is a no-op.
   * @returns Number of API calls made.
   */
  async batchModifyMessages(ids: string[], change: LabelChange): Promise<number> {
    await this.requireScope(SCOPE_MODIFY);
    const body = this.guard(change);
    let calls = 0;
    for (let i = 0; i < ids.length; i += BATCH_MODIFY_MAX) {
      const chunk = ids.slice(i, i + BATCH_MODIFY_MAX);
      await this.client.request<void>("POST", "/messages/batchModify", { ids: chunk, ...body });
      calls++;
      this.log(`batchModify ${chunk.length} messages (${i + chunk.length}/${ids.length})`);
    }
    return calls;
  }

  /** Add and/or remove labels on every message in a thread. */
  async modifyThread(id: string, change: LabelChange): Promise<Thread> {
    await this.requireScope(SCOPE_MODIFY);
    const body = this.guard(change);
    return await this.client.request<Thread>(
      "POST",
      `/threads/${encodeURIComponent(id)}/modify`,
      body,
    );
  }

  // ── Drafts ─────────────────────────────────────────────────────────────────

  /**
   * Create a plain-text draft, optionally with file attachments (total at most
   * {@link MAX_ATTACHMENT_BYTES}, checked before any network call). With `replyToMessageId` the draft lands in that thread with
   * In-Reply-To/References set and, unless given, `to` from the original's Reply-To or From and
   * subject `Re: …`. Nothing is sent; there is no send method in this package.
   */
  async createDraft(input: DraftInput): Promise<Draft> {
    await this.requireScope(SCOPE_COMPOSE);
    let to = input.to ?? [];
    let subject = input.subject;
    let inReplyTo: string | undefined;
    let references: string[] | undefined;
    let threadId: string | undefined;
    if (input.replyToMessageId) {
      const orig = await this.client.getMessage(input.replyToMessageId, "metadata");
      threadId = orig.threadId;
      const msgId = header(orig.payload, "Message-ID") ?? header(orig.payload, "Message-Id");
      inReplyTo = msgId;
      const prior = header(orig.payload, "References")?.split(/\s+/).filter(Boolean) ?? [];
      references = msgId ? [...prior, msgId] : prior;
      if (!to.length) {
        const rt = header(orig.payload, "Reply-To") ?? header(orig.payload, "From");
        if (rt) to = [rt];
      }
      if (!subject) {
        const s = header(orig.payload, "Subject") ?? "";
        subject = /^re:/i.test(s) ? s : `Re: ${s}`;
      }
    }
    if (!to.length) throw new Error("createDraft: no recipients (pass `to` or a replyToMessageId)");
    const attachBytes = (input.attachments ?? []).reduce((n, a) => n + a.content.length, 0);
    if (attachBytes > MAX_ATTACHMENT_BYTES) {
      throw new Error(
        `createDraft: attachments total ${attachBytes} bytes; Gmail's limit is ${MAX_ATTACHMENT_BYTES}`,
      );
    }
    const raw = buildRawMessage({
      to,
      cc: input.cc,
      bcc: input.bcc,
      subject: subject ?? "",
      text: input.text,
      inReplyTo,
      references,
      attachments: input.attachments,
    });
    const message: { raw: string; threadId?: string } = { raw };
    if (threadId) message.threadId = threadId;
    return await this.client.request<Draft>("POST", "/drafts", { message });
  }

  /** Delete a draft. Irreversible, but a draft is only ever local to the mailbox. */
  async deleteDraft(id: string): Promise<void> {
    await this.requireScope(SCOPE_COMPOSE);
    await this.client.request<void>("DELETE", `/drafts/${encodeURIComponent(id)}`);
  }
}
