/**
 * Triage a month of received mail with the library, without the CLI, and show
 * what would be labelled. A dry run: nothing in Gmail changes.
 *
 *   deno run --allow-net --allow-read --allow-write --allow-env examples/organise-triage.ts
 *
 * Needs a prior `deno task cli login` (read grant) and TYPESAFE_API_KEY. The
 * organiser itself reads no environment: every path, client and key is passed in.
 */

import { FileTokenStore, GmailClient, loadClientSecretFile } from "@simtricity-commons/gmail-api";
import { Organiser, SystemOneJudge } from "@simtricity-commons/gmail-api/organise";

const home = Deno.env.get("HOME")!;
const gmail = await GmailClient.fromStore({
  clientSecret: await loadClientSecretFile(`${home}/.simt/gmail-api/client-secret.json`),
  store: new FileTokenStore({ path: `${home}/.simt/gmail-api/credentials.json` }),
});

const org = await Organiser.open(`${home}/.simt/gmail-api/organise`, {
  gmail,
  judge: new SystemOneJudge({ apiKey: Deno.env.get("TYPESAFE_API_KEY")! }),
  log: (line) => console.error(line),
});

await org.capture({ source: "sent" }); // who you write to, from sent-mail metadata
await org.corpus();
await org.sample({ run: "example", query: "newer_than:30d", size: 50 });
await org.fetch({ run: "example" });
await org.judge({ run: "example" });
const decided = await org.decide({ run: "example" });
console.log(decided.triage.counts);

const plan = await org.apply({ run: "example", scheme: "triage" }); // no writer: a dry run
console.log(plan.toCreate, plan.moves);
