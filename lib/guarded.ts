/**
 * `GuardedWriter` — the policy layer every interactive caller (CLI, agent skill) should use
 * for writes. It wraps `GmailWriter` and adds the rules that stop a person or an agent from
 * doing more than they meant: an id cap per call, no system labels, plan-then-apply for label
 * changes, idempotent label creation, and one JSON line per applied write in a log.
 *
 * Bulk consumers that have already decided what to do (e.g. a classifier labelling 50,000
 * messages) use `GmailWriter` directly and skip these guards on purpose.
 * @module
 */

import type { Draft, DraftInput, Label } from "./types.ts";
import type { GmailWriter } from "./writes.ts";

/** Default per-call id cap. */
export const DEFAULT_MAX_IDS = 25;

/** Where applied writes are recorded. */
export interface WriteLogOptions {
  /** File to append JSON lines to (created 0600). */
  path: string;
  /** Who is writing, e.g. `"gmail-api-cli"` or `"my-agent-skill"`. Recorded on every line. */
  via: string;
}

/** Options for `GuardedWriter`. */
export interface GuardedWriterOptions {
  /** Max ids per label change. Default {@link DEFAULT_MAX_IDS}. */
  maxIds?: number;
  /** Append a JSON line per applied write. Omit to disable logging. */
  log?: WriteLogOptions;
  /** Clock for log timestamps (tests). Default `() => new Date()`. */
  now?: () => Date;
}

/** Target kind of a label change. */
export type LabelTargetKind = "message" | "thread";

/** A label change that has been validated but not applied. Also the shape logged when applied. */
export interface LabelPlan {
  /** `label.apply` adds the label; `label.remove` takes it off. */
  op: "label.apply" | "label.remove";
  /** The resolved label. */
  label: { id: string; name: string };
  /** Whether `ids` are message or thread ids. */
  kind: LabelTargetKind;
  /** Target ids, de-duplicated, in the order given. */
  ids: string[];
  /** `ids.length`. */
  count: number;
}

/** Input to {@link GuardedWriter.planLabelChange}. */
export interface LabelChangeRequest {
  /** Exact label name. Must already exist. */
  name: string;
  /** Message or thread ids. */
  ids: string[];
  /** Remove instead of apply. */
  remove?: boolean;
  /** Treat `ids` as thread ids. Default: message ids. */
  kind?: LabelTargetKind;
}

/** Outcome of {@link GuardedWriter.labelChange}. */
export type LabelChangeResult =
  & LabelPlan
  & ({ dryRun: true; applied?: never } | { applied: true; dryRun?: never });

/** Outcome of {@link GuardedWriter.createLabel}. */
export interface CreateLabelResult {
  /** The label, existing or new (a nested name's leaf). */
  label: Label;
  /** False when the label already existed. */
  created: boolean;
}

/** Outcome of {@link GuardedWriter.createDraft}. */
export interface CreateDraftResult {
  /** The draft as Gmail returned it. */
  draft: Draft;
  /** Link that opens the draft in Gmail's web UI. */
  url: string;
  /** Always false: this package cannot send. */
  sent: false;
}

/** A guard refused the request. Nothing was sent to Gmail. */
export class WriteGuardError extends Error {
  /** Error class name, stable across minification. */
  override name = "WriteGuardError";
  /**
   * Build with a machine-readable code.
   * @param code Which rule refused: `no-ids`, `too-many-ids`, `no-such-label`, `system-label`.
   * @param message Human-readable reason.
   */
  constructor(
    readonly code: "no-ids" | "too-many-ids" | "no-such-label" | "system-label",
    message: string,
  ) {
    super(message);
  }
}

/** Policy wrapper over `GmailWriter` for interactive and agent callers. */
export class GuardedWriter {
  /** Effective per-call id cap. */
  readonly maxIds: number;
  private readonly now: () => Date;

  /**
   * Wrap a writer. No network call.
   * @param writer A `GmailWriter` over a client holding the write grant.
   * @param opts Cap, log destination and clock.
   */
  constructor(readonly writer: GmailWriter, private readonly opts: GuardedWriterOptions = {}) {
    this.maxIds = opts.maxIds ?? DEFAULT_MAX_IDS;
    this.now = opts.now ?? (() => new Date());
  }

  /** Append one JSON line to the write log, if configured. */
  private async record(entry: Record<string, unknown>): Promise<void> {
    const log = this.opts.log;
    if (!log) return;
    const account = await this.writer.client.email().catch(() => null);
    const line = JSON.stringify({ at: this.now().toISOString(), via: log.via, account, ...entry });
    await Deno.writeTextFile(log.path, line + "\n", { append: true, mode: 0o600 });
  }

  /** Create a label (parents too) unless it exists. Logs only when something was created. */
  async createLabel(name: string): Promise<CreateLabelResult> {
    const existed = await this.writer.findLabel(name);
    const label = await this.writer.ensureLabel(name);
    if (!existed) await this.record({ op: "label.create", name, id: label.id });
    return { label, created: !existed };
  }

  /** Validate a label change and resolve the label. No write, no log. */
  async planLabelChange(req: LabelChangeRequest): Promise<LabelPlan> {
    const ids = [...new Set(req.ids.map((x) => x.trim()).filter(Boolean))];
    if (!ids.length) throw new WriteGuardError("no-ids", "no ids given");
    if (ids.length > this.maxIds) {
      throw new WriteGuardError(
        "too-many-ids",
        `refusing ${ids.length} ids; max ${this.maxIds} per call`,
      );
    }
    const label = await this.writer.findLabel(req.name);
    if (!label) {
      throw new WriteGuardError(
        "no-such-label",
        `no label named ${JSON.stringify(req.name)}; create it first`,
      );
    }
    if (label.type === "system") {
      throw new WriteGuardError("system-label", `refusing system label ${label.name}`);
    }
    return {
      op: req.remove ? "label.remove" : "label.apply",
      label: { id: label.id, name: label.name },
      kind: req.kind ?? "message",
      ids,
      count: ids.length,
    };
  }

  /** Apply a plan from {@link planLabelChange} and log it. */
  async applyLabelPlan(plan: LabelPlan): Promise<void> {
    const change = plan.op === "label.remove"
      ? { removeLabelIds: [plan.label.id] }
      : { addLabelIds: [plan.label.id] };
    if (plan.kind === "thread") {
      for (const id of plan.ids) await this.writer.modifyThread(id, change);
    } else {
      await this.writer.batchModifyMessages(plan.ids, change);
    }
    await this.record({ ...plan });
  }

  /** Plan, then apply only when `apply` is true. The default is a dry run. */
  async labelChange(req: LabelChangeRequest & { apply?: boolean }): Promise<LabelChangeResult> {
    const plan = await this.planLabelChange(req);
    if (!req.apply) return { ...plan, dryRun: true };
    await this.applyLabelPlan(plan);
    return { ...plan, applied: true };
  }

  /** Create a draft and log it. Never sends. */
  async createDraft(input: DraftInput): Promise<CreateDraftResult> {
    const draft = await this.writer.createDraft(input);
    await this.record({
      op: "draft.create",
      draftId: draft.id,
      messageId: draft.message.id,
      threadId: draft.message.threadId ?? null,
    });
    return {
      draft,
      url: `https://mail.google.com/mail/u/0/#drafts?compose=${draft.message.id}`,
      sent: false,
    };
  }
}
