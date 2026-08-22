import { describe, it, expect, vi, beforeEach } from "vitest";
import type { WorktreeService } from "../src/worktree/worktree.service";

// The subset of RpcSession constructor options the tests assert on.
type SpawnOpts = { cwd: string; model?: string; fork?: string; noTools?: boolean; tools?: string[] };

// Capture every spawned RpcSession and every prompt written to it, so a test can prove how a
// chat / promotion spawns omp and what work it kicks off.
const started: SpawnOpts[] = [];
const prompts: string[] = [];
vi.mock("../src/rpc/rpc-session", () => {
  class FakeRpc {
    constructor(opts: SpawnOpts) {
      started.push(opts);
    }
    onEvent() {}
    onExit() {}
    async start() {}
    isAlive() {
      return true;
    }
    async getState() {
      return { sessionId: "omp-child", sessionFile: "/tmp/chat.jsonl" };
    }
    async getAllMessages() {
      return [{ role: "assistant", content: [{ type: "text", text: "planned" }] }];
    }
    async stop() {}
    prompt(text: string) {
      prompts.push(text);
    }
    followUp() {}
    steer() {}
  }
  return { RpcSession: FakeRpc };
});

import { SupervisorService } from "../src/supervisor/supervisor.service";
import { RegistryService } from "../src/registry/registry.service";
import { offlineAuth } from "./offline-auth";

function make() {
  const registry = new RegistryService(":memory:");
  const worktree = {
    isGitRepo: vi.fn().mockResolvedValue(true),
    // Every WorktreeService method is async — the stubs must resolve, or the supervisor's
    // `.catch()` cleanup paths blow up on `undefined`.
    addWorktree: vi.fn().mockResolvedValue(undefined),
    removeWorktree: vi.fn().mockResolvedValue(undefined),
    removeBranch: vi.fn().mockResolvedValue(undefined),
    createBranchHere: vi.fn().mockResolvedValue(undefined),
    checkout: vi.fn().mockResolvedValue(undefined),
    currentBranch: vi.fn().mockResolvedValue("main"),
    hasUncommitted: vi.fn().mockResolvedValue(false),
  };
  const sup = new SupervisorService(registry, worktree as unknown as WorktreeService, offlineAuth());
  return { sup, registry, worktree };
}

beforeEach(() => {
  started.length = 0;
  prompts.length = 0;
});

// A chat that has already been talked to: a live omp child, a recorded session file, and its
// opening message on the row — the state the "start implementing" button promotes from.
async function discussedChat(sup: SupervisorService, projectId: string, opening: string) {
  const chat = await sup.createChat(projectId);
  await sup.sendMessage(chat.id, opening, "prompt");
  return chat;
}

describe("createChat", () => {
  it("creates a read-only chat in the project dir with no git", async () => {
    const { sup, registry, worktree } = make();
    const g = registry.upsertProject({ id: "p1", name: "g", localRepoPath: "/tmp/proj" });

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

describe("chat opening message", () => {
  it("is recorded on the row so a promoted agent carries a task", async () => {
    const { sup, registry } = make();
    const g = registry.upsertProject({ id: "p1", name: "g", localRepoPath: "/tmp/proj" });
    const chat = await sup.createChat(g.id);

    await sup.sendMessage(chat.id, "Додати експорт у CSV", "prompt");
    await sup.sendMessage(chat.id, "і ще фільтри", "follow_up");

    // The opener is the ask; later turns refine it and must not overwrite it.
    expect(registry.listSessions(g.id).find((s) => s.id === chat.id)!.task).toBe("Додати експорт у CSV");
  });
});

describe("promoteChatToAgent", () => {
  it("turns the chat row itself into a worktree agent", async () => {
    const { sup, registry, worktree } = make();
    const g = registry.upsertProject({ id: "p1", name: "g", localRepoPath: "/tmp/proj" });
    const chat = await discussedChat(sup, g.id, "Додати експорт у CSV");

    const agent = await sup.promoteChatToAgent(chat.id);

    expect(agent.id).toBe(chat.id); // the same task, matured — not a twin row
    expect(registry.listSessions(g.id)).toHaveLength(1);
    expect(agent.kind).toBe("agent");
    expect(agent.worktree).toBe(true);
    expect(agent.worktreePath).toContain(chat.id);
    expect(worktree.addWorktree).toHaveBeenCalledTimes(1);
  });

  it("names the agent and its branch after the chat's opening message", async () => {
    const { sup, registry } = make();
    const g = registry.upsertProject({ id: "p1", name: "g", localRepoPath: "/tmp/proj" });
    const chat = await discussedChat(sup, g.id, "Додати експорт у CSV\nдеталі нижче");

    const agent = await sup.promoteChatToAgent(chat.id);

    expect(agent.name).toBe("Додати експорт у CSV");
    expect(agent.branch).toBe("feature/dodaty-eksport-u-csv");
  });

  it("falls back to the chat's own name when nothing was asked yet", async () => {
    const { sup, registry } = make();
    const g = registry.upsertProject({ id: "p1", name: "g", localRepoPath: "/tmp/proj" });
    const chat = await sup.createChat(g.id);

    const agent = await sup.promoteChatToAgent(chat.id);

    expect(agent.name).toBe("чат 1");
    expect(agent.branch).toBe("feature/chat-1");
  });

  it("continues the chat's conversation with full tools and starts implementing at once", async () => {
    const { sup, registry } = make();
    const g = registry.upsertProject({ id: "p1", name: "g", localRepoPath: "/tmp/proj" });
    const chat = await discussedChat(sup, g.id, "Додати експорт у CSV");

    const agent = await sup.promoteChatToAgent(chat.id);

    const opts = started.at(-1)!;
    expect(opts).toMatchObject({ cwd: agent.worktreePath, fork: "/tmp/chat.jsonl" });
    expect(opts.tools).toBeUndefined(); // no longer the read-only chat subset
    expect(opts.noTools).toBeFalsy();
    // Work starts on the click: the agent is handed the implementation order, not parked idle.
    expect(prompts.at(-1)).toMatch(/implement/i);
    expect(prompts.at(-1)).toContain(agent.branch);
    expect(agent.status).toBe("queued");
  });

  it("restores the chat when the worktree cannot be created", async () => {
    const { sup, registry, worktree } = make();
    const g = registry.upsertProject({ id: "p1", name: "g", localRepoPath: "/tmp/proj" });
    const chat = await discussedChat(sup, g.id, "Додати експорт у CSV");
    worktree.addWorktree.mockRejectedValueOnce(new Error("worktree add failed"));

    await expect(sup.promoteChatToAgent(chat.id)).rejects.toThrow(/worktree add failed/);

    const row = registry.listSessions(g.id).find((s) => s.id === chat.id)!;
    expect(row.kind).toBe("chat");
    expect(row.branch).toBe("");
    expect(row.worktreePath).toBe("");
    expect(registry.listSessions(g.id)).toHaveLength(1);
  });

  it("rejects promotion before the chat has an omp session", async () => {
    const { sup, registry } = make();
    const g = registry.upsertProject({ id: "p1", name: "g", localRepoPath: "/tmp/proj" });
    const chat = registry.createSession({
      projectId: g.id, name: "чат 1", task: "", worktreePath: "", branch: "",
      worktree: false, kind: "chat",
    });
    await expect(sup.promoteChatToAgent(chat.id)).rejects.toThrow(/omp session/i);
  });
});
