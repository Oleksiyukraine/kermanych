import { describe, it, expect, vi, beforeEach } from "vitest";
import type { WorktreeService } from "../src/worktree/worktree.service";
import type { AuthService } from "../src/auth/auth.service";
import type { ModelsService } from "../src/models/models.service";
import type { CloudProject, Task } from "@kermanych/cloud";

// The runtime-aware model guard (ModelsService.validModel) is not under test here; an identity
// stub returns the wanted model unchanged so createSessionFromTask keeps task.model as before.
function stubModels(): ModelsService {
  return { validModel: async (_r: string, w: string | undefined) => w } as unknown as ModelsService;
}

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
    autoRun: false,
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
    forkStart: vi.fn(async (_repo: string, base: string) => ({ ref: base, stale: false })),
    hasUncommitted: vi.fn().mockResolvedValue(false),
    listBranches: vi.fn().mockResolvedValue(["main", "develop"]),
  };
  const sup = new SupervisorService(registry, worktree as unknown as WorktreeService, signedIn, stubSkills(), stubModels());
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

  // Recorded, not just used: the PR prompt, the base sync and «Зміни» all read the session's base.
  it("forks from the project checkout's branch and records it when neither a default nor an explicit base is set", async () => {
    const { sup, registry, worktree } = make();
    const g = registry.upsertProject({ id: PROJECT, name: "g", localRepoPath: "/tmp/proj" });
    cloudTask({ projectId: g.id });

    const s = await sup.createSessionFromTask("task-1", USER);

    expect(worktree.addWorktree).toHaveBeenCalledWith("/tmp/proj", expect.any(String), s.branch, "main");
    expect(registry.listSessions(g.id).find((x) => x.id === s.id)!.baseBranch).toBe("main");
  });

  it("forks from HEAD with no base when the project checkout is on a detached HEAD", async () => {
    const { sup, registry, worktree } = make();
    worktree.currentBranch.mockResolvedValue("");
    const g = registry.upsertProject({ id: PROJECT, name: "g", localRepoPath: "/tmp/proj" });
    cloudTask({ projectId: g.id });

    const s = await sup.createSessionFromTask("task-1", USER);

    expect(worktree.forkStart).not.toHaveBeenCalled();
    expect(worktree.addWorktree).toHaveBeenCalledWith("/tmp/proj", expect.any(String), s.branch, undefined);
    expect(registry.listSessions(g.id).find((x) => x.id === s.id)!.baseBranch).toBeFalsy();
  });
});
