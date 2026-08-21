import { expect, test } from "vitest";
import { slugify, branchName, uniqueSlug, taskNameFromText, BRANCH_PREFIXES } from "../src/worktree-names";
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
test("taskNameFromText takes the first non-empty line", () => {
  expect(taskNameFromText("\n\n  Додати експорт у CSV  \nа ще подумати про фільтри")).toBe(
    "Додати експорт у CSV",
  );
});
test("taskNameFromText strips markdown decoration", () => {
  expect(taskNameFromText("## 1. **Полагодити** `логін`")).toBe("Полагодити логін");
});
test("taskNameFromText caps the name at 60 characters", () => {
  expect(taskNameFromText("я".repeat(80))).toBe("я".repeat(60));
});
test("taskNameFromText returns empty for blank text so callers can fall back", () => {
  expect(taskNameFromText("   \n\n ")).toBe("");
});
