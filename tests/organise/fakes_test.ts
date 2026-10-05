/**
 * Proves the fakes behave like Gmail and the decision model, through the real
 * gmail-api 0.6.0 client and writer. Runs today, before `organise` exists:
 *
 *   deno test --config contract/deno.json contract/fakes_test.ts
 *
 * @module
 */

import { assert, assertEquals, assertRejects } from "@std/assert";
import { GmailWriter, GuardedWriter, SCOPE_COMPOSE, SCOPE_MODIFY, SCOPE_READONLY } from "./deps.ts";
import { GmailApiError } from "@simtricity-commons/gmail-api";
import { FakeJev, FakeMailbox } from "./fakes.ts";
import { ANSWERS, FLAKY, RECEIVED, SENT } from "./fixtures.ts";

const WRITE = `${SCOPE_READONLY} ${SCOPE_MODIFY} ${SCOPE_COMPOSE}`;

async function listAll(mailbox: FakeMailbox, q: string): Promise<string[]> {
  const client = mailbox.client(SCOPE_READONLY);
  const out: string[] = [];
  let pageToken: string | undefined;
  do {
    const page = await client.listMessages(q, { maxResults: 500, pageToken });
    out.push(...(page.messages ?? []).map((m) => m.id));
    pageToken = page.nextPageToken;
  } while (pageToken);
  return out;
}

Deno.test("fake Gmail: search operators and paging", async () => {
  const mailbox = new FakeMailbox([...SENT, ...RECEIVED]);
  const year = "-in:sent -in:chats -in:draft after:2020/01/01 before:2021/01/01";
  const received2020 = await listAll(mailbox, year);
  assertEquals(received2020.length, 11, "r1–r12 less the 2021 message");
  assert(!received2020.includes("r8"));
  assertEquals((await listAll(mailbox, "in:sent")).length, SENT.length);
  assertEquals((await listAll(mailbox, "-in:chats -in:draft")).length, SENT.length + RECEIVED.length);
  await assertRejects(() => listAll(mailbox, "in:inbox"), Error, "unsupported search operator");
});

Deno.test("fake Gmail: full and metadata reads, and a quota refusal", async () => {
  const mailbox = new FakeMailbox(RECEIVED, FLAKY);
  const client = mailbox.client(SCOPE_READONLY);
  const meta = await client.getMessage("r1", "metadata");
  assertEquals(meta.payload?.body?.data, undefined);
  const full = await client.getMessage("r1", "full");
  assert(full.payload?.body?.data);

  const e = await assertRejects(() => client.getMessage("r11", "full"), GmailApiError);
  assertEquals((e as GmailApiError).status, 403);
  assertEquals((e as GmailApiError).reason, "rateLimitExceeded");
  assertEquals((await client.getMessage("r11", "full")).id, "r11", "the second read succeeds");
});

Deno.test("fake Gmail: labels and batchModify through the real writer", async () => {
  const mailbox = new FakeMailbox(RECEIVED);
  const writer = new GmailWriter(mailbox.client(WRITE));
  const label = await writer.ensureLabel("organiser/2020/keep");
  assert(mailbox.labelByName("organiser/2020/keep"));
  await writer.batchModifyMessages(["r1", "r2"], { addLabelIds: [label.id] });
  assert(mailbox.labelNames("r1").includes("organiser/2020/keep"));
  assertEquals((await listAll(mailbox, "label:organiser-2020-keep")).sort(), ["r1", "r2"]);

  const guarded = new GuardedWriter(writer);
  const r = await guarded.labelChange({ name: "organiser/2020/keep", ids: ["r3"], apply: true });
  assertEquals(r.applied, true);
  assert(mailbox.writes().every((c) => c.path === "/labels" || c.path === "/messages/batchModify"));
});

Deno.test("fake decision model: answers by subject, throttles on request", async () => {
  const jev = new FakeJev();
  jev.throttleNext = 1;
  const post = (state: unknown) =>
    jev.fetch("https://api.typesafe.ai/v1/systemone", {
      method: "POST",
      headers: { Authorization: "Bearer k", "Content-Type": "application/json" },
      body: JSON.stringify({ state, model: "jev-latest", questions: { is_personal: {}, project: {} } }),
    });
  assertEquals((await post({ subject: "Site visit next week?" })).status, 429);
  const res = await (await post({ subject: "Site visit next week?" })).json();
  assertEquals(res.answers.is_personal.noul, ANSWERS["Site visit next week?"].nouls.is_personal);
  assertEquals(res.answers.project.choice, "alpha");
  assert(res.usage.input_tokens > 0);
  assertEquals(jev.calls[0].authorization, "Bearer k");
});
