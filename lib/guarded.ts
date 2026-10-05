/**
 * `GuardedWriter` — the policy layer for writes. It wraps `GmailWriter` and adds the rules that
 * stop a person or an agent from doing more than they meant, and one JSON line per applied
 * write in a log. Two kinds of caller:
 *
 * - **Interactive** (CLI, agent skill): `labelChange` — an id cap per call (default 25), no
 *   system labels, plan-then-apply, idempotent label creation.
 * - **Bulk, inside a prefix it owns** (e.g. a classifier labelling 50,000 messages under
 *   `sorter/`): `createScopedLabel` / `planScopedRelabel` / `scopedRelabel` — no id cap, but
 *   every label added or removed must sit under the caller's prefix, and the log records a hash
 *   of the ids rather than the ids.
 *
 * `GmailWriter` stays the unguarded layer for code that has already decided everything itself.
 * @module
 */

import { sha256Hex } from "./mime.ts";
import type { Draft, DraftInput, Label } from "./types.ts";
import { BATCH_MODIFY_MAX, type GmailWriter } from "./writes.ts";

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
   * @param code Which rule refused: `no-ids`, `too-many-ids`, `no-such-label`, `system-label`,
   *   and for scoped relabels `bad-scope` (prefix empty or not ending in `/`) and
   *   `outside-scope` (a label name outside the prefix).
   * @param message Human-readable reason.
   */
  constructor(
    readonly code:
      | "no-ids"
      | "too-many-ids"
      | "no-such-label"
      | "system-label"
      | "bad-scope"
      | "outside-scope",
    message: string,
  ) {
    super(message);
  }
}

/** Input to {@link GuardedWriter.planScopedRelabel} and {@link GuardedWriter.scopedRelabel}. */
export interface ScopedRelabelRequest {
  /** The caller's label prefix. Non-empty and ends in `/`, e.g. `sorter/`. */
  prefix: string;
  /** Label to add. Must start with `prefix`, exist, and not be a system label. */
  add?: string;
  /** Labels to remove. Each must start with `prefix`; names that do not exist yet are skipped. */
  remove: string[];
  /** Message ids. No cap: applied in chunks of `BATCH_MODIFY_MAX`. */
  ids: string[];
}

/** A scoped relabel that has been validated but not applied. */
export interface ScopedRelabelPlan {
  /** Always `label.relabel`. */
  op: "label.relabel";
  /** The prefix every label here sits under. */
  prefix: string;
  /** The resolved label to add, if any. */
  add?: { id: string; name: string };
  /** The resolved labels to remove: missing names skipped, `add` never among them. */
  remove: { id: string; name: string }[];
  /** Message ids, de-duplicated, in the order given. */
  ids: string[];
  /** `ids.length`. */
  count: number;
}

/** Outcome of {@link GuardedWriter.scopedRelabel}. */
export type ScopedRelabelResult =
  & ScopedRelabelPlan
  & (
    | { dryRun: true; applied?: never; calls?: never }
    | { applied: true; calls: number; dryRun?: never }
  );

/** Policy wrapper over `GmailWriter` for interactive, agent and prefix-scoped bulk callers. */
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

  /** Create a draft and log it (attachment filenames and sizes, never content). Never sends. */
  async createDraft(input: DraftInput): Promise<CreateDraftResult> {
    const draft = await this.writer.createDraft(input);
    await this.record({
      op: "draft.create",
      draftId: draft.id,
      messageId: draft.message.id,
      threadId: draft.message.threadId ?? null,
      ...(input.attachments?.length
        ? {
          attachments: input.attachments.map((a) => ({
            filename: a.filename,
            bytes: a.content.length,
          })),
        }
        : {}),
    });
    return {
      draft,
      url: `https://mail.google.com/mail/u/0/#drafts?compose=${draft.message.id}`,
      sent: false,
    };
  }

  // ── Scoped bulk relabels ──────────────────────────────────────────────────

  /** Refuse an unusable prefix, then any name outside it. */
  private checkScope(prefix: string, names: string[]): void {
    if (!prefix || !prefix.endsWith("/")) {
      throw new WriteGuardError(
        "bad-scope",
        `prefix ${JSON.stringify(prefix)} must be non-empty and end in "/"`,
      );
    }
    const outside = names.filter((n) => !n.startsWith(prefix));
    if (outside.length) {
      throw new WriteGuardError(
        "outside-scope",
        `${outside.map((n) => JSON.stringify(n)).join(", ")} outside prefix ${
          JSON.stringify(prefix)
        }`,
      );
    }
  }

  /** Create a label inside `prefix` (parents too) unless it exists. Logs only a real create. */
  async createScopedLabel(prefix: string, name: string): Promise<CreateLabelResult> {
    this.checkScope(prefix, [name]);
    return await this.createLabel(name);
  }

  /**
   * Validate a bulk relabel inside one prefix and resolve its labels. No write, no log.
   * Refusals, in order: `bad-scope`, `outside-scope`, `system-label`, `no-such-label`.
   * `remove` names that do not exist are skipped, and `add` is never also removed.
   */
  async planScopedRelabel(req: ScopedRelabelRequest): Promise<ScopedRelabelPlan> {
    this.checkScope(req.prefix, [...(req.add !== undefined ? [req.add] : []), ...req.remove]);
    const removeNames = [...new Set(req.remove)].filter((n) => n !== req.add);
    const addLabel = req.add !== undefined ? await this.writer.findLabel(req.add) : undefined;
    const removeLabels = (await Promise.all(removeNames.map((n) => this.writer.findLabel(n))))
      .filter((l): l is Label => !!l);
    const system = [addLabel, ...removeLabels].find((l) => l?.type === "system");
    if (system) {
      throw new WriteGuardError("system-label", `refusing system label ${system.name}`);
    }
    if (req.add !== undefined && !addLabel) {
      throw new WriteGuardError(
        "no-such-label",
        `no label named ${JSON.stringify(req.add)}; create it first`,
      );
    }
    const ids = [...new Set(req.ids.map((x) => x.trim()).filter(Boolean))];
    return {
      op: "label.relabel",
      prefix: req.prefix,
      ...(addLabel ? { add: { id: addLabel.id, name: addLabel.name } } : {}),
      remove: removeLabels.map((l) => ({ id: l.id, name: l.name })),
      ids,
      count: ids.length,
    };
  }

  /**
   * Plan, then apply only when `apply` is true. The default is a dry run. Applied in chunks of
   * `BATCH_MODIFY_MAX`; one log line per call, with `idsSha256` (sha256 of the sorted ids
   * joined by `\n`) in place of the ids. If a chunk fails, the line is still written, with
   * `partial: true`, `callsDone` (chunks applied, in `ids` order) and `error` (class name and
   * HTTP status only), and the error is rethrown. Nothing to add, nothing to remove or no ids is
   * a no-op: no request, no log line.
   */
  async scopedRelabel(
    req: ScopedRelabelRequest & { apply?: boolean },
  ): Promise<ScopedRelabelResult> {
    const plan = await this.planScopedRelabel(req);
    if (!req.apply) return { ...plan, dryRun: true };
    if (!plan.count || (!plan.add && !plan.remove.length)) {
      return { ...plan, applied: true, calls: 0 };
    }
    const change = {
      ...(plan.add ? { addLabelIds: [plan.add.id] } : {}),
      removeLabelIds: plan.remove.map((l) => l.id),
    };
    const line = {
      op: plan.op,
      prefix: plan.prefix,
      add: plan.add ?? null,
      remove: plan.remove,
      count: plan.count,
      idsSha256: await idsSha256(plan.ids),
    };
    // Chunked here, one request per chunk, so a failure part-way still knows how many landed.
    let calls = 0;
    try {
      for (let i = 0; i < plan.ids.length; i += BATCH_MODIFY_MAX) {
        await this.writer.batchModifyMessages(plan.ids.slice(i, i + BATCH_MODIFY_MAX), change);
        calls++;
      }
    } catch (e) {
      // Chunks 1..calls are applied in Gmail; record them before rethrowing. Ids follow
      // plan.ids order, so the first calls x BATCH_MODIFY_MAX ids are the ones that landed.
      const status = (e as { status?: unknown }).status;
      await this.record({
        ...line,
        partial: true,
        callsDone: calls,
        error: {
          name: e instanceof Error ? e.name : typeof e,
          ...(typeof status === "number" ? { status } : {}),
        },
      });
      throw e;
    }
    await this.record(line);
    return { ...plan, applied: true, calls };
  }
}

/** sha256 hex of ids sorted and joined by `\n`: how scoped relabels log ids without listing them. */
export async function idsSha256(ids: readonly string[]): Promise<string> {
  return await sha256Hex(new TextEncoder().encode([...ids].sort().join("\n")));
}
