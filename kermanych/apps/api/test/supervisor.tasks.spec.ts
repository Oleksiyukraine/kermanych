import { describe, it, expect, vi, beforeEach } from "vitest";
import type { WorktreeService } from "../src/worktree/worktree.service";

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

import { SupervisorService } from "../src/supervisor/supervisor.service";
import { RegistryService } from "../src/registry/registry.service";
import { offlineAuth } from "./offline-auth";
import { stubSkills } from "./skills-stub";

function make() {
  const registry = new RegistryService(":memory:");
  // vi.fn() members keep their Mock types for call assertions; cast only at the DI boundary.
  const worktree = {
    isGitRepo: vi.fn().mockResolvedValue(true),
    addWorktree: vi.fn(),
    removeWorktree: vi.fn(),
    removeBranch: vi.fn(),
    createBranchHere: vi.fn(),
    checkout: vi.fn(),
    currentBranch: vi.fn().mockResolvedValue("main"),
    hasUncommitted: vi.fn().mockResolvedValue(false),
  };
  const sup = new SupervisorService(registry, worktree as unknown as WorktreeService, offlineAuth(), stubSkills());
  return { sup, registry, worktree };
}

beforeEach(() => {
  started.length = 0;
});

describe("backlog tasks", () => {
  it("createSession asTask stores a backlog task without spawning or a worktree", async () => {
    const { sup, registry, worktree } = make();
    const g = registry.upsertProject({ id: "p1", name: "g", localRepoPath: "/tmp/proj" });

    const t = await sup.createSession(g.id, "planned", "do later", "opus-5", undefined, true, "fix", true);

    expect(t.kind).toBe("task");
    expect(t.status).toBe("backlog");
    expect(started).toHaveLength(0);
    expect(worktree.addWorktree).not.toHaveBeenCalled();
    // Launch config is persisted so a later Start reuses the operator's choices.
    const read = registry.listSessions(g.id).find((s) => s.id === t.id)!;
    expect(read.model).toBe("opus-5");
    expect(read.prefix).toBe("fix");
  });

  it("startTask launches a backlog task, flipping the same row into a running agent", async () => {
    const { sup, registry, worktree } = make();
    const g = registry.upsertProject({ id: "p1", name: "g", localRepoPath: "/tmp/proj" });
    const t = await sup.createSession(g.id, "planned", "do later", undefined, undefined, true, "feature", true);

    const running = await sup.startTask(t.id);

    expect(running.id).toBe(t.id); // same row, not a new session
    expect(running.kind).toBe("agent"); // flipped
    expect(running.status).toBe("queued");
    expect(started).toHaveLength(1); // omp child spawned
    expect(worktree.addWorktree).toHaveBeenCalledTimes(1);
    const read = registry.listSessions(g.id).find((s) => s.id === t.id)!;
    expect(read.kind).toBe("agent");
    expect(read.branch).toBeTruthy(); // branch resolved at start time
  });

  it("startTask rejects a session that is not a backlog task", async () => {
    const { sup, registry } = make();
    const g = registry.upsertProject({ id: "p1", name: "g", localRepoPath: "/tmp/proj" });
    const agent = await sup.createSession(g.id, "live", "go", undefined, undefined, true, "feature", false);
    await expect(sup.startTask(agent.id)).rejects.toThrow(/backlog/i);
  });

  it("updateTask edits a backlog row in place", async () => {
    const { sup, registry } = make();
    const g = registry.upsertProject({ id: "p1", name: "g", localRepoPath: "/tmp/proj" });
    const t = await sup.createSession(g.id, "planned", "do later", undefined, undefined, true, "feature", true);

    const saved = await sup.updateTask(t.id, { task: "do it differently", model: "opus-5" });

    expect(saved.task).toBe("do it differently");
    expect(saved.status).toBe("backlog"); // still a task
    const read = registry.listSessions(g.id).find((s) => s.id === t.id)!;
    expect(read.task).toBe("do it differently");
    expect(read.model).toBe("opus-5");
  });

  it("deleteSession removes a backlog task without touching git branches", async () => {
    const { sup, registry, worktree } = make();
    const g = registry.upsertProject({ id: "p1", name: "g", localRepoPath: "/tmp/proj" });
    const t = await sup.createSession(g.id, "planned", "later", undefined, undefined, true, "feature", true);

    await sup.deleteSession(t.id);

    expect(registry.listSessions(g.id)).toHaveLength(0);
    expect(worktree.removeBranch).not.toHaveBeenCalled(); // no branch was ever created
  });

  it("a backlog in-place task does not occupy the single in-place agent slot", async () => {
    const { sup, registry } = make();
    const g = registry.upsertProject({ id: "p1", name: "g", localRepoPath: "/tmp/proj" });
    // A planned in-place task sitting in the backlog...
    await sup.createSession(g.id, "planned", "later", undefined, undefined, false, "feature", true);
    // ...must not block launching a real in-place agent.
    const agent = await sup.createSession(g.id, "live", "go", undefined, undefined, false, "feature", false);

    expect(agent.status).toBe("queued");
    expect(agent.worktree).toBe(false);
  });

  it("persists platform on a backlog task and carries an override through start", async () => {
    const { sup, registry } = make();
    const g = registry.upsertProject({ id: "p1", name: "g", localRepoPath: "/tmp/proj" });
    const t = await sup.createSession(g.id, "planned", "do later", undefined, undefined, true, "feature", true, "backend");
    expect(registry.listSessions(g.id).find((s) => s.id === t.id)!.platform).toBe("backend");
    const running = await sup.startTask(t.id, { platform: "web" });
    expect(running.platform).toBe("web");
  });

  it("updateTask changes the platform in place", async () => {
    const { sup, registry } = make();
    const g = registry.upsertProject({ id: "p1", name: "g", localRepoPath: "/tmp/proj" });
    const t = await sup.createSession(g.id, "planned", "do later", undefined, undefined, true, "feature", true, "backend");
    await sup.updateTask(t.id, { platform: "mobile" });
    expect(registry.listSessions(g.id).find((s) => s.id === t.id)!.platform).toBe("mobile");
  });

  it("moveTask re-parents a backlog task to another project", async () => {
    const { sup, registry } = make();
    const be = registry.upsertProject({ id: "p1", name: "backend", localRepoPath: "/tmp/be" });
    const fe = registry.upsertProject({ id: "p2", name: "frontend", localRepoPath: "/tmp/fe" });
    const t = await sup.createSession(be.id, "planned", "do later", undefined, undefined, true, "feature", true);

    const moved = sup.moveTask(t.id, fe.id);

    expect(moved.projectId).toBe(fe.id);
    expect(moved.status).toBe("backlog"); // still a backlog task, no git side effects
    expect(registry.listSessions(be.id)).toHaveLength(0);
    expect(registry.listSessions(fe.id).map((s) => s.id)).toEqual([t.id]);
  });

  it("moveTask rejects a session that is not a backlog task", async () => {
    const { sup, registry } = make();
    const be = registry.upsertProject({ id: "p1", name: "backend", localRepoPath: "/tmp/be" });
    const fe = registry.upsertProject({ id: "p2", name: "frontend", localRepoPath: "/tmp/fe" });
    const agent = await sup.createSession(be.id, "live", "go", undefined, undefined, true, "feature", false);
    expect(() => sup.moveTask(agent.id, fe.id)).toThrow(/backlog/i);
  });

  it("moveTask rejects an unknown target project", async () => {
    const { sup, registry } = make();
    const be = registry.upsertProject({ id: "p1", name: "backend", localRepoPath: "/tmp/be" });
    const t = await sup.createSession(be.id, "planned", "later", undefined, undefined, true, "feature", true);
    expect(() => sup.moveTask(t.id, "no-such-project")).toThrow(/project not found/i);
  });
});
