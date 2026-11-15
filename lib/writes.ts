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

import { bodyText, stripHtml } from "./body.ts";
import { carryAttachments, existingBody, fileRefs, MAX_ATTACHMENT_BYTES } from "./carry.ts";
import {
  type BodyTail,
  composeBody,
  forwardBlock,
  forwardSubject,
  quoteBlock,
  type SignatureBlock,
  signatureBlock,
} from "./compose.ts";
import {
  addRecipients,
  bareAddress,
  replyAllRecipients,
  replyRecipients,
  splitAddresses,
} from "./recipients.ts";
import { SCOPE_COMPOSE, SCOPE_MODIFY } from "./auth.ts";
import type { GmailClient } from "./client.ts";
import {
  AttachmentLimitError,
  DraftChangedError,
  DraftNotEditableError,
  GmailApiError,
  InsufficientScopeError,
} from "./errors.ts";
import { buildRawMessage, header } from "./mime.ts";
import type {
  Draft,
  DraftInput,
  DraftPlan,
  ForwardInput,
  ForwardPlan,
  Label,
  LabelChange,
  LabelOptions,
  Message,
  SendAs,
  Thread,
  UpdateDraftInput,
  UpdatePlan,
} from "./types.ts";

/** Labels a `LabelChange` refuses without `allowSystem`, because touching them archives or trashes. */
export const GUARDED_SYSTEM_LABELS: readonly string[] = ["TRASH", "SPAM", "INBOX"];

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

  /**
   * The account holder's own addresses, bare and lower-cased: the profile address and every
   * send-as. Reply-all leaves these out. Pass `sendAs` when already read.
   */
  async selfAddresses(sendAs?: SendAs[]): Promise<Set<string>> {
    const [profile, list] = await Promise.all([
      this.client.profile(),
      sendAs ?? this.client.listSendAs(),
    ]);
    return new Set(
      [profile.emailAddress, ...list.map((s) => s.sendAsEmail)]
        .filter((a): a is string => typeof a === "string" && a.length > 0)
        .map(bareAddress),
    );
  }

  // ── Drafts ─────────────────────────────────────────────────────────────────

  /**
   * Create a draft: plain text, or text and HTML, optionally with file attachments (total at most
   * {@link MAX_ATTACHMENT_BYTES}, checked before any network call). With `replyToMessageId` the
   * draft lands in that thread with In-Reply-To/References set, `to` from the original's Reply-To
   * or From and subject `Re: …` unless given, and the original quoted underneath unless
   * `quote: false`. Nothing is sent; there is no send method in this package.
   */
  async createDraft(input: DraftInput): Promise<Draft> {
    return await this.postDraft(await this.buildDraft(input));
  }

  /** The signature of the address drafts are written from: the default send-as, else the primary. */
  private signatureFrom(sendAs: SendAs[]): SignatureBlock | null {
    const from = sendAs.find((a) => a.isDefault) ?? sendAs.find((a) => a.isPrimary);
    return signatureBlock(from?.signature);
  }

  /**
   * Build a forward of `messageId`, as Gmail's own Forward writes it: `Fwd:` subject, the
   * forwarded-message block, the original's files, and the original's thread (`In-Reply-To`,
   * `References`). Recipients are the caller's only. Writes nothing.
   */
  async buildForward(input: ForwardInput): Promise<ForwardPlan> {
    if (!input.to?.length) throw new TypeError("forwardDraft: `to` is required");
    await this.requireScope(SCOPE_COMPOSE);
    const orig = await this.client.getMessage(input.messageId, "full");
    const pick = input.attachments ?? "all";
    const regular = fileRefs(orig).filter((f) => !f.inline).map((f) => f.filename);
    if (Array.isArray(pick)) {
      const unknown = pick.filter((n) => !regular.includes(n));
      if (unknown.length) {
        throw new TypeError(
          `forwardDraft: no file named ${unknown.map((n) => `"${n}"`).join(", ")}`,
        );
      }
    }
    const carried = await carryAttachments(this.client, orig, {
      select: pick === "all"
        ? undefined
        : pick === "none"
        ? () => false
        : (f) => pick.includes(f.filename),
    });
    const signature = input.signature ? this.signatureFrom(await this.client.listSendAs()) : null;
    const msgId = header(orig.payload, "Message-ID") ?? header(orig.payload, "Message-Id");
    const prior = header(orig.payload, "References")?.split(/\s+/).filter(Boolean) ?? [];
    const to = input.to;
    const cc = input.cc ?? [];
    const bcc = input.bcc ?? [];
    const raw = buildRawMessage({
      to,
      cc,
      bcc,
      subject: forwardSubject(header(orig.payload, "Subject") ?? ""),
      ...composeBody({
        text: input.text ?? "",
        html: input.html,
        signature,
        tail: forwardBlock({
          from: header(orig.payload, "From") ?? "",
          date: header(orig.payload, "Date"),
          subject: header(orig.payload, "Subject"),
          to: header(orig.payload, "To"),
          cc: header(orig.payload, "Cc"),
          text: bodyText(orig).text,
        }),
      }),
      inReplyTo: msgId,
      references: msgId ? [...prior, msgId] : prior,
      attachments: carried.files,
    });
    return {
      message: orig.threadId ? { raw, threadId: orig.threadId } : { raw },
      recipients: { to, cc, bcc },
      carried: {
        count: carried.files.length,
        totalBytes: carried.totalBytes,
        sha256: carried.sha256,
      },
      skippedInline: carried.skippedInline,
      signature: !input.signature ? "off" : signature ? "added" : "none",
    };
  }

  /**
   * Build an edit of a draft. **Anything not given is kept**: recipients, subject, threading
   * (`In-Reply-To`, `References`, the thread), the body when neither `text` nor `html` is given,
   * and every file. Refuses rather than loses: a draft with inline images, or a file that cannot
   * be read back, throws {@link DraftNotEditableError}. Writes nothing.
   */
  async buildUpdate(input: UpdateDraftInput): Promise<UpdatePlan> {
    await this.requireScope(SCOPE_COMPOSE);
    const { message: msg } = await this.client.getDraft(input.draftId, "full");
    if (input.expectMessageId && input.expectMessageId !== msg.id) {
      throw new DraftChangedError(input.draftId, input.expectMessageId, msg.id);
    }
    const refs = fileRefs(msg);
    if (refs.some((f) => f.inline)) throw new DraftNotEditableError(input.draftId, "inline_parts");
    const remove = input.removeAttachments ?? [];
    const unknown = remove.filter((n) => !refs.some((f) => f.filename === n));
    if (unknown.length) {
      throw new TypeError(`updateDraft: no file named ${unknown.map((n) => `"${n}"`).join(", ")}`);
    }
    const add = input.addAttachments ?? [];
    let carried;
    try {
      carried = await carryAttachments(this.client, msg, {
        select: (f) => !remove.includes(f.filename),
        addedBytes: add.reduce((n, a) => n + a.content.length, 0),
      });
    } catch (e) {
      if (e instanceof GmailApiError) {
        throw new DraftNotEditableError(input.draftId, "download_failed", { cause: e });
      }
      throw e;
    }

    const h = (name: string) => header(msg.payload, name);
    // An empty list is not an instruction to clear: argument parsers hand over [] for an absent
    // flag, and an edit must never lose a recipient the draft had. Recipients come only from the
    // draft's own headers; nothing is recomputed from the original.
    const to = input.to?.length ? input.to : splitAddresses(h("To"));
    const cc = input.cc?.length ? input.cc : splitAddresses(h("Cc"));
    const bcc = input.bcc?.length ? input.bcc : splitAddresses(h("Bcc"));
    const inReplyTo = h("In-Reply-To");
    const references = h("References")?.split(/\s+/).filter(Boolean);
    const old = existingBody(msg);

    let bodyParts: { text: string; html?: string };
    let quoted: boolean;
    let signatureOutcome: UpdatePlan["signature"];
    const rebuild = input.text !== undefined || input.html !== undefined;
    if (!rebuild) {
      // the body is kept exactly: its text and HTML parts as they were
      bodyParts = { text: old.text ?? stripHtml(old.html ?? ""), html: old.html };
      quoted = old.html?.includes('class="gmail_quote"') ?? false;
      signatureOutcome = old.html?.includes('class="gmail_signature"') ? "added" : "off";
    } else {
      let tail: BodyTail | null = null;
      if (inReplyTo && input.quote !== false && msg.threadId) {
        const thread = await this.client.getThread(msg.threadId, "full");
        const orig = (thread.messages ?? []).find((m) =>
          (header(m.payload, "Message-ID") ?? header(m.payload, "Message-Id")) === inReplyTo
        );
        if (orig) {
          tail = quoteBlock({
            date: header(orig.payload, "Date"),
            from: header(orig.payload, "From") ?? "",
            text: bodyText(orig).text,
          });
        }
      }
      const wantSig = input.signature ?? (old.html?.includes('class="gmail_signature"') ?? false);
      const signature = wantSig ? this.signatureFrom(await this.client.listSendAs()) : null;
      bodyParts = composeBody({
        text: input.text ?? stripHtml(input.html ?? ""),
        html: input.html,
        signature,
        tail,
      });
      quoted = tail !== null;
      signatureOutcome = !wantSig ? "off" : signature ? "added" : "none";
    }

    const raw = buildRawMessage({
      to,
      cc,
      bcc,
      subject: input.subject ?? h("Subject") ?? "",
      ...bodyParts,
      inReplyTo,
      references,
      attachments: [...carried.files, ...add],
    });
    return {
      draftId: input.draftId,
      previousMessageId: msg.id,
      message: msg.threadId ? { raw, threadId: msg.threadId } : { raw },
      recipients: { to, cc, bcc },
      body: rebuild ? "rebuilt" : "kept",
      kept: { count: carried.files.length, sha256: carried.sha256 },
      added: add.length,
      removed: remove.length,
      quoted,
      signature: signatureOutcome,
    };
  }

  /**
   * Write a {@link buildUpdate} plan. The draft is read again first: if its message id has moved
   * since the plan was built, {@link DraftChangedError} and nothing is written. That narrows the
   * window to one round trip; it is not atomic. The draft id stays; Gmail gives it a new message id.
   */
  async putDraft(plan: UpdatePlan): Promise<Draft> {
    await this.requireScope(SCOPE_COMPOSE);
    const now = await this.client.getDraft(plan.draftId, "minimal");
    if (now.message.id !== plan.previousMessageId) {
      throw new DraftChangedError(plan.draftId, plan.previousMessageId, now.message.id);
    }
    return await this.client.request<Draft>("PUT", `/drafts/${encodeURIComponent(plan.draftId)}`, {
      id: plan.draftId,
      message: plan.message,
    });
  }

  /** Write a draft from a {@link buildDraft} plan. Nothing is sent. */
  async postDraft(plan: { message: DraftPlan["message"] }): Promise<Draft> {
    await this.requireScope(SCOPE_COMPOSE);
    return await this.client.request<Draft>("POST", "/drafts", { message: plan.message });
  }

  /**
   * Build the message {@link createDraft} would post, reading the original when replying, and say
   * what went into it. Writes nothing. Needs the compose grant, like the write it prepares.
   */
  async buildDraft(input: DraftInput): Promise<DraftPlan> {
    if (input.replyAll && !input.replyToMessageId) {
      throw new TypeError("createDraft: replyAll needs replyToMessageId");
    }
    const attachBytes = (input.attachments ?? []).reduce((n, a) => n + a.content.length, 0);
    if (attachBytes > MAX_ATTACHMENT_BYTES) {
      throw new AttachmentLimitError(attachBytes, MAX_ATTACHMENT_BYTES);
    }
    await this.requireScope(SCOPE_COMPOSE);
    let to = input.to ?? [];
    let cc = input.cc ?? [];
    const bcc = input.bcc ?? [];
    let subject = input.subject;
    let inReplyTo: string | undefined;
    let references: string[] | undefined;
    let threadId: string | undefined;
    let tail: BodyTail | null = null;
    let sendAs: SendAs[] | undefined;
    const listSendAs = async () => sendAs ??= await this.client.listSendAs();
    if (input.replyToMessageId) {
      const quote = input.quote !== false;
      const orig = await this.client.getMessage(
        input.replyToMessageId,
        quote ? "full" : "metadata",
      );
      threadId = orig.threadId;
      const msgId = header(orig.payload, "Message-ID") ?? header(orig.payload, "Message-Id");
      inReplyTo = msgId;
      const prior = header(orig.payload, "References")?.split(/\s+/).filter(Boolean) ?? [];
      references = msgId ? [...prior, msgId] : prior;
      if (input.replyAll) {
        const all = replyAllRecipients({
          from: header(orig.payload, "From"),
          replyTo: header(orig.payload, "Reply-To"),
          to: header(orig.payload, "To"),
          cc: header(orig.payload, "Cc"),
        }, await this.selfAddresses(await listSendAs()));
        if (!input.to?.length) to = all.to;
        cc = addRecipients([], [...all.cc, ...(input.cc ?? [])], to);
      } else if (!to.length) {
        to = replyRecipients({
          from: header(orig.payload, "From"),
          replyTo: header(orig.payload, "Reply-To"),
          to: header(orig.payload, "To"),
        }, await this.selfAddresses(await listSendAs()));
      }
      if (!subject) {
        const s = header(orig.payload, "Subject") ?? "";
        subject = /^re:/i.test(s) ? s : `Re: ${s}`;
      }
      if (quote) {
        tail = quoteBlock({
          date: header(orig.payload, "Date"),
          from: header(orig.payload, "From") ?? "",
          text: bodyText(orig).text,
        });
      }
    }
    const signature = input.signature ? await this.signatureFrom(await listSendAs()) : null;
    if (!to.length) throw new Error("createDraft: no recipients (pass `to` or a replyToMessageId)");
    const raw = buildRawMessage({
      to,
      cc,
      bcc,
      subject: subject ?? "",
      ...composeBody({ text: input.text, html: input.html, signature, tail }),
      inReplyTo,
      references,
      attachments: input.attachments,
    });
    return {
      message: threadId ? { raw, threadId } : { raw },
      recipients: { to, cc, bcc },
      quoted: tail !== null,
      signature: !input.signature ? "off" : signature ? "added" : "none",
    };
  }

  /** Delete a draft. Irreversible, but a draft is only ever local to the mailbox. */
  async deleteDraft(id: string): Promise<void> {
    await this.requireScope(SCOPE_COMPOSE);
    await this.client.request<void>("DELETE", `/drafts/${encodeURIComponent(id)}`);
  }
}
