import { describe, it, expect, vi, beforeEach } from "vitest";
import type { WorktreeService } from "../src/worktree/worktree.service";

// The subset of RpcSession constructor options the tests assert on.
type SpawnOpts = { cwd: string; model?: string; fork?: string; noTools?: boolean; tools?: string[] };

// Capture every spawned RpcSession so a test can prove how a chat / promotion spawns omp.
const started: SpawnOpts[] = [];
vi.mock("../src/rpc/rpc-session", () => {
  class FakeRpc {
    constructor(opts: SpawnOpts) {
      started.push(opts);
    }
    onEvent() {}
    onExit() {}
    async start() {}
    async getState() {
      return { sessionId: "omp-child", sessionFile: "/tmp/chat.jsonl" };
    }
    async getAllMessages() {
      return [{ role: "assistant", content: [{ type: "text", text: "planned" }] }];
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
  };
  const sup = new SupervisorService(registry, worktree as unknown as WorktreeService);
  return { sup, registry, worktree };
}

beforeEach(() => {
  started.length = 0;
});

describe("createChat", () => {
  it("creates a read-only chat in the project dir with no git", async () => {
    const { sup, registry, worktree } = make();
    const g = registry.createGroup({ name: "g", projectDir: "/tmp/proj" });

    const chat = await sup.createChat(g.id);

    expect(chat.kind).toBe("chat");
    expect(chat.worktree).toBe(false);
    expect(chat.branch).toBe("");
    // Spawned in the project dir with the read-only tool subset — no worktree/branch touched.
    expect(started.at(-1)).toMatchObject({ cwd: "/tmp/proj", tools: ["read", "grep", "glob"] });
    expect(worktree.addWorktree).not.toHaveBeenCalled();
    expect(worktree.createBranchHere).not.toHaveBeenCalled();
  });
});

describe("promoteChatToAgent", () => {
  it("forks the chat conversation into a fresh worktree agent, keeping the chat", async () => {
    const { sup, registry, worktree } = make();
    const g = registry.createGroup({ name: "g", projectDir: "/tmp/proj" });
    // A chat that has already produced an omp session file (sent >=1 message).
    const chat = registry.createSession({
      groupId: g.id, name: "чат 1", task: "", worktreePath: "", branch: "",
      worktree: false, kind: "chat",
    });
    registry.updateSession(chat.id, { ompSessionFile: "/tmp/chat.jsonl", status: "done" });

    const agent = await sup.promoteChatToAgent(chat.id, { name: "impl-plan", prefix: "feature", worktree: true });

    expect(agent.id).not.toBe(chat.id); // a new row, not the chat itself
    expect(agent.kind).toBe("agent");
    expect(agent.branch).toBeTruthy();
    expect(agent.parentSessionId).toBeFalsy(); // standalone (no parent), so deleting the chat can't cascade-nuke it
    expect(agent.parentSessionId).not.toBe(chat.id);
    // Worktree isolation created; omp forked from the chat's session with FULL tools.
    expect(worktree.addWorktree).toHaveBeenCalledTimes(1);
    const opts = started.at(-1)!;
    expect(opts).toMatchObject({ fork: "/tmp/chat.jsonl" });
    expect(opts.noTools).toBeFalsy();
    expect(opts.tools).toBeUndefined();
    // The chat stays available for further promotions.
    expect(registry.listSessions(g.id).find((s) => s.id === chat.id)).toBeTruthy();
  });

  it("rejects promotion before the chat has an omp session", async () => {
    const { sup, registry } = make();
    const g = registry.createGroup({ name: "g", projectDir: "/tmp/proj" });
    const chat = registry.createSession({
      groupId: g.id, name: "чат 1", task: "", worktreePath: "", branch: "",
      worktree: false, kind: "chat",
    });
    await expect(sup.promoteChatToAgent(chat.id, { name: "x" })).rejects.toThrow(/omp session/i);
  });
});
