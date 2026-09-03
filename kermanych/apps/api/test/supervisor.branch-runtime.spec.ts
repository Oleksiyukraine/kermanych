import { describe, it, expect, vi, beforeEach } from "vitest";
import type { WorktreeService } from "../src/worktree/worktree.service";

// branchSession forks the parent (Task 3): a fork can only continue on the parent's backend,
// so the child INHERITS parent.runtime (never runtimeFor()) and forks on the per-runtime handle
// (R1/R2): claude resumes from the parent's session UUID (ompSessionId), omp from the parent's
// session FILE (ompSessionFile). We spy on the factory to prove the inherited kind + fork handle.
type FactoryCall = { kind: string; opts: Record<string, unknown> };
const calls: FactoryCall[] = [];
vi.mock("../src/runtime/agent-runtime", () => ({
  createRuntime: (kind: string, opts: Record<string, unknown>) => {
    calls.push({ kind, opts });
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
  delete process.env.KERMANYCH_RUNTIME;
});

describe("branchSession runtime inheritance", () => {
  it("inherits a claude-code parent and forks on its session UUID (ompSessionId)", async () => {
    const { sup, registry } = make();
    const g = registry.upsertProject({ id: "p1", name: "g", localRepoPath: "/tmp/proj" });
    const parent = registry.createSession({ projectId: g.id, name: "AAA", task: "t", worktreePath: "/tmp/wt", branch: "feature/aaa", runtime: "claude-code" });
    // claude stores the resumable session UUID in ompSessionId; the file column may be empty.
    registry.updateSession(parent.id, { ompSessionId: "11111111-2222-3333-4444-555555555555", status: "done" });

    const child = await sup.branchSession(parent.id);

    expect(child.runtime).toBe("claude-code");
    expect(calls.at(-1)).toMatchObject({ kind: "claude-code", opts: { fork: "11111111-2222-3333-4444-555555555555", noTools: true } });
  });

  it("inherits an omp parent and forks on its session FILE (ompSessionFile)", async () => {
    const { sup, registry } = make();
    const g = registry.upsertProject({ id: "p1", name: "g", localRepoPath: "/tmp/proj" });
    const parent = registry.createSession({ projectId: g.id, name: "AAA", task: "t", worktreePath: "/tmp/wt", branch: "feature/aaa", runtime: "omp" });
    registry.updateSession(parent.id, { ompSessionFile: "/tmp/aaa.jsonl", status: "done" });

    const child = await sup.branchSession(parent.id);

    expect(child.runtime).toBe("omp");
    expect(calls.at(-1)).toMatchObject({ kind: "omp", opts: { fork: "/tmp/aaa.jsonl", noTools: true } });
  });

  it("refuses to branch a claude-code parent that has no session UUID yet", async () => {
    const { sup, registry } = make();
    const g = registry.upsertProject({ id: "p1", name: "g", localRepoPath: "/tmp/proj" });
    const parent = registry.createSession({ projectId: g.id, name: "AAA", task: "t", worktreePath: "/tmp/wt", branch: "feature/aaa", runtime: "claude-code" });
    registry.updateSession(parent.id, { status: "done" });

    await expect(sup.branchSession(parent.id)).rejects.toThrow(/session/i);
  });
});
