import { describe, it, expect, vi, beforeEach } from "vitest";
import type { WorktreeService } from "../src/worktree/worktree.service";
import type { AgentRuntimeKind } from "@kermanych/core";

// createChat and reviewSession are FRESH sessions (Task 2): they stamp the user's preference
// (runtimeFor → resolveRuntime) and spawn on that backend through the factory. We spy on the
// factory to prove BOTH the stamped Session.runtime and the kind the factory is invoked with.
// agent-runtime's only runtime value export is createRuntime (the rest are types), so a
// wholesale mock is complete and never loads the real omp/claude backends.
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
    diff: vi.fn().mockResolvedValue("diff --git a/x.ts b/x.ts\n+const answer = 42;"),
  };
  const sup = new SupervisorService(registry, worktree as unknown as WorktreeService, offlineAuth(), stubSkills());
  return { sup, registry };
}

function prefer(registry: RegistryService, runtime: AgentRuntimeKind) {
  registry.setAuthSession({ userId: "u", accessToken: "t", agentRuntime: runtime });
}

beforeEach(() => {
  calls.length = 0;
  delete process.env.KERMANYCH_RUNTIME;
});

describe("createChat runtime routing", () => {
  it("stamps and spawns claude-code when that is the cached preference", async () => {
    const { sup, registry } = make();
    prefer(registry, "claude-code");
    const g = registry.upsertProject({ id: "p1", name: "g", localRepoPath: "/tmp/proj" });

    const chat = await sup.createChat(g.id);

    expect(chat.runtime).toBe("claude-code");
    expect(calls.at(-1)).toMatchObject({ kind: "claude-code" });
  });

  it("defaults to omp with no preference", async () => {
    const { sup, registry } = make();
    const g = registry.upsertProject({ id: "p1", name: "g", localRepoPath: "/tmp/proj" });

    const chat = await sup.createChat(g.id);

    expect(chat.runtime).toBe("omp");
    expect(calls.at(-1)).toMatchObject({ kind: "omp" });
  });
});

describe("reviewSession runtime routing", () => {
  function seedParent(registry: RegistryService) {
    const g = registry.upsertProject({ id: "p1", name: "g", localRepoPath: "/tmp/proj" });
    const parent = registry.createSession({ projectId: g.id, name: "AAA", task: "Add feature X", worktreePath: "/tmp/wt", branch: "feature/aaa" });
    registry.updateSession(parent.id, { status: "done" });
    return parent;
  }

  it("stamps and spawns claude-code when that is the cached preference", async () => {
    const { sup, registry } = make();
    prefer(registry, "claude-code");
    const parent = seedParent(registry);

    const review = await sup.reviewSession(parent.id);

    expect(review.runtime).toBe("claude-code");
    expect(calls.at(-1)).toMatchObject({ kind: "claude-code" });
  });

  it("defaults to omp with no preference", async () => {
    const { sup, registry } = make();
    const parent = seedParent(registry);

    const review = await sup.reviewSession(parent.id);

    expect(review.runtime).toBe("omp");
    expect(calls.at(-1)).toMatchObject({ kind: "omp" });
  });
});
