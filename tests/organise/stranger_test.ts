/**
 * A stranger's first run: the shipped example profile, no rulings, no golden
 * set, from a sent capture to a dry-run apply on the synthetic mailbox.
 */
import { assert, assertEquals } from "@std/assert";
import { Organiser, SystemOneJudge } from "../../organise.ts";
import { SCOPE_READONLY } from "../../mod.ts";
import { FakeJev, FakeMailbox } from "./fakes.ts";
import { FLAKY, NOW, RECEIVED, SENT } from "./fixtures.ts";

Deno.test("stranger: the example profile runs end to end, and the dry run writes nothing", async () => {
  const dir = await Deno.makeTempDir({ prefix: "organise-stranger-" });
  await Deno.copyFile(
    new URL("../../examples/organise/profile.json", import.meta.url),
    `${dir}/profile.json`,
  );
  const mailbox = new FakeMailbox([...SENT, ...RECEIVED], FLAKY);
  const org = await Organiser.open(dir, {
    gmail: mailbox.client(SCOPE_READONLY),
    judge: new SystemOneJudge({ apiKey: "k", fetch: new FakeJev().fetch, retryBaseMs: 1 }),
    now: () => NOW,
    pacing: { readsPerSecond: 1000, quotaRetryMs: 5 },
  });
  assertEquals([org.profile.schemes.map((s) => s.id), org.golden], [["triage"], []]);

  await org.capture({ source: "sent" });
  await org.corpus();
  await org.sample({ run: "first", year: 2020, size: 50 });
  const f = await org.fetch({ run: "first" });
  assertEquals(f.failures, 0);
  const j = await org.judge({ run: "first" });
  assertEquals(j.failures, 0);
  const { triage } = await org.decide({ run: "first" });
  const total = Object.values(triage.counts).reduce((a, b) => a + b, 0);
  assertEquals(total, f.fetched);

  const writes = mailbox.writes().length;
  const plan = await org.apply({ run: "first", scheme: "triage" });
  assertEquals([plan.dryRun, plan.calls, plan.unchanged], [true, 0, 0]);
  assert(plan.toCreate.every((l) => l.startsWith("organiser/2020/")));
  assertEquals(Object.values(plan.moves).reduce((a, b) => a + b, 0), total);
  assertEquals(mailbox.writes().length, writes, "a dry run writes nothing");
  await Deno.remove(dir, { recursive: true });
});
