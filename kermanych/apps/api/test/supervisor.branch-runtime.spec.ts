import { describe, it, expect, vi, beforeEach } from "vitest";
import type { WorktreeService } from "../src/worktree/worktree.service";

// branchSession forks the parent's omp conversation: the child is an omp discussion that forks
// on the parent's session FILE (ompSessionFile). We spy on the factory to prove the fork handle.
const calls: Record<string, unknown>[] = [];
vi.mock("../src/runtime/agent-runtime", () => ({
  createRuntime: (opts: Record<string, unknown>) => {
    calls.push(opts);
    return {
      start: async () => {},
      isAlive: () => true,
      droppedFrames: 0,
      prompt: () => {},
      followUp: () => {},
      steer: () => {},
      answerUi: () => {},
      getState: async () => ({ isStreaming: false }),
      switchSession: async () => {},
      setModel: async () => {},
      setThinkingLevel: async () => {},
      getAllMessages: async () => [],
      stop: async () => {},
      onEvent: () => {},
      onExit: () => {},
    };
  },
}));

import { SupervisorService } from "../src/supervisor/supervisor.service";
import { RegistryService } from "../src/registry/registry.service";
import { offlineAuth } from "./offline-auth";
import { stubSkills } from "./skills-stub";

function make() {
  const registry = new RegistryService(":memory:");
  const worktree = {
    isGitRepo: vi.fn().mockResolvedValue(true),
    addWorktree: vi.fn().mockResolvedValue(undefined),
    removeWorktree: vi.fn().mockResolvedValue(undefined),
    removeBranch: vi.fn().mockResolvedValue(undefined),
    createBranchHere: vi.fn().mockResolvedValue(undefined),
    checkout: vi.fn().mockResolvedValue(undefined),
    currentBranch: vi.fn().mockResolvedValue("main"),
    hasUncommitted: vi.fn().mockResolvedValue(false),
  };
  const sup = new SupervisorService(registry, worktree as unknown as WorktreeService, offlineAuth(), stubSkills());
  return { sup, registry };
}

beforeEach(() => {
  calls.length = 0;
});

describe("branchSession", () => {
  it("inherits an omp parent and forks on its session FILE (ompSessionFile)", async () => {
    const { sup, registry } = make();
    const g = registry.upsertProject({ id: "p1", name: "g", localRepoPath: "/tmp/proj" });
    const parent = registry.createSession({ projectId: g.id, name: "AAA", task: "t", worktreePath: "/tmp/wt", branch: "feature/aaa", runtime: "omp" });
    registry.updateSession(parent.id, { ompSessionFile: "/tmp/aaa.jsonl", status: "done" });

    const child = await sup.branchSession(parent.id);

    expect(child.runtime).toBe("omp");
    expect(calls.at(-1)).toMatchObject({ fork: "/tmp/aaa.jsonl", noTools: true });
  });

  it("refuses to branch a parent that has no session file yet", async () => {
    const { sup, registry } = make();
    const g = registry.upsertProject({ id: "p1", name: "g", localRepoPath: "/tmp/proj" });
    const parent = registry.createSession({ projectId: g.id, name: "AAA", task: "t", worktreePath: "/tmp/wt", branch: "feature/aaa", runtime: "omp" });
    registry.updateSession(parent.id, { status: "done" });

    await expect(sup.branchSession(parent.id)).rejects.toThrow(/session/i);
  });
});
