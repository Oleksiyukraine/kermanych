// tests/worktree.test.ts
import { expect, test } from "bun:test";
import { slugify, branchName, uniqueSlug } from "../src/server/worktree";
test("slugify lowercases and dashes", () => {
  expect(slugify("Fix Login Bug!")).toBe("fix-login-bug");
});
test("branchName prefixes maestro/", () => {
  expect(branchName("fix-login")).toBe("maestro/fix-login");
});
test("uniqueSlug suffixes on collision", () => {
  expect(uniqueSlug("fix", new Set(["fix", "fix-2"]))).toBe("fix-3");
  expect(uniqueSlug("fix", new Set())).toBe("fix");
});
