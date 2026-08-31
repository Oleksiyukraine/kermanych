// apps/api/test/create-guards.spec.ts
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AuthService } from "../src/auth/auth.service";
import type { CloudProject, Task } from "@kermanych/cloud";
import { stubSkills } from "./skills-stub";
import { WorktreeService } from "../src/worktree/worktree.service";

// `from-task` is the only birth path of an agent session, so these launch guards are now
// reached through a cloud card. Same wholesale mock as sessions.from-task.spec.ts (no
// importOriginal), so this unit test never needs packages/cloud built.
const cloudTasks = new Map<string, Task>();
const cloudProjects: CloudProject[] = [];
vi.mock("@kermanych/cloud", () => ({
  getTask: async (_client: unknown, taskId: string) => cloudTasks.get(taskId),
  claimTask: async (_client: unknown, taskId: string, userId: string) => {
    const t = cloudTasks.get(taskId);
    if (!t || t.assigneeId) return undefined;
    const next: Task = { ...t, assigneeId: userId };
    cloudTasks.set(taskId, next);
    return next;
  },
  patchTask: async (_client: unknown, taskId: string, patch: { assigneeId?: string | null }) => {
    const t = cloudTasks.get(taskId);
    if (!t) throw new Error("task not found");
    const next: Task = { ...t, assigneeId: patch.assigneeId ?? undefined };
    cloudTasks.set(taskId, next);
    return next;
  },
  listProjects: async () => cloudProjects,
}));

import { RegistryService } from "../src/registry/registry.service";
import { SupervisorService } from "../src/supervisor/supervisor.service";

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", args, { cwd, encoding: "utf8" });

const USER = "11111111-1111-1111-1111-111111111111";
const PROJECT = "p1";
const NOW = "2026-08-21T10:00:00.000Z";

// A card already assigned to the runner: no claim to win or roll back, so the guard under
// test is the only thing that can reject. `createdBy: USER` is what keeps the in-place
// option alive — createSessionFromTask forces a worktree for anybody else, so an in-place
// card filed by somebody else would never reach the guards below at all.
function cloudTask(over: Partial<Task> = {}): Task {
  const t: Task = {
    id: "task-1",
    projectId: PROJECT,
    title: "n",
    description: "t",
    status: "backlog",
    assigneeId: USER,
    createdBy: USER,
    createdAt: NOW,
    updatedAt: NOW,
    worktree: true,
    ...over,
  };
  cloudTasks.set(t.id, t);
  return t;
}

// The launch path only forwards this client to @kermanych/cloud, which is mocked above.
const signedIn = {
  current: () => ({ userId: USER, accessToken: "token" }),
  cloudClient: () => ({}),
} as unknown as AuthService;

const wt = new WorktreeService();
let repo: string;
let reg: RegistryService;
let sup: SupervisorService;

beforeEach(() => {
  cloudTasks.clear();
  cloudProjects.length = 0;
  repo = mkdtempSync(join(tmpdir(), "kmq-guard-"));
  execFileSync("git", ["-c", "init.defaultBranch=dev", "init", "-q"], { cwd: repo });
  git(repo, "config", "user.email", "t@t");
  git(repo, "config", "user.name", "t");
  writeFileSync(join(repo, "file.txt"), "base\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "base");
  reg = new RegistryService(":memory:");
  sup = new SupervisorService(reg, wt, signedIn, stubSkills());
});
afterEach(() => rmSync(repo, { recursive: true, force: true }));

test("in-place create is refused on a dirty project tree and creates nothing", async () => {
  const g = reg.upsertProject({ id: PROJECT, name: "g", localRepoPath: repo });
  writeFileSync(join(repo, "dirty.txt"), "x\n"); // uncommitted
  cloudTask({ worktree: false, projectId: g.id });

  await expect(sup.createSessionFromTask("task-1", USER)).rejects.toThrow(/clean/i);
  expect(reg.listSessions(g.id)).toHaveLength(0);
  expect(git(repo, "branch", "--show-current").trim()).toBe("dev"); // branch untouched
});

test("in-place create is refused when one is already active in the project", async () => {
  const g = reg.upsertProject({ id: PROJECT, name: "g", localRepoPath: repo });
  reg.createSession({
    projectId: g.id, name: "a", task: "t", worktreePath: "", branch: "feature/a",
    worktree: false, baseBranch: "dev", status: "thinking",
  });
  cloudTask({ worktree: false, projectId: g.id });

  await expect(sup.createSessionFromTask("task-1", USER)).rejects.toThrow(/already active/i);
});

test("in-place create is refused on a detached HEAD", async () => {
  const g = reg.upsertProject({ id: PROJECT, name: "g", localRepoPath: repo });
  const head = git(repo, "rev-parse", "HEAD").trim();
  git(repo, "checkout", "-q", head); // detached
  cloudTask({ worktree: false, projectId: g.id });

  await expect(sup.createSessionFromTask("task-1", USER)).rejects.toThrow(/detached/i);
});

test("worktree create failure on a pre-existing branch does not delete that branch", async () => {
  const g = reg.upsertProject({ id: PROJECT, name: "g", localRepoPath: repo });
  // Pre-create a foreign branch whose name equals the one the launch derives for the card
  // title "collide" (feature/collide), with a commit that must survive.
  git(repo, "branch", "feature/collide");
  cloudTask({ title: "collide", projectId: g.id });

  await expect(sup.createSessionFromTask("task-1", USER)).rejects.toThrow();
  expect(git(repo, "branch", "--list", "feature/collide").trim()).toContain("feature/collide");
  expect(reg.listSessions(g.id)).toHaveLength(0);
});
