import { expect, test } from "vitest";
import { slugify, branchName, uniqueSlug, BRANCH_PREFIXES } from "../src/worktree-names";
test("slugify lowercases and dashes", () => {
  expect(slugify("Fix Login Bug!")).toBe("fix-login-bug");
});
test("slugify transliterates Ukrainian Cyrillic", () => {
  expect(slugify("Виправити баг логіну")).toBe("vypravyty-bah-lohinu");
});
test("slugify falls back to session for symbol-only names", () => {
  expect(slugify("!!!")).toBe("session");
});
test("branchName defaults to the feature prefix", () => {
  expect(branchName("fix-login")).toBe("feature/fix-login");
});
test("branchName uses the given prefix", () => {
  expect(branchName("fix-login", "fix")).toBe("fix/fix-login");
});
test("BRANCH_PREFIXES lists the four allowed prefixes", () => {
  expect([...BRANCH_PREFIXES]).toEqual(["feature", "fix", "refactoring", "chore"]);
});
test("uniqueSlug suffixes on collision", () => {
  expect(uniqueSlug("fix", new Set(["fix", "fix-2"]))).toBe("fix-3");
  expect(uniqueSlug("fix", new Set())).toBe("fix");
});
