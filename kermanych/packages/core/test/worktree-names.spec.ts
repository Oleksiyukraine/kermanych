import { expect, test } from "vitest";
import { slugify, branchName, uniqueSlug } from "../src/worktree-names";
test("slugify lowercases and dashes", () => {
  expect(slugify("Fix Login Bug!")).toBe("fix-login-bug");
});
test("branchName prefixes kermanych/", () => {
  expect(branchName("fix-login")).toBe("kermanych/fix-login");
});
test("uniqueSlug suffixes on collision", () => {
  expect(uniqueSlug("fix", new Set(["fix", "fix-2"]))).toBe("fix-3");
  expect(uniqueSlug("fix", new Set())).toBe("fix");
});
