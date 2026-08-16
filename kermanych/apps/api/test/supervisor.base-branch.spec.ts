import { describe, it, expect, vi, beforeEach } from "vitest";
import type { WorktreeService } from "../src/worktree/worktree.service";

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

import { SupervisorService } from "../src/supervisor/supervisor.service";
import { RegistryService } from "../src/registry/registry.service";

function make() {
  const registry = new RegistryService(":memory:");
  const worktree = {
    isGitRepo: vi.fn().mockResolvedValue(true),
    addWorktree: vi.fn(),
    removeWorktree: vi.fn(),
    removeBranch: vi.fn(),
    createBranchHere: vi.fn(),
    checkout: vi.fn(),
    currentBranch: vi.fn().mockResolvedValue("main"),
    hasUncommitted: vi.fn().mockResolvedValue(false),
    listBranches: vi.fn().mockResolvedValue(["main", "develop"]),
  };
  const sup = new SupervisorService(registry, worktree as unknown as WorktreeService);
  return { sup, registry, worktree };
}

beforeEach(() => {
  started.length = 0;
});

describe("worktree fork base", () => {
  it("forks a worktree from the project's default branch and persists it on the session", async () => {
    const { sup, registry, worktree } = make();
    const g = registry.createGroup({ name: "g", projectDir: "/tmp/proj", defaultBranch: "develop" });

    const s = await sup.createSession(g.id, "task", "t");

    expect(worktree.addWorktree).toHaveBeenCalledWith("/tmp/proj", expect.any(String), s.branch, "develop");
    expect(registry.listSessions(g.id).find((x) => x.id === s.id)!.baseBranch).toBe("develop");
  });

  it("an explicit base branch overrides the project default", async () => {
    const { sup, registry, worktree } = make();
    const g = registry.createGroup({ name: "g", projectDir: "/tmp/proj", defaultBranch: "develop" });

    const s = await sup.createSession(g.id, "task", "t", undefined, undefined, true, "feature", false, undefined, "release");

    expect(worktree.addWorktree).toHaveBeenCalledWith("/tmp/proj", expect.any(String), s.branch, "release");
  });

  it("forks from HEAD (no base arg) when neither a default nor an explicit base is set", async () => {
    const { sup, registry, worktree } = make();
    const g = registry.createGroup({ name: "g", projectDir: "/tmp/proj" });

    await sup.createSession(g.id, "task", "t");

    expect(worktree.addWorktree).toHaveBeenCalledWith("/tmp/proj", expect.any(String), expect.any(String), undefined);
  });

  it("carries a base chosen on a backlog task through to its start", async () => {
    const { sup, registry, worktree } = make();
    const g = registry.createGroup({ name: "g", projectDir: "/tmp/proj", defaultBranch: "develop" });
    const t = await sup.createSession(g.id, "planned", "later", undefined, undefined, true, "feature", true, undefined, "release");

    await sup.startTask(t.id);

    expect(worktree.addWorktree).toHaveBeenCalledWith("/tmp/proj", expect.any(String), expect.any(String), "release");
  });
});
