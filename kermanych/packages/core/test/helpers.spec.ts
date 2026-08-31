import { expect, test } from "vitest";
import { DEFAULT_HELPERS, expandHelpers, prependHelper } from "../src/helpers";
import type { HelperDef } from "../src/helpers";
import { isSkillName } from "../src/skills";

const def = (name: string): HelperDef => {
  const hit = DEFAULT_HELPERS.find((h) => h.name === name);
  if (!hit) throw new Error(`no such helper: ${name}`);
  return hit;
};

test("a leading helper token becomes its instruction, with the request kept below it", () => {
  const el10 = def("el10");
  const out = expandHelpers("/el10 що робить цей файл?");
  expect(out.used).toEqual([el10]);
  expect(out.text).toBe(`${el10.body.trim()}\n\nщо робить цей файл?`);
});

test("a keyword helper puts omp's magic word inline in front of the request", () => {
  const deep = def("deep");
  // Inline and space-separated on purpose: omp only recognises a magic keyword as
  // standalone prose, so a `key: value` or glued spelling would silently do nothing.
  expect(expandHelpers("/deep полагодь баг").text).toBe(`${deep.body} полагодь баг`);
});

test("a run of helpers expands in the order written, instructions above the keyword line", () => {
  const out = expandHelpers("/prove /deep /small полагодь баг");
  expect(out.used.map((h) => h.name)).toEqual(["prove", "deep", "small"]);
  expect(out.text).toBe(
    `${def("prove").body.trim()}\n\n${def("small").body.trim()}\n\n${def("deep").body} полагодь баг`,
  );
});

test("expansion stops at the first token that is not a helper", () => {
  const out = expandHelpers("/el10 /nope /deep що це?");
  expect(out.used.map((h) => h.name)).toEqual(["el10"]);
  // Everything from the unknown token on is the operator's text, verbatim.
  expect(out.text).toBe(`${def("el10").body.trim()}\n\n/nope /deep що це?`);
});

test("only a whole token bounded by whitespace expands, so paths and words are untouched", () => {
  for (const text of [
    "/usr/bin/env node",
    "/Users/me/x.ts треба глянути",
    "/el10/deep",
    "/el10x",
    "/deeper за це",
    "/EL10 що це?",
    "/ el10",
    "спочатку /el10, потім решта",
    "полагодь баг",
    "",
  ]) {
    const out = expandHelpers(text);
    expect(out.used).toEqual([]);
    expect(out.text).toBe(text);
  }
});

test("a helper invoked with no request of its own expands to just its instruction", () => {
  const out = expandHelpers("/grill-me");
  expect(out.used.map((h) => h.name)).toEqual(["grill-me"]);
  expect(out.text).toBe(def("grill-me").body.trim());
});

test("the same helper twice costs one copy", () => {
  const out = expandHelpers("/el10 /el10 що це?");
  expect(out.used.map((h) => h.name)).toEqual(["el10"]);
  expect(out.text).toBe(`${def("el10").body.trim()}\n\nщо це?`);
});

test("every shipped helper is invocable and describable", () => {
  expect(DEFAULT_HELPERS.length).toBeGreaterThan(0);
  const names = DEFAULT_HELPERS.map((h) => h.name);
  expect(new Set(names).size).toBe(names.length);
  for (const h of DEFAULT_HELPERS) {
    // The token grammar IS the skill-name grammar: one boundary, one source of truth.
    expect(isSkillName(h.name)).toBe(true);
    expect(h.label.trim()).not.toBe("");
    expect(h.hint.trim()).not.toBe("");
    expect(h.body.trim()).not.toBe("");
    // A keyword helper's body is handed to omp's magic-keyword matcher, which only fires on
    // an exact lowercase standalone word. Anything else is a helper that quietly does nothing.
    if (h.kind === "keyword") expect(h.body).toMatch(/^[a-z]+$/);
  }
});


test("picking a helper puts its token at the front of the draft, not at the caret", () => {
  // The expander only reads a LEADING run, so an insertion anywhere else would look like it
  // worked and do nothing.
  expect(prependHelper("полагодь баг", "el10")).toBe("/el10 полагодь баг");
  expect(prependHelper("", "el10")).toBe("/el10 ");
  expect(prependHelper("/deep полагодь баг", "small")).toBe("/small /deep полагодь баг");
});

test("picking a helper the draft already carries changes nothing", () => {
  expect(prependHelper("/el10 що це?", "el10")).toBe("/el10 що це?");
  expect(prependHelper("/deep /el10 що це?", "el10")).toBe("/deep /el10 що це?");
  // Past the leading run it is ordinary text, so the token still belongs at the front.
  expect(prependHelper("порівняй з /el10", "el10")).toBe("/el10 порівняй з /el10");
});