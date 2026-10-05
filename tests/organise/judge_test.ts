import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import { SYSTEM_ONE_ENDPOINT, SystemOneError, SystemOneJudge } from "../../lib/organise/judge.ts";
import { FakeJev } from "./contract/fakes.ts";

const KEY = "sk-planted-secret-4f1c";
const SUBJECT = "Planted private subject 9d2e";
const Q = { is_personal: { type: "noul" as const, instructions: "x" } };

/** A fetch that answers from a script, records each call, and echoes the request into error bodies. */
function scripted(script: (n: number, body: string) => Response | Error) {
  const calls: { at: number; init: RequestInit; url: string }[] = [];
  const fetch: typeof globalThis.fetch = (input, init) => {
    calls.push({ at: performance.now(), init: init!, url: String(input) });
    const out = script(calls.length, String(init?.body));
    return out instanceof Error ? Promise.reject(out) : Promise.resolve(out);
  };
  return { fetch, calls };
}

const ok = (answers: unknown = { is_personal: { type: "noul", noul: 0.4 } }) =>
  new Response(JSON.stringify({ model: "jev-test-9", answers, usage: { input_tokens: 42 } }), {
    status: 200,
  });

Deno.test("judge: one POST with the bearer key and { state, model, questions }", async () => {
  const s = scripted(() => ok());
  const judge = new SystemOneJudge({ apiKey: KEY, fetch: s.fetch, model: "jev-x" });
  const r = await judge.ask({ subject: "s" }, Q);
  assertEquals(r, {
    model: "jev-test-9",
    answers: { is_personal: { type: "noul", noul: 0.4 } },
    inputTokens: 42,
  });
  assertEquals(s.calls.length, 1);
  assertEquals(s.calls[0].url, SYSTEM_ONE_ENDPOINT);
  const h = new Headers(s.calls[0].init.headers);
  assertEquals([s.calls[0].init.method, h.get("authorization"), h.get("content-type")], [
    "POST",
    `Bearer ${KEY}`,
    "application/json",
  ]);
  assertEquals(JSON.parse(String(s.calls[0].init.body)), {
    state: { subject: "s" },
    model: "jev-x",
    questions: Q,
  });
});

Deno.test("judge: a 4xx is not retried", async () => {
  const s = scripted(() => new Response("bad", { status: 400 }));
  const judge = new SystemOneJudge({ apiKey: KEY, fetch: s.fetch, retryBaseMs: 1 });
  const e = await assertRejects(() => judge.ask({}, Q), SystemOneError);
  assertEquals([(e as SystemOneError).status, (e as SystemOneError).body, s.calls.length], [
    400,
    "bad",
    1,
  ]);
});

Deno.test("judge: 429 and 5xx are retried `attempts` times, the wait doubling", async () => {
  const s = scripted((n) => new Response("busy", { status: n % 2 ? 503 : 429 }));
  const judge = new SystemOneJudge({ apiKey: KEY, fetch: s.fetch, attempts: 3, retryBaseMs: 25 });
  const e = await assertRejects(() => judge.ask({}, Q), SystemOneError);
  assertEquals([(e as SystemOneError).status, s.calls.length], [503, 3]);
  const [first, second] = [s.calls[1].at - s.calls[0].at, s.calls[2].at - s.calls[1].at];
  assert(first >= 24, `first wait ${first}`);
  assert(second >= 49, `second wait ${second}, doubled`);

  const recovers = scripted((n) => (n < 3 ? new Response("", { status: 502 }) : ok()));
  const r = await new SystemOneJudge({ apiKey: KEY, fetch: recovers.fetch, retryBaseMs: 1 }).ask(
    {},
    Q,
  );
  assertEquals([r.inputTokens, recovers.calls.length], [42, 3]);
});

Deno.test("judge: a network failure is retried, then rethrown as fetch threw it", async () => {
  const s = scripted(() => new TypeError("connection reset"));
  const judge = new SystemOneJudge({ apiKey: KEY, fetch: s.fetch, attempts: 2, retryBaseMs: 1 });
  const e = await assertRejects(() => judge.ask({}, Q), TypeError, "connection reset");
  assert(!(e instanceof SystemOneError));
  assertEquals(s.calls.length, 2);
});

Deno.test("judge: a 2xx that is not an answer set is a SystemOneError", async () => {
  for (
    const body of [
      "not json",
      "null",
      JSON.stringify({ answers: [] }),
      JSON.stringify({ model: "m" }),
    ]
  ) {
    const s = scripted(() => new Response(body, { status: 200 }));
    const e = await assertRejects(
      () => new SystemOneJudge({ apiKey: KEY, fetch: s.fetch }).ask({}, Q),
      SystemOneError,
      "malformed",
    );
    assertEquals([(e as SystemOneError).status, (e as SystemOneError).body], [200, body]);
  }
});

Deno.test("judge: reason is read from a JSON error body", async () => {
  const s = scripted(() =>
    new Response(JSON.stringify({ error: { code: "invalid_key" } }), { status: 401 })
  );
  const e = await assertRejects(
    () => new SystemOneJudge({ apiKey: KEY, fetch: s.fetch }).ask({}, Q),
    SystemOneError,
  );
  assertEquals((e as SystemOneError).reason, "invalid_key");
});

Deno.test("judge: neither the key nor the message text reaches an error message or the object", async () => {
  // Every failure body echoes the request, as a careless server might.
  const statuses: (number | "malformed")[] = [400, 401, 500, "malformed"];
  for (const status of statuses) {
    const s = scripted((_, body) =>
      status === "malformed"
        ? new Response(`<html>${body} ${KEY}</html>`, { status: 200 })
        : new Response(`${body} ${KEY}`, { status })
    );
    const judge = new SystemOneJudge({ apiKey: KEY, fetch: s.fetch, attempts: 1 });
    const e = await assertRejects(() => judge.ask({ subject: SUBJECT }, Q), SystemOneError);
    for (const text of [e.message, String(e), (e as Error).stack ?? "", JSON.stringify(judge)]) {
      assert(!text.includes(KEY), `key leaked at ${status}`);
      assert(!text.includes(SUBJECT), `message text leaked at ${status}`);
    }
  }
  assertEquals(JSON.stringify(new SystemOneJudge({ apiKey: KEY })), `{"model":"jev-latest"}`);
});

Deno.test("judge: no key is refused before any request", () => {
  assertThrows(() => new SystemOneJudge({ apiKey: "" }), TypeError);
});

Deno.test("judge: whoami asks one Noul and reports the endpoint's model", async () => {
  const jev = new FakeJev();
  const r = await new SystemOneJudge({ apiKey: KEY, fetch: jev.fetch }).whoami();
  assertEquals(r.model, "jev-test-1");
  assertEquals(jev.calls[0].questions, ["ok"]);
  assertEquals(typeof r.latencyMs, "number");
});
