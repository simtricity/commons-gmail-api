/**
 * The organiser: the stages of sorting a mailbox, over one data directory.
 *
 * @module
 */

import { type GoldenCase, parseGolden, type ScoreResult } from "../golden.ts";
import type { OrganiseMessage } from "../message.ts";
import { parseProfile, type Profile } from "../profile.ts";
import { ProfileError, type SenderRulings } from "../scheme.ts";
import { capture, corpus } from "./capture.ts";
import type { StageContext } from "./context.ts";
import { fetchRun, sample } from "./fetch.ts";
import { judge } from "./judge.ts";
import { decide, explain, find, runs, score } from "./decide.ts";
import { apply, reconcile } from "./labels.ts";
import { layout, readJsonOr } from "./store.ts";
import type {
  ApplySummary,
  CaptureSummary,
  CorpusSummary,
  DecideSummary,
  Explanation,
  FetchSummary,
  JudgeSummary,
  Manifest,
  OrganiserIO,
  ReconcileResult,
  SampleOptions,
} from "./types.ts";

/** Each scheme's categories, by scheme id, for checking golden cases. */
function categoriesOf(profile: Profile): Record<string, readonly string[]> {
  return Object.fromEntries(profile.schemes.map((s) => [s.id, s.categories]));
}

/**
 * The pipeline over one data directory:
 *
 *   capture → corpus → sample → fetch → judge → decide → score → apply → reconcile
 *
 * Layout: `profile.json` (absent: generic triage); `rulings/senders.json`
 * (`{ <scheme>: SenderRulings }`) and `rulings/golden.json` (`{ "cases": [...] }`),
 * either absent meaning empty; `capture/<source>/<year>.jsonl` and
 * `capture/state.json`; the corpus at the profile's `corpus` path;
 * `runs/<run>/{manifest,sample,messages,answers}.json`,
 * `runs/<run>/decisions.<scheme>.json`, `runs/<run>/apply.<scheme>.log`.
 *
 * Files are written whole (temp + rename), 0600; directories 0700. The
 * organiser reads and writes **only under the `dataDir` it is given**: it never
 * picks a default location, expands `~` or reads the environment. Choosing the
 * directory is the caller's job.
 *
 * Gmail is only ever written through the injected writer's scoped relabel:
 * label creation inside a scheme's prefix and `batchModify`. Nothing is sent,
 * trashed or deleted.
 */
export class Organiser {
  /** The data directory every path is under. */
  readonly dataDir: string;
  #ctx: StageContext;

  private constructor(ctx: StageContext) {
    this.dataDir = ctx.dataDir;
    this.#ctx = ctx;
  }

  /** Reads the profile and rulings. Throws {@link ProfileError}. Writes nothing. */
  static async open(dataDir: string, io: OrganiserIO): Promise<Organiser> {
    const files = layout(dataDir);
    // fallback: no profile file means the empty profile, which is generic triage.
    const raw = await readJsonOr<unknown>(files.profile, {});
    const senders = await readJsonOr<Record<string, SenderRulings>>(files.senders, {});
    const profile = parseProfile(raw, senders);
    if (profile.corpus.startsWith("/") || profile.corpus.split(/[\\/]/).includes("..")) {
      throw new ProfileError(
        `"corpus" must be a path inside the data directory, like derived/corpus.json`,
      );
    }
    const golden = parseGolden(
      await readJsonOr(files.golden, { cases: [] }),
      categoriesOf(profile),
    );
    return new Organiser({ dataDir, files, io, profile, senders, golden });
  }

  /** The validated profile, its schemes built in file order. */
  get profile(): Profile {
    return this.#ctx.profile;
  }

  /** The golden set, every case with its scheme. */
  get golden(): readonly GoldenCase[] {
    return this.#ctx.golden;
  }

  /** Metadata to append-only yearly shards; incremental unless `full`. */
  capture(
    o: { source: "sent" | "received"; full?: boolean; overlapDays?: number; max?: number },
  ): Promise<CaptureSummary> {
    return capture(this.#ctx, o);
  }

  /** Sent-mail corpus from the sent capture (two passes: self addresses first). */
  corpus(o: { minGenuine?: number; years?: number[] } = {}): Promise<CorpusSummary> {
    return corpus(this.#ctx, o);
  }

  /** Deterministic sample; never a thread the sent capture shows you wrote into. */
  sample(o: SampleOptions): Promise<Manifest> {
    return sample(this.#ctx, o);
  }

  /** Full reads, paced; single-message samples settled by one listing pass over the mailbox. Resumable. */
  fetch(o: { run: string }): Promise<FetchSummary> {
    return fetchRun(this.#ctx, o);
  }

  /** One model call per message for every pending question of the chosen schemes (default all). */
  judge(
    o: { run: string; schemes?: string[]; force?: boolean; concurrency?: number },
  ): Promise<JudgeSummary> {
    return judge(this.#ctx, o);
  }

  /** Pure over stored files. Default: every scheme, at the injected clock. */
  decide(
    o: { run: string; schemes?: string[]; now?: number },
  ): Promise<Record<string, DecideSummary>> {
    return decide(this.#ctx, o);
  }

  /** One scheme's stored decisions against its golden cases. */
  score(o: { run: string; scheme: string }): Promise<ScoreResult> {
    return score(this.#ctx, o);
  }

  /**
   * One scheme's decisions as labels inside its prefix. A dry run unless `apply`.
   * Each applied group is kept in `runs/<run>/apply.<scheme>.log` (ids sorted,
   * `idsSha256` as the guard logs it), which is what makes an apply undoable.
   */
  apply(o: { run: string; scheme: string; apply?: boolean }): Promise<ApplySummary> {
    return apply(this.#ctx, o);
  }

  /** Lists each of the scheme's labels and compares them with the decisions. Writes nothing. */
  reconcile(o: { run: string; scheme: string }): Promise<ReconcileResult> {
    return reconcile(this.#ctx, o);
  }

  /** The facts, answers and decision behind one message's category. */
  explain(o: { run: string; id: string; scheme: string }): Promise<Explanation> {
    return explain(this.#ctx, o);
  }

  /** Run messages whose subject or From contains `text`, case-insensitively. */
  find(o: { run: string; text: string }): Promise<OrganiseMessage[]> {
    return find(this.#ctx, o);
  }

  /** Every run's manifest, newest first. */
  runs(): Promise<Manifest[]> {
    return runs(this.#ctx);
  }
}
