/**
 * The organiser: the stages of sorting a mailbox, over one data directory.
 *
 * @module
 */

import { type GoldenCase, parseGolden } from "../golden.ts";
import { parseProfile, type Profile } from "../profile.ts";
import { ProfileError, type SenderRulings } from "../scheme.ts";
import { capture, corpus } from "./capture.ts";
import type { StageContext } from "./context.ts";
import { layout, readJsonOr } from "./store.ts";
import type { CaptureSummary, CorpusSummary, OrganiserIO } from "./types.ts";

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
}
