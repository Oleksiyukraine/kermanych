import { describe, it, expect, vi, beforeEach } from "vitest";
import type { WorktreeService } from "../src/worktree/worktree.service";

// A backend whose child cannot launch — the signed-out / missing-binary case. The contract
// under test: a launch that fails must FAIL the call, leave no half-built session behind, and
// carry the localizable cause so the UI can name the command that repairs the machine.
const DEAD_MSG = "omp is not signed in: run `omp login`";

let startBehaviour: "die" | "live" = "die";

vi.mock("../src/runtime/agent-runtime", () => ({
  createRuntime: () => ({
    start: async () => {
      if (startBehaviour === "die") {
        const err = new Error(DEAD_MSG) as Error & { code?: string };
        err.code = "omp_not_authenticated";
        throw err;
      }
    },
    isAlive: () => startBehaviour === "live",
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
  }),
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
    diff: vi.fn().mockResolvedValue(""),
  };
  const sup = new SupervisorService(registry, worktree as unknown as WorktreeService, offlineAuth(), stubSkills());
  const project = registry.upsertProject({ id: "p1", name: "g", localRepoPath: "/tmp/proj" });
  return { sup, registry, project };
}

beforeEach(() => {
  startBehaviour = "die";
});

describe("createChat over a backend that cannot launch", () => {
  it("fails the call instead of returning a chat that can never answer", async () => {
    const { sup, project } = make();
    await expect(sup.createChat(project.id)).rejects.toThrow(/omp login/);
  });

  it("carries the localizable cause through to the caller", async () => {
    const { sup, project } = make();
    const err = await sup.createChat(project.id).catch((e: unknown) => e as Error & { code?: string });
    expect(err.code).toBe("omp_not_authenticated");
  });

  // A leftover row would show up on the board as a chat that opens to nothing.
  it("leaves no session row behind", async () => {
    const { sup, registry, project } = make();
    await sup.createChat(project.id).catch(() => {});
    expect(registry.listSessions(project.id)).toEqual([]);
  });

  it("still creates the chat normally once the machine is repaired", async () => {
    const { sup, project } = make();
    await sup.createChat(project.id).catch(() => {});
    startBehaviour = "live";
    const chat = await sup.createChat(project.id);
    expect(chat.runtime).toBe("omp");
    expect(chat.status).toBe("done");
  });
});
