import { assert, assertEquals, assertRejects } from "@std/assert";
import { withRetry } from "../../lib/organise/throttle.ts";

/** The first wait withRetry chooses for an error, read from onRetry, which fires before the sleep. */
async function firstWait(
  err: unknown,
  opts: Parameters<typeof withRetry>[1] = {},
): Promise<number> {
  let wait = -1;
  await assertRejects(
    () =>
      withRetry(() => Promise.reject(err), {
        ...opts,
        onRetry: (_, ms) => {
          wait = ms;
          throw new Error("stop before sleeping");
        },
      }),
    Error,
    "stop before sleeping",
  );
  return wait;
}

const quota = Object.assign(new Error("429 Too Many Requests"), { status: 429 });
const server = Object.assign(new Error("503"), { status: 503 });

Deno.test("withRetry: a quota refusal waits from 8000 ms by default", async () => {
  const w = await firstWait(quota);
  assert(w >= 8000 && w < 16000, `default quota wait ${w}`);
});

Deno.test("withRetry: quotaBaseMs moves only the quota wait", async () => {
  const q = await firstWait(quota, { quotaBaseMs: 5 });
  assert(q >= 5 && q < 10, `quota wait ${q}`);
  const s = await firstWait(server, { quotaBaseMs: 5, baseMs: 100 });
  assert(s >= 100 && s < 200, `server wait ${s}`);
});

Deno.test("withRetry: a non-retryable error is thrown at once", async () => {
  let calls = 0;
  const bad = Object.assign(new Error("400"), { status: 400 });
  await assertRejects(() => withRetry(() => (calls++, Promise.reject(bad))), Error, "400");
  assertEquals(calls, 1);
});
