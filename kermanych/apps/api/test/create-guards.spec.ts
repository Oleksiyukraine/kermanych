// apps/api/test/create-guards.spec.ts
import { afterEach, beforeEach, expect, test } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RegistryService } from "../src/registry/registry.service";
import { offlineAuth } from "./offline-auth";
import { WorktreeService } from "../src/worktree/worktree.service";
import { SupervisorService } from "../src/supervisor/supervisor.service";

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", args, { cwd, encoding: "utf8" });

const wt = new WorktreeService();
let repo: string;
let reg: RegistryService;
let sup: SupervisorService;

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "kmq-guard-"));
  execFileSync("git", ["-c", "init.defaultBranch=dev", "init", "-q"], { cwd: repo });
  git(repo, "config", "user.email", "t@t");
  git(repo, "config", "user.name", "t");
  writeFileSync(join(repo, "file.txt"), "base\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "base");
  reg = new RegistryService(":memory:");
  sup = new SupervisorService(reg, wt, offlineAuth());
});
afterEach(() => rmSync(repo, { recursive: true, force: true }));

test("in-place create is refused on a dirty project tree and creates nothing", async () => {
  const g = reg.upsertProject({ id: "p1", name: "g", localRepoPath: repo });
  writeFileSync(join(repo, "dirty.txt"), "x\n"); // uncommitted
  await expect(sup.createSession(g.id, "n", "t", undefined, undefined, false)).rejects.toThrow(/clean/i);
  expect(reg.listSessions(g.id)).toHaveLength(0);
  expect(git(repo, "branch", "--show-current").trim()).toBe("dev"); // branch untouched
});

test("in-place create is refused when one is already active in the project", async () => {
  const g = reg.upsertProject({ id: "p1", name: "g", localRepoPath: repo });
  reg.createSession({
    projectId: g.id, name: "a", task: "t", worktreePath: "", branch: "feature/a",
    worktree: false, baseBranch: "dev", status: "thinking",
  });
  await expect(sup.createSession(g.id, "n", "t", undefined, undefined, false)).rejects.toThrow(/already active/i);
});

test("in-place create is refused on a detached HEAD", async () => {
  const g = reg.upsertProject({ id: "p1", name: "g", localRepoPath: repo });
  const head = git(repo, "rev-parse", "HEAD").trim();
  git(repo, "checkout", "-q", head); // detached
  await expect(sup.createSession(g.id, "n", "t", undefined, undefined, false)).rejects.toThrow(/detached/i);
});

test("worktree create failure on a pre-existing branch does not delete that branch", async () => {
  const g = reg.upsertProject({ id: "p1", name: "g", localRepoPath: repo });
  // Pre-create a foreign branch whose name equals the one createSession will derive
  // for name "collide" (feature/collide), with a commit that must survive.
  git(repo, "branch", "feature/collide");
  await expect(sup.createSession(g.id, "collide", "t")).rejects.toThrow();
  expect(git(repo, "branch", "--list", "feature/collide").trim()).toContain("feature/collide");
  expect(reg.listSessions(g.id)).toHaveLength(0);
});
