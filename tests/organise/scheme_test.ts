import { assertEquals, assertThrows } from "@std/assert";
import { labelFor, labelPrefixOf, ProfileError } from "../../lib/organise/scheme.ts";

Deno.test("labelFor: the message's own UTC year, {verdict} as an alias of {category}", () => {
  const lastMinute = String(Date.UTC(2020, 11, 31, 23, 30));
  const firstMinute = String(Date.UTC(2021, 0, 1, 0, 30));
  assertEquals(labelFor("sorted/{year}/{category}", lastMinute, "keep"), "sorted/2020/keep");
  assertEquals(labelFor("sorted/{year}/{category}", firstMinute, "keep"), "sorted/2021/keep");
  assertEquals(labelFor("sorted/{year}/{verdict}", firstMinute, "defer"), "sorted/2021/defer");
  assertEquals(labelFor("sorted/{category}", "not a date", "x"), "sorted/x");
  assertEquals(labelFor("sorted/{year}/{category}", "not a date", "x"), "sorted/1970/x");
});

Deno.test("labelPrefixOf: the literal text before the first placeholder", () => {
  assertEquals(labelPrefixOf("organiser/{year}/{verdict}"), "organiser/");
  assertEquals(labelPrefixOf("project/{category}"), "project/");
  assertEquals(labelPrefixOf("a/b/{category}/{year}"), "a/b/");
});

Deno.test("labelPrefixOf: refuses a pattern that could label outside its prefix", () => {
  assertThrows(() => labelPrefixOf("project/fixed"), ProfileError, "{category}");
  assertThrows(() => labelPrefixOf("{category}"), ProfileError, "prefix");
  assertThrows(() => labelPrefixOf("project{category}"), ProfileError, "prefix");
  assertThrows(() => labelPrefixOf("p/{category}/{month}"), ProfileError, "unknown placeholder");
});
