// apps/api/test/sessions.from-task.spec.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { WorktreeService } from "../src/worktree/worktree.service";
import type { AuthService } from "../src/auth/auth.service";
import type { CloudProject, Task } from "@kermanych/cloud";

// Capture every spawned RpcSession so a test can prove whether a launch happened.
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

// Fake cloud: an in-memory `tasks` map + the project list. Mocked wholesale (no
// importOriginal) so this unit test never needs packages/cloud built and can flip the
// claim race by hand. `claimTask` reproduces the DB's `assignee_id is null` predicate:
// losing the race is zero rows, i.e. `undefined`, not an exception.
const cloudTasks = new Map<string, Task>();
const cloudProjects: CloudProject[] = [];
let claimWins = true;
vi.mock("@kermanych/cloud", () => ({
  getTask: async (_client: unknown, taskId: string) => cloudTasks.get(taskId),
  claimTask: async (_client: unknown, taskId: string, userId: string) => {
    const t = cloudTasks.get(taskId);
    if (!t || t.assigneeId || !claimWins) return undefined;
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
const OTHER = "22222222-2222-2222-2222-222222222222";
const PROJECT = "33333333-3333-3333-3333-333333333333";
const NOW = "2026-08-21T10:00:00.000Z";

function make() {
  const registry = new RegistryService(":memory:");
  const worktree = {
    isGitRepo: vi.fn().mockResolvedValue(true),
    addWorktree: vi.fn(),
    // The launch-failure rollback awaits `.catch()` on these, so they must be thenable.
    removeWorktree: vi.fn().mockResolvedValue(undefined),
    removeBranch: vi.fn().mockResolvedValue(undefined),
    createBranchHere: vi.fn(),
    checkout: vi.fn(),
    currentBranch: vi.fn().mockResolvedValue("main"),
    hasUncommitted: vi.fn().mockResolvedValue(false),
  };
  // The launch path only forwards this client to @kermanych/cloud, which is mocked above.
  const auth = {
    current: () => ({ userId: USER, accessToken: "token" }),
    cloudClient: () => ({}),
  } as unknown as AuthService;
  const sup = new SupervisorService(registry, worktree as unknown as WorktreeService, auth, stubSkills());
  return { sup, registry, worktree };
}

function task(over: Partial<Task> = {}): Task {
  const t: Task = {
    id: "task-1",
    projectId: PROJECT,
    title: "Add login",
    description: "wire GitHub OAuth",
    status: "backlog",
    createdBy: OTHER,
    createdAt: NOW,
    updatedAt: NOW,
    ...over,
  };
  cloudTasks.set(t.id, t);
  return t;
}

function bind(registry: RegistryService, localRepoPath = "/tmp/proj"): void {
  registry.upsertProject({
    id: PROJECT,
    name: "stale local name",
    localRepoPath,
    carryFiles: [".env"],
    createdAt: NOW,
  });
  cloudProjects.push({
    id: PROJECT,
    name: "kermanych",
    carryFiles: [".env", ".env.local"],
    envKeys: ["GITHUB_TOKEN"],
    defaultBranch: "main",
    ownerId: OTHER,
    createdAt: NOW,
  });
}

beforeEach(() => {
  started.length = 0;
  cloudTasks.clear();
  cloudProjects.length = 0;
  claimWins = true;
});

describe("createSessionFromTask", () => {
  it("refuses a task assigned to somebody else", async () => {
    const { sup, registry } = make();
    bind(registry);
    task({ assigneeId: OTHER });

    await expect(sup.createSessionFromTask("task-1", USER)).rejects.toThrow("task assigned to someone else");
    expect(started).toHaveLength(0);
    expect(registry.listSessions()).toHaveLength(0);
  });

  it("refuses an unknown task", async () => {
    const { sup } = make();

    await expect(sup.createSessionFromTask("nope", USER)).rejects.toThrow("task not found");
    expect(started).toHaveLength(0);
  });

  it("self-assigns an unassigned task and launches it", async () => {
    const { sup, registry } = make();
    bind(registry);
    task();

    const session = await sup.createSessionFromTask("task-1", USER);

    expect(cloudTasks.get("task-1")!.assigneeId).toBe(USER);
    expect(session.taskId).toBe("task-1");
    expect(session.projectId).toBe(PROJECT);
    expect(started).toHaveLength(1);
    expect(registry.listSessions()).toHaveLength(1);
  });

  it("refuses when the atomic claim loses the race", async () => {
    const { sup, registry } = make();
    bind(registry);
    task();
    claimWins = false;

    await expect(sup.createSessionFromTask("task-1", USER)).rejects.toThrow("task already claimed");
    expect(started).toHaveLength(0);
    expect(registry.listSessions()).toHaveLength(0);
  });

  it("refuses a task that is already running somewhere", async () => {
    const { sup, registry } = make();
    bind(registry);
    task({ assigneeId: USER, status: "thinking" });

    await expect(sup.createSessionFromTask("task-1", USER)).rejects.toThrow("task is already running");
    expect(started).toHaveLength(0);
    expect(registry.listSessions()).toHaveLength(0);
  });

  it("still launches a task left in a terminal status", async () => {
    const { sup, registry } = make();
    bind(registry);
    task({ assigneeId: USER, status: "stopped" });

    const session = await sup.createSessionFromTask("task-1", USER);

    expect(session.taskId).toBe("task-1");
    expect(started).toHaveLength(1);
    expect(registry.listSessions()).toHaveLength(1);
  });

  it("refuses a stale-backlog task this machine is already running", async () => {
    const { sup, registry } = make();
    bind(registry);
    // The cloud still says `backlog` (a push has not landed yet) but the local registry
    // already holds a live session for the card — a second launch would duplicate it.
    task({ assigneeId: USER });
    registry.createSession({
      projectId: PROJECT,
      taskId: "task-1",
      name: "Add login",
      task: "wire GitHub OAuth",
      worktreePath: "/tmp/wt",
      branch: "feature/add-login",
      status: "thinking",
    });

    await expect(sup.createSessionFromTask("task-1", USER)).rejects.toThrow("task is already running");
    expect(started).toHaveLength(0);
    expect(registry.listSessions()).toHaveLength(1);
  });

  it("refuses when the project has no local binding", async () => {
    const { sup, registry } = make();
    task({ assigneeId: USER });

    // No local row at all.
    await expect(sup.createSessionFromTask("task-1", USER)).rejects.toThrow("project not bound");

    // Row exists but the path is empty (created by a cloud sync, never bound on this machine).
    bind(registry, "");
    await expect(sup.createSessionFromTask("task-1", USER)).rejects.toThrow("project not bound");
    expect(started).toHaveLength(0);
  });

  it("launches the assignee's task, carrying task fields onto the session", async () => {
    const { sup, registry, worktree } = make();
    bind(registry);
    task({
      assigneeId: USER,
      model: "opus-5",
      prefix: "fix",
      platform: "web",
      branch: "release/2026-08",
    });

    const session = await sup.createSessionFromTask("task-1", USER);

    expect(session.name).toBe("Add login");
    expect(session.task).toBe("wire GitHub OAuth");
    expect(session.model).toBe("opus-5");
    expect(session.prefix).toBe("fix");
    expect(session.platform).toBe("web");
    expect(session.kind).toBe("agent");
    expect(session.branch).toBe("fix/add-login");
    expect(session.baseBranch).toBe("release/2026-08");
    expect(session.worktree).toBe(true);
    // Exactly one omp child, spawned in the session's worktree.
    expect(started).toHaveLength(1);
    expect(worktree.addWorktree).toHaveBeenCalledTimes(1);
    // Step 5 of the spec: the local config cache is refreshed from the cloud project.
    const local = registry.listProjects().find((p) => p.id === PROJECT)!;
    expect(local.name).toBe("kermanych");
    expect(local.carryFiles).toEqual([".env", ".env.local"]);
    expect(local.localRepoPath).toBe("/tmp/proj");
  });

  it("falls back to the task title and safe launch defaults", async () => {
    const { sup, registry } = make();
    bind(registry);
    task({ assigneeId: USER, description: undefined, prefix: "nonsense", platform: "watch" });

    const session = await sup.createSessionFromTask("task-1", USER);

    expect(session.task).toBe("Add login");
    expect(session.prefix).toBe("feature");
    expect(session.platform).toBeUndefined();
    // Cloud task carried no branch → the refreshed project default is used.
    expect(session.baseBranch).toBe("main");
  });

  it("rolls the session row back when the launch fails", async () => {
    const { sup, registry, worktree } = make();
    bind(registry);
    task({ assigneeId: USER });
    worktree.addWorktree.mockRejectedValueOnce(new Error("fatal: invalid reference"));

    await expect(sup.createSessionFromTask("task-1", USER)).rejects.toThrow("fatal: invalid reference");
    expect(registry.listSessions()).toHaveLength(0);
    expect(started).toHaveLength(0);
  });

  it("releases a claim it made itself when the launch fails", async () => {
    const { sup, registry, worktree } = make();
    bind(registry);
    task();
    worktree.addWorktree.mockRejectedValueOnce(new Error("fatal: invalid reference"));

    await expect(sup.createSessionFromTask("task-1", USER)).rejects.toThrow("fatal: invalid reference");
    // Nobody could pick the card up again if the failed claim stuck to us.
    expect(cloudTasks.get("task-1")!.assigneeId).toBeUndefined();
    expect(registry.listSessions()).toHaveLength(0);
    expect(started).toHaveLength(0);
  });

  it("leaves a pre-existing assignment alone when the launch fails", async () => {
    const { sup, registry, worktree } = make();
    bind(registry);
    task({ assigneeId: USER });
    worktree.addWorktree.mockRejectedValueOnce(new Error("fatal: invalid reference"));

    await expect(sup.createSessionFromTask("task-1", USER)).rejects.toThrow("fatal: invalid reference");
    expect(cloudTasks.get("task-1")!.assigneeId).toBe(USER);
  });
});
