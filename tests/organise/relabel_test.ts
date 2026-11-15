import { assertEquals, assertThrows } from "@std/assert";
import { choiceScheme } from "../../lib/organise/choice.ts";
import { relabelPlan } from "../../lib/organise/relabel.ts";
import type { SchemeDecision } from "../../lib/organise/scheme.ts";
import { triageScheme } from "../../lib/organise/triage/scheme.ts";

const at = (y: number, m = 5) => String(Date.UTC(y, m, 1));
const dec = (id: string, category: string, scheme = "triage"): SchemeDecision => ({
  id,
  scheme,
  category,
  route: "r",
  why: "",
  sender: "",
  subject: "",
});
const topic = (labelPattern: string) =>
  choiceScheme({
    id: "topic",
    question: { id: "topic", instructions: "?", options: { garden: "", house: "", none: "" } },
    labelPattern,
    unlabelled: ["none"],
  });

Deno.test("relabelPlan: by year then category order, other labels removed in the same group", () => {
  const msgs = [
    { id: "c", internalDate: at(2021) },
    { id: "b", internalDate: at(2020) },
    { id: "a", internalDate: at(2020) },
    { id: "d", internalDate: at(2020) },
  ];
  const plan = relabelPlan(
    triageScheme(),
    [dec("c", "keep"), dec("b", "delete"), dec("d", "important"), dec("a", "delete")],
    msgs,
  );
  assertEquals(plan, [
    {
      add: "organiser/2020/delete",
      remove: ["organiser/2020/defer", "organiser/2020/important", "organiser/2020/keep"],
      ids: ["a", "b"],
    },
    {
      add: "organiser/2020/important",
      remove: ["organiser/2020/defer", "organiser/2020/delete", "organiser/2020/keep"],
      ids: ["d"],
    },
    {
      add: "organiser/2021/keep",
      remove: ["organiser/2021/defer", "organiser/2021/delete", "organiser/2021/important"],
      ids: ["c"],
    },
  ]);
});

Deno.test("relabelPlan: without {year}, one group per category across years", () => {
  const msgs = [{ id: "a", internalDate: at(2019) }, { id: "b", internalDate: at(2024) }];
  const plan = relabelPlan(topic("topic/{category}"), [
    dec("a", "garden", "topic"),
    dec("b", "garden", "topic"),
  ], msgs);
  assertEquals(plan, [{ add: "topic/garden", remove: ["topic/house"], ids: ["a", "b"] }]);
  const yearly = relabelPlan(topic("topic/{year}/{category}"), [
    dec("a", "garden", "topic"),
    dec("b", "garden", "topic"),
  ], msgs);
  assertEquals(yearly.map((g) => g.add), ["topic/2019/garden", "topic/2024/garden"]);
});

Deno.test("relabelPlan: an unlabelled category only removes; other schemes are ignored", () => {
  const msgs = [{ id: "a", internalDate: at(2020) }];
  const plan = relabelPlan(
    topic("topic/{category}"),
    [dec("a", "none", "topic"), dec("a", "keep")],
    msgs,
  );
  assertEquals(plan, [{ remove: ["topic/garden", "topic/house"], ids: ["a"] }]);
  assertEquals("add" in plan[0], false);
});

Deno.test("relabelPlan: refuses a decision it cannot place", () => {
  assertThrows(() => relabelPlan(triageScheme(), [dec("x", "keep")], []), Error, "no message x");
  assertThrows(
    () => relabelPlan(triageScheme(), [dec("a", "archive")], [{ id: "a", internalDate: at(2020) }]),
    Error,
    "archive",
  );
});
