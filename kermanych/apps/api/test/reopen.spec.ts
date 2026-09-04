// apps/api/test/reopen.spec.ts
import { afterEach, beforeEach, expect, test } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RegistryService } from "../src/registry/registry.service";
import { offlineAuth } from "./offline-auth";
import { stubSkills } from "./skills-stub";
import { WorktreeService } from "../src/worktree/worktree.service";
import { SupervisorService } from "../src/supervisor/supervisor.service";

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", args, { cwd, encoding: "utf8" });

const wt = new WorktreeService();
let repo: string;
let reg: RegistryService;
let sup: SupervisorService;
let trash: string[];

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "kmq-reopen-"));
  trash = [repo];
  execFileSync("git", ["-c", "init.defaultBranch=dev", "init", "-q"], { cwd: repo });
  git(repo, "config", "user.email", "t@t");
  git(repo, "config", "user.name", "t");
  writeFileSync(join(repo, "file.txt"), "base\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "base");
  reg = new RegistryService(":memory:");
  sup = new SupervisorService(reg, wt, offlineAuth(), stubSkills());
});
afterEach(() => {
  for (const d of trash) rmSync(d, { recursive: true, force: true });
});

// A worktree agent that has been finished: worktree retired, branch kept, status "merged".
async function seedMerged(): Promise<string> {
  const g = reg.upsertProject({ id: "p1", name: "g", localRepoPath: repo });
  const parent = mkdtempSync(join(tmpdir(), "kmq-reopen-wt-"));
  trash.push(parent);
  const wtDir = join(parent, "wt");
  await wt.addWorktree(repo, wtDir, "feature/task-one", "dev");
  writeFileSync(join(wtDir, "feature.txt"), "hi\n");
  git(wtDir, "add", "-A");
  git(wtDir, "commit", "-q", "-m", "feature");
  const s = reg.createSession({
    projectId: g.id, name: "task one", task: "t", worktreePath: wtDir, branch: "feature/task-one", baseBranch: "dev",
  });
  await sup.finishSession(s.id);
  const merged = reg.listSessions().find((x) => x.id === s.id)!;
  expect(merged.status).toBe("merged");
  expect(merged.worktreePath).toBe("");
  return s.id;
}

test("resuming a finished (worktree-retired) session is refused, never resurrecting it in the project dir", async () => {
  const id = await seedMerged();

  await expect(sup.restartSession(id)).rejects.toThrow(/reopen/i);

  const s = reg.listSessions().find((x) => x.id === id)!;
  expect(s.status).toBe("merged"); // not flipped to "done"
  expect(s.worktreePath).toBe(""); // no project-dir worktree conjured
});

test("finishInfo refuses a worktree session that has no worktree", async () => {
  const id = await seedMerged();
  await expect(sup.finishInfo(id)).rejects.toThrow(/no worktree/i);
});

test("reopenSession brings the worktree back on the session's own branch and re-queues it", async () => {
  const id = await seedMerged();

  const re = await sup.reopenSession(id);
  trash.push(re.worktreePath); // worktreeDir lives under $HOME/.kermanych — clean it up

  expect(re.worktreePath).not.toBe("");
  expect(existsSync(re.worktreePath)).toBe(true); // worktree re-created
  expect(re.status).toBe("done");
  expect(re.branch).toBe("feature/task-one"); // the same branch — its PR points at it
  // Which still carries the session's own work, PR merged or not:
  expect(existsSync(join(re.worktreePath, "feature.txt"))).toBe(true);
  // Finish is possible again now that the worktree is back:
  const info = await sup.finishInfo(id);
  expect(info.branch).toBe("feature/task-one");
});

// Rows retired before finish kept branches have none left; that one forks afresh off the base.
test("reopenSession forks the branch afresh off the base when the session's branch is gone", async () => {
  const id = await seedMerged();
  git(repo, "branch", "-D", "feature/task-one");

  const re = await sup.reopenSession(id);
  trash.push(re.worktreePath);

  // The name is re-derived (nothing occupies it any more), but the ref is a fresh fork:
  expect(git(repo, "branch", "--list", re.branch).trim()).not.toBe("");
  expect(git(repo, "rev-parse", re.branch).trim()).toBe(git(repo, "rev-parse", "dev").trim());
  expect(existsSync(join(re.worktreePath, "feature.txt"))).toBe(false); // forked from bare dev
});

test("reopenSession refuses a session that still owns a worktree", async () => {
  const g = reg.upsertProject({ id: "p1", name: "g2", localRepoPath: repo });
  const parent = mkdtempSync(join(tmpdir(), "kmq-reopen-live-"));
  trash.push(parent);
  const wtDir = join(parent, "wt");
  await wt.addWorktree(repo, wtDir, "feature/live", "dev");
  const s = reg.createSession({
    projectId: g.id, name: "live one", task: "t", worktreePath: wtDir, branch: "feature/live", baseBranch: "dev",
  });
  await expect(sup.reopenSession(s.id)).rejects.toThrow(/already has a worktree/i);
});
