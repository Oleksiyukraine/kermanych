import { expect, test } from "vitest";
import { parseEnv, applyEnvEdits } from "../src/env/env-text";

test("parseEnv reads KEY=value, skips comments/blank/invalid, unquotes", () => {
  const text = `# comment\n\nA=1\nB="two words"\nGITHUB_TOKEN=ghp_x\nnot a var\n123=bad\n`;
  expect(parseEnv(text)).toEqual([
    { key: "A", value: "1" },
    { key: "B", value: "two words" },
    { key: "GITHUB_TOKEN", value: "ghp_x" },
  ]);
});

test("applyEnvEdits updates in place preserving comments/order", () => {
  const text = `# top\nA=1\nB=2\n`;
  expect(applyEnvEdits(text, { set: { B: "9" } })).toBe(`# top\nA=1\nB=9\n`);
});

test("applyEnvEdits appends new keys and removes requested keys", () => {
  const text = `A=1\nB=2\n`;
  expect(applyEnvEdits(text, { set: { C: "3" }, remove: ["A"] })).toBe(`B=2\nC=3\n`);
});

test("applyEnvEdits quotes values with whitespace or shell specials", () => {
  expect(applyEnvEdits("", { set: { U: "a b", Q: "x&y" } })).toBe(`U="a b"\nQ="x&y"\n`);
});

test("applyEnvEdits escapes embedded quote/backslash", () => {
  expect(applyEnvEdits("", { set: { P: 'a"b\\c' } })).toBe(`P="a\\"b\\\\c"\n`);
});
