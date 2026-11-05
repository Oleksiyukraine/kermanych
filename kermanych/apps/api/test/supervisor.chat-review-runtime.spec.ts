import { describe, it, expect, vi, beforeEach } from "vitest";
import type { WorktreeService } from "../src/worktree/worktree.service";

// createChat and reviewSession are FRESH sessions: they stamp `omp` and spawn through the
// factory. We spy on the factory to prove the spawn and its fork handle. agent-runtime's only
// runtime value export is createRuntime (the rest are types), so a wholesale mock is complete
// and never loads the real omp backend.
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
    forkPoint: vi.fn().mockResolvedValue(""),
    hasUncommitted: vi.fn().mockResolvedValue(false),
    forkStart: vi.fn(async (_repo: string, base: string) => ({ ref: base, stale: false })),
    diff: vi.fn().mockResolvedValue("diff --git a/x.ts b/x.ts\n+const answer = 42;"),
  };
  const sup = new SupervisorService(registry, worktree as unknown as WorktreeService, offlineAuth(), stubSkills());
  return { sup, registry };
}

beforeEach(() => {
  calls.length = 0;
});

describe("createChat", () => {
  it("stamps omp and spawns it", async () => {
    const { sup, registry } = make();
    const g = registry.upsertProject({ id: "p1", name: "g", localRepoPath: "/tmp/proj" });

    const chat = await sup.createChat(g.id);

    expect(chat.runtime).toBe("omp");
    expect(calls).toHaveLength(1);
  });
});

describe("promoteChatToAgent", () => {
  it("refuses a chat the removed managed claude-code ran, spawning nothing", async () => {
    const { sup, registry } = make();
    const g = registry.upsertProject({ id: "p1", name: "g", localRepoPath: "/tmp/proj" });
    const chat = registry.createSession({ projectId: g.id, name: "чат 1", task: "t", worktreePath: "", branch: "", worktree: false, kind: "chat", runtime: "claude-code", status: "done" });

    await expect(sup.promoteChatToAgent(chat.id, "card-1")).rejects.toMatchObject({ code: "managed_claude_removed" });
    expect(calls).toEqual([]);
    expect(registry.listSessions().find((x) => x.id === chat.id)).toMatchObject({ kind: "chat", status: "done" });
  });

  it("forks an omp chat from its session file even when it also has an id", async () => {
    const { sup, registry } = make();
    const g = registry.upsertProject({ id: "p1", name: "g", localRepoPath: "/tmp/proj" });
    const chat = await sup.createChat(g.id);
    registry.updateSession(chat.id, { ompSessionId: "omp-id", ompSessionFile: "/tmp/chat.jsonl" });

    await sup.promoteChatToAgent(chat.id, "card-1");

    expect(calls.at(-1)).toMatchObject({ fork: "/tmp/chat.jsonl" });
  });
});

describe("reviewSession", () => {
  function seedParent(registry: RegistryService) {
    const g = registry.upsertProject({ id: "p1", name: "g", localRepoPath: "/tmp/proj" });
    const parent = registry.createSession({ projectId: g.id, name: "AAA", task: "Add feature X", worktreePath: "/tmp/wt", branch: "feature/aaa" });
    registry.updateSession(parent.id, { status: "done" });
    return parent;
  }

  it("stamps omp and spawns it", async () => {
    const { sup, registry } = make();
    const parent = seedParent(registry);

    const review = await sup.reviewSession(parent.id);

    expect(review.runtime).toBe("omp");
    expect(calls).toHaveLength(1);
  });
});
