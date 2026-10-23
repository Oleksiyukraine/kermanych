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
import { CodedError } from "../src/management/coded-error";

// `from-task` is the only birth path of an agent session, so these launch guards are now
// reached through a cloud card. Same wholesale mock as sessions.from-task.spec.ts (no
// importOriginal), so this unit test never needs packages/cloud built.
const cloudTasks = new Map<string, Task>();
const cloudProjects: CloudProject[] = [];
vi.mock("@kermanych/cloud", () => ({
  getTask: async (_client: unknown, taskId: string) => cloudTasks.get(taskId),
  claimTaskForLaunch: async (_client: unknown, taskId: string, userId: string, from: Task["status"]) => {
    const t = cloudTasks.get(taskId);
    if (!t || t.status !== from || (t.assigneeId && t.assigneeId !== userId)) return undefined;
    const next: Task = { ...t, status: "queued", assigneeId: userId };
    cloudTasks.set(taskId, next);
    return next;
  },
  releaseLaunchClaim: async (_client: unknown, taskId: string, previous: { status: Task["status"]; assigneeId?: string }) => {
    const t = cloudTasks.get(taskId);
    if (!t) throw new Error("task not found");
    cloudTasks.set(taskId, { ...t, status: previous.status, ...(previous.assigneeId ? {} : { assigneeId: undefined }) });
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
    autoRun: false,
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

test("in-place create is refused on a dirty project tree, names the paths, and creates nothing", async () => {
  const g = reg.upsertProject({ id: PROJECT, name: "g", localRepoPath: repo });
  git(repo, "mv", "file.txt", "moved.txt"); // staged rename: only the new path is named
  writeFileSync(join(repo, "dirty.txt"), "x\n"); // untracked
  cloudTask({ worktree: false, projectId: g.id });

  const err = await sup.createSessionFromTask("task-1", USER).catch((e: unknown) => e);
  expect(err).toMatchObject({ code: "inplace_tree_dirty", params: { count: 2 } });
  if (!(err instanceof CodedError)) throw err;
  expect(String(err.params?.files).split(", ").sort()).toEqual(["dirty.txt", "moved.txt"]);
  expect(reg.listSessions(g.id)).toHaveLength(0);
  expect(git(repo, "branch", "--show-current").trim()).toBe("dev"); // branch untouched
});

test("the dirty-tree refusal names the first five paths and counts them all", async () => {
  const g = reg.upsertProject({ id: PROJECT, name: "g", localRepoPath: repo });
  for (let i = 0; i < 7; i++) writeFileSync(join(repo, `d${i}.txt`), "x\n");
  cloudTask({ worktree: false, projectId: g.id });

  const err = await sup.createSessionFromTask("task-1", USER).catch((e: unknown) => e);
  expect(err).toMatchObject({ code: "inplace_tree_dirty", params: { count: 7 } });
  if (!(err instanceof CodedError)) throw err;
  const shown = String(err.params?.files).split(", ");
  expect(shown).toHaveLength(6);
  expect(shown.at(-1)).toBe("…");
});

test("in-place create is refused when one is already active in the project", async () => {
  const g = reg.upsertProject({ id: PROJECT, name: "g", localRepoPath: repo });
  reg.createSession({
    projectId: g.id, name: "a", task: "t", worktreePath: "", branch: "feature/a",
    worktree: false, baseBranch: "dev", status: "thinking",
  });
  cloudTask({ worktree: false, projectId: g.id });

  await expect(sup.createSessionFromTask("task-1", USER)).rejects.toMatchObject({ code: "inplace_already_active" });
});

test("in-place create is refused on a detached HEAD", async () => {
  const g = reg.upsertProject({ id: PROJECT, name: "g", localRepoPath: repo });
  const head = git(repo, "rev-parse", "HEAD").trim();
  git(repo, "checkout", "-q", head); // detached
  cloudTask({ worktree: false, projectId: g.id });

  await expect(sup.createSessionFromTask("task-1", USER)).rejects.toMatchObject({ code: "inplace_detached_head" });
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
