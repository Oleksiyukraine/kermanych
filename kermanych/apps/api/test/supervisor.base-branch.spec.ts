import { describe, it, expect, vi, beforeEach } from "vitest";
import type { WorktreeService } from "../src/worktree/worktree.service";
import type { AuthService } from "../src/auth/auth.service";
import type { CloudProject, Task } from "@kermanych/cloud";

// Capture spawned RpcSessions so a launch can be proven; no real omp child.
const started: unknown[] = [];
vi.mock("../src/rpc/rpc-session", () => {
  class FakeRpc {
    constructor(opts: unknown) {
      started.push(opts);
    }
    onEvent() {}
    onExit() {}
    async start() {}
    async getState() {
      return { sessionId: "omp", sessionFile: "/tmp/s.jsonl" };
    }
    async getAllMessages() {
      return [];
    }
    async stop() {}
    prompt() {}
    followUp() {}
    steer() {}
  }
  return { RpcSession: FakeRpc };
});

// `from-task` is the only birth path of an agent session, so the fork base now arrives on
// the card's `branch` field. Same wholesale cloud mock as sessions.from-task.spec.ts, so
// this unit test never needs packages/cloud built.
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

import { SupervisorService } from "../src/supervisor/supervisor.service";
import { RegistryService } from "../src/registry/registry.service";
import { stubSkills } from "./skills-stub";

const USER = "11111111-1111-1111-1111-111111111111";
const PROJECT = "p1";
const NOW = "2026-08-21T10:00:00.000Z";

// The launch path only forwards this client to @kermanych/cloud, which is mocked above.
const signedIn = {
  current: () => ({ userId: USER, accessToken: "token" }),
  cloudClient: () => ({}),
} as unknown as AuthService;

// Pre-assigned to the runner so no claim is involved; `branch` IS the requested fork base.
function cloudTask(over: Partial<Task> = {}): Task {
  const t: Task = {
    id: "task-1",
    projectId: PROJECT,
    title: "task",
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

function make() {
  const registry = new RegistryService(":memory:");
  const worktree = {
    isGitRepo: vi.fn().mockResolvedValue(true),
    addWorktree: vi.fn(),
    removeWorktree: vi.fn().mockResolvedValue(undefined),
    removeBranch: vi.fn().mockResolvedValue(undefined),
    createBranchHere: vi.fn(),
    checkout: vi.fn(),
    currentBranch: vi.fn().mockResolvedValue("main"),
    hasUncommitted: vi.fn().mockResolvedValue(false),
    listBranches: vi.fn().mockResolvedValue(["main", "develop"]),
  };
  const sup = new SupervisorService(registry, worktree as unknown as WorktreeService, signedIn, stubSkills());
  return { sup, registry, worktree };
}

beforeEach(() => {
  started.length = 0;
  cloudTasks.clear();
  cloudProjects.length = 0;
});

describe("worktree fork base", () => {
  it("forks a worktree from the project's default branch and persists it on the session", async () => {
    const { sup, registry, worktree } = make();
    const g = registry.upsertProject({ id: PROJECT, name: "g", localRepoPath: "/tmp/proj", defaultBranch: "develop" });
    cloudTask({ projectId: g.id });

    const s = await sup.createSessionFromTask("task-1", USER);

    expect(worktree.addWorktree).toHaveBeenCalledWith("/tmp/proj", expect.any(String), s.branch, "develop");
    expect(registry.listSessions(g.id).find((x) => x.id === s.id)!.baseBranch).toBe("develop");
  });

  it("an explicit base branch on the card overrides the project default", async () => {
    const { sup, registry, worktree } = make();
    const g = registry.upsertProject({ id: PROJECT, name: "g", localRepoPath: "/tmp/proj", defaultBranch: "develop" });
    cloudTask({ projectId: g.id, branch: "release" });

    const s = await sup.createSessionFromTask("task-1", USER);

    expect(worktree.addWorktree).toHaveBeenCalledWith("/tmp/proj", expect.any(String), s.branch, "release");
  });

  it("forks from HEAD (no base arg) when neither a default nor an explicit base is set", async () => {
    const { sup, registry, worktree } = make();
    const g = registry.upsertProject({ id: PROJECT, name: "g", localRepoPath: "/tmp/proj" });
    cloudTask({ projectId: g.id });

    await sup.createSessionFromTask("task-1", USER);

    expect(worktree.addWorktree).toHaveBeenCalledWith("/tmp/proj", expect.any(String), expect.any(String), undefined);
  });
});
