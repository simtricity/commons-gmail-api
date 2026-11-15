/**
 * The decision model behind {@link Judge}: a client for TypeSafe's System One
 * endpoint.
 *
 * Unstructured state in, typed probabilistic answers out. Reads no environment
 * and carries no price: the key, the `fetch` and the model are all injected, so
 * the client is safe to import into a deployed service.
 *
 * @module
 */

import { DEFAULT_MODEL } from "./profile.ts";
import type { Answer, Question } from "./types.ts";

/** What a judge returns for one state. */
export interface JudgeResult {
  /** As the endpoint reports it, not as requested: a model alias moves. */
  model: string;
  /** Answers by question id. */
  answers: Record<string, Answer>;
  /** Input tokens the call used. */
  inputTokens: number;
}

/** Anything that answers questions about a state. Tests use a fake. */
export interface Judge {
  /** Ask every question against one state, in a single call. */
  ask(
    state: Record<string, unknown>,
    questions: Readonly<Record<string, Question>>,
  ): Promise<JudgeResult>;
}

/** The System One endpoint. */
export const SYSTEM_ONE_ENDPOINT = "https://api.typesafe.ai/v1/systemone" as const;

/** How a {@link SystemOneJudge} is set up. Only the key is required. */
export interface SystemOneJudgeOptions {
  /** API key, sent as a bearer token and never logged. */
  apiKey: string;
  /** Default {@link SYSTEM_ONE_ENDPOINT}. */
  endpoint?: string;
  /** Default `"jev-latest"`. */
  model?: string;
  /** Attempts for 429, 5xx and network failures. Default 4. */
  attempts?: number;
  /** First retry delay in ms, doubling. Default 600. */
  retryBaseMs?: number;
  /** Default `globalThis.fetch`. */
  fetch?: typeof globalThis.fetch;
}

/**
 * The endpoint answered with a non-2xx after any retries, or with a 2xx that
 * is not an answer set. Branch on `instanceof` and `status`, never on the
 * message, which carries the status alone: the key, the request and the
 * response body never appear in it.
 */
export class SystemOneError extends Error {
  /** Error class name, stable across minification. */
  override name = "SystemOneError";
  /** A machine-readable code, when the body is JSON and carries one. */
  readonly reason?: string;
  /**
   * Build from a failed or malformed response; the message carries the status only.
   * @param status HTTP status returned by the endpoint.
   * @param body Response body text, kept for the caller and never put in the message.
   * @param malformed Whether a 2xx response was not an answer set.
   */
  constructor(readonly status: number, readonly body: string, malformed = false) {
    super(`System One API ${status}${malformed ? ": malformed response" : ""}`);
    this.reason = parseReason(body);
  }
}

function parseReason(body: string): string | undefined {
  try {
    const j = JSON.parse(body) as { error?: { code?: unknown; type?: unknown }; code?: unknown };
    const r = j?.error?.code ?? j?.error?.type ?? j?.code;
    return typeof r === "string" ? r : undefined;
  } catch {
    return undefined;
  }
}

const PROBE_SUBJECT = "A short message used only to prove connectivity.";

/**
 * A {@link Judge} backed by System One. One POST per `ask`, with
 * `Authorization: Bearer <key>` and the JSON body `{ state, model, questions }`.
 *
 * Questions are evaluated in parallel and cannot see one another's answers, so
 * two questions reading the same evidence can contradict each other; reconcile
 * that in the scheme, not by assuming the model did.
 *
 * Retries a 429, a 5xx or a network failure, waiting `retryBaseMs` and doubling.
 * Any other status throws {@link SystemOneError} at once; a network failure that
 * outlasts the retries is rethrown as it came from `fetch`.
 */
export class SystemOneJudge implements Judge {
  /** The model requested on every call. */
  readonly model: string;
  readonly #key: string;
  readonly #endpoint: string;
  readonly #attempts: number;
  readonly #retryBaseMs: number;
  readonly #fetch: typeof globalThis.fetch;

  /** Throws `TypeError` without a key, before any request. */
  constructor(opts: SystemOneJudgeOptions) {
    if (!opts.apiKey) throw new TypeError("SystemOneJudge needs an apiKey");
    this.#key = opts.apiKey;
    this.#endpoint = opts.endpoint ?? SYSTEM_ONE_ENDPOINT;
    this.model = opts.model ?? DEFAULT_MODEL;
    this.#attempts = Math.max(1, opts.attempts ?? 4);
    this.#retryBaseMs = opts.retryBaseMs ?? 600;
    this.#fetch = opts.fetch ?? globalThis.fetch;
  }

  /** Ask every question against one state, in a single request. */
  async ask(
    state: Record<string, unknown>,
    questions: Readonly<Record<string, Question>>,
  ): Promise<JudgeResult> {
    const body = JSON.stringify({ state, model: this.model, questions });
    let wait = this.#retryBaseMs;
    for (let attempt = 1;; attempt++) {
      const last = attempt >= this.#attempts;
      let res: Response;
      try {
        res = await this.#fetch(this.#endpoint, {
          method: "POST",
          headers: { "Authorization": `Bearer ${this.#key}`, "Content-Type": "application/json" },
          body,
        });
      } catch (err) {
        if (last) throw err;
        await sleep(wait);
        wait *= 2;
        continue;
      }
      const text = await res.text();
      if (res.ok) return parseResult(res.status, text, this.model);
      if (!last && (res.status === 429 || res.status >= 500)) {
        await sleep(wait);
        wait *= 2;
        continue;
      }
      throw new SystemOneError(res.status, text);
    }
  }

  /** One tiny Noul, to prove the key. */
  async whoami(): Promise<{ model: string; latencyMs: number; inputTokens: number }> {
    const t0 = performance.now();
    const r = await this.ask({ subject: PROBE_SUBJECT }, {
      ok: { type: "noul", instructions: "This text is in English" },
    });
    return {
      model: r.model,
      latencyMs: Math.round(performance.now() - t0),
      inputTokens: r.inputTokens,
    };
  }
}

function parseResult(status: number, text: string, requested: string): JudgeResult {
  let j: { model?: unknown; answers?: unknown; usage?: { input_tokens?: unknown } };
  try {
    j = JSON.parse(text);
  } catch {
    throw new SystemOneError(status, text, true);
  }
  if (!j || typeof j.answers !== "object" || j.answers === null || Array.isArray(j.answers)) {
    throw new SystemOneError(status, text, true);
  }
  const tokens = j.usage?.input_tokens;
  return {
    // fallback: an endpoint that omits the model is reported as the model requested.
    model: typeof j.model === "string" ? j.model : requested,
    answers: j.answers as Record<string, Answer>,
    // fallback: no usage block counts as zero tokens rather than failing the answers.
    inputTokens: typeof tokens === "number" ? tokens : 0,
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
