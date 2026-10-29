import { expect, test } from "vitest";
import { slugify, branchName, uniqueSlug, taskNameFromText, isGitBranchName, BRANCH_PREFIXES } from "../src/worktree-names";
test("slugify lowercases and dashes", () => {
  expect(slugify("Fix Login Bug!")).toBe("fix-login-bug");
});
test("slugify transliterates Ukrainian Cyrillic", () => {
  expect(slugify("Виправити баг логіну")).toBe("vypravyty-bah-lohinu");
});
test("slugify falls back to session for symbol-only names", () => {
  expect(slugify("!!!")).toBe("session");
});
test("slugify drops the partial last word at the 40-character cap", () => {
  expect(slugify("Зробити автоматичне генерування назви гілки з контексту задачі")).toBe(
    "zrobyty-avtomatychne-heneruvannia-nazvy",
  );
});
test("slugify keeps a whole word that ends exactly at the cap", () => {
  // 40 characters, then a dash: nothing of the last word is cut.
  expect(slugify("aaaaaaaaa bbbbbbbbb ccccccccc dddddddddd eee")).toBe("aaaaaaaaa-bbbbbbbbb-ccccccccc-dddddddddd");
});
test("slugify slices a single word longer than the cap", () => {
  expect(slugify("x".repeat(50))).toBe("x".repeat(40));
});
test("branchName defaults to the feature prefix", () => {
  expect(branchName("fix-login")).toBe("feature/fix-login");
});
test("branchName uses the given prefix", () => {
  expect(branchName("fix-login", "fix")).toBe("fix/fix-login");
});
test("BRANCH_PREFIXES lists the allowed prefixes", () => {
  expect([...BRANCH_PREFIXES]).toEqual(["feature", "fix", "refactoring", "chore", "design"]);
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
// A base branch reaches `git fetch origin <base>` and the agent's own commands; a project's
// default branch is typed by a person and shared through the cloud.
test("isGitBranchName accepts the names git takes as branches", () => {
  for (const name of ["dev", "main", "release/2.0", "feature/x-y_z", "гілка"]) expect(isGitBranchName(name), name).toBe(true);
});
test("isGitBranchName refuses options, refspecs and revision expressions", () => {
  for (const name of [
    "", "-x", "--upload-pack=touch /tmp/x", "a:b", "a b", "a~1", "a^", "@{-1}", "@", "HEAD", "a..b",
    "a?", "a*", "a[b", "a\\b", "a\tb", "x.lock", "a/x.lock/b", ".x", "a/.x", "/a", "a/", "a//b", "a.",
  ]) expect(isGitBranchName(name), JSON.stringify(name)).toBe(false);
});
