// apps/api/test/worktree.spec.ts
import { afterEach, beforeEach, expect, test } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorktreeService } from "../src/worktree/worktree.service";

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", args, { cwd, encoding: "utf8" });

const wt = new WorktreeService();
let repo: string;

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "kmq-wt-"));
  execFileSync("git", ["-c", "init.defaultBranch=dev", "init", "-q"], { cwd: repo });
  git(repo, "config", "user.email", "t@t");
  git(repo, "config", "user.name", "t");
  writeFileSync(join(repo, "file.txt"), "base\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "base");
});
afterEach(() => rmSync(repo, { recursive: true, force: true }));

test("createBranchHere creates and switches to the branch in place", async () => {
  await wt.createBranchHere(repo, "feature/x");
  expect(git(repo, "branch", "--show-current").trim()).toBe("feature/x");
});

test("checkout switches branches; force checkout discards uncommitted work", async () => {
  await wt.createBranchHere(repo, "feature/x");
  writeFileSync(join(repo, "file.txt"), "dirty\n"); // uncommitted change on the branch
  await wt.checkout(repo, "dev", { force: true });
  expect(git(repo, "branch", "--show-current").trim()).toBe("dev");
  expect(git(repo, "show", "dev:file.txt").trim()).toBe("base"); // discarded
});

test("diff captures the branch's committed and uncommitted changes from the fork point", async () => {
  await wt.createBranchHere(repo, "feature/x");
  writeFileSync(join(repo, "file.txt"), "base\ncommitted\n");
  git(repo, "commit", "-aqm", "committed work");
  writeFileSync(join(repo, "file.txt"), "base\ncommitted\nuncommitted\n");

  const out = await wt.diff(repo, "dev");

  expect(out).toContain("+committed");
  expect(out).toContain("+uncommitted");
});

test("diff shows only the branch's own changes, not commits the base gained after forking", async () => {
  await wt.createBranchHere(repo, "feature/x");
  writeFileSync(join(repo, "file.txt"), "base\nfeature\n");
  git(repo, "commit", "-aqm", "feature work");
  await wt.checkout(repo, "dev");
  writeFileSync(join(repo, "other.txt"), "base-only\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "base moves on");
  await wt.checkout(repo, "feature/x");

  const out = await wt.diff(repo, "dev");

  expect(out).toContain("+feature");
  expect(out).not.toContain("base-only");
});
