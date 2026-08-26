import { describe, it, expect, vi, beforeEach } from "vitest";
import type { WorktreeService } from "../src/worktree/worktree.service";
import type { RpcEvent, ServerEvent } from "@kermanych/core";

// The supervisor's own event callback, so a test can play omp frames at it and read back
// what it recorded on the session row.
let emit: (e: RpcEvent) => void = () => {};
// What a resumed child reports as its prior conversation.
let history: unknown[] = [];
// What omp says it is actually running, when it says anything at all.
let reportedModel: { provider: string; id: string } | undefined;
vi.mock("../src/rpc/rpc-session", () => {
  class FakeRpc {
    onEvent(cb: (e: RpcEvent) => void) {
      emit = cb;
    }
    onExit() {}
    async start() {}
    isAlive() {
      return true;
    }
    async getState() {
      return { sessionId: "omp-1", sessionFile: "/tmp/s.jsonl", ...(reportedModel ? { model: reportedModel } : {}) };
    }
    async getAllMessages() {
      return history;
    }
    async switchSession() {}
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
  const sup = new SupervisorService(registry, worktree as unknown as WorktreeService, offlineAuth());
  const seen: ServerEvent[] = [];
  sup.events$.subscribe((e) => seen.push(e));
  return { sup, registry, seen };
}

function turn(usage: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; cost: number }): RpcEvent {
  return {
    type: "message_end",
    message: { role: "assistant", model: "claude-opus-4-8", duration: 900, usage: { ...usage, cost: { total: usage.cost } } },
  };
}

beforeEach(() => {
  emit = () => {};
  history = [];
  reportedModel = undefined;
});

describe("session usage", () => {
  it("sums every live turn onto the session row and broadcasts the new total", async () => {
    const { sup, registry, seen } = make();
    const g = registry.upsertProject({ id: "p1", name: "g", localRepoPath: "/tmp/proj" });
    const chat = await sup.createChat(g.id);

    emit(turn({ input: 5, output: 7, cacheRead: 1000, cost: 0.5 }));
    emit(turn({ input: 3, output: 4, cacheWrite: 200, cost: 0.25 }));

    expect(registry.listSessions().find((s) => s.id === chat.id)?.usage).toEqual({
      input: 8, output: 11, cacheRead: 1000, cacheWrite: 200, cost: 0.75,
    });
    // The board reads the figure off the session snapshot, so a turn landing has to push
    // one — the status alone does not change from `thinking` when a turn is priced.
    const pushed = seen.filter((e) => e.type === "session_update" && e.session.usage?.cost === 0.75);
    expect(pushed.length).toBeGreaterThan(0);
  });

  it("leaves a session that never took a counted turn without a figure at all", async () => {
    const { sup, registry } = make();
    const g = registry.upsertProject({ id: "p1", name: "g", localRepoPath: "/tmp/proj" });
    const chat = await sup.createChat(g.id);

    // Absent, not zeroed: a `{cost: 0}` here would let the card claim a free agent.
    expect(registry.listSessions().find((s) => s.id === chat.id)?.usage).toBeUndefined();
  });

  it("does not bill a resumed session for the history omp replays at it", async () => {
    const { sup, registry } = make();
    const g = registry.upsertProject({ id: "p1", name: "g", localRepoPath: "/tmp/proj" });
    const s = registry.createSession({ projectId: g.id, name: "AAA", task: "t", worktreePath: "/tmp/wt", branch: "feature/aaa" });
    registry.updateSession(s.id, { ompSessionFile: "/tmp/s.jsonl", status: "done" });
    // omp hands back the whole prior conversation on resume — including its priced turns.
    // Counting those would double the total on every reload, and would bill a forked branch
    // for turns its parent paid for, since a fork rehydrates the same way.
    history = [{ role: "assistant", content: [{ type: "text", text: "earlier" }], model: "claude-opus-4-8", usage: { input: 900, output: 100, cost: { total: 9 } } }];

    await sup.sendMessage(s.id, "again", "follow_up");
    expect(registry.listSessions().find((x) => x.id === s.id)?.usage).toBeUndefined();

    // Only the turn we watched happen counts.
    emit(turn({ input: 1, output: 2, cost: 0.1 }));
    expect(registry.listSessions().find((x) => x.id === s.id)?.usage).toEqual({
      input: 1, output: 2, cacheRead: 0, cacheWrite: 0, cost: 0.1,
    });
  });

  it("records the model omp actually runs when the launch left it unset", async () => {
    const { sup, registry } = make();
    const g = registry.upsertProject({ id: "p1", name: "g", localRepoPath: "/tmp/proj" });
    reportedModel = { provider: "anthropic", id: "claude-opus-4-8" };

    // A chat is launched with no model at all — omp picks one, and createChat's own
    // refreshState is where that reading gets recorded, so the row can name what is running.
    const chat = await sup.createChat(g.id);
    expect(registry.listSessions().find((s) => s.id === chat.id)?.model).toBe("claude-opus-4-8");
  });

  it("never overwrites the model the operator chose at launch", async () => {
    const { sup, registry } = make();
    const g = registry.upsertProject({ id: "p1", name: "g", localRepoPath: "/tmp/proj" });
    reportedModel = { provider: "anthropic", id: "claude-opus-4-8" };
    const s = registry.createSession({ projectId: g.id, name: "AAA", task: "t", worktreePath: "/tmp/wt", branch: "feature/aaa", model: "opus-5" });
    registry.updateSession(s.id, { ompSessionFile: "/tmp/s.jsonl", status: "done" });

    await sup.sendMessage(s.id, "go", "follow_up");
    emit({ type: "agent_end" });
    // `model` is the launch parameter a relaunch has to reuse, not a reading of this run.
    await vi.waitFor(() => {
      expect(registry.listSessions().find((x) => x.id === s.id)?.ompSessionId).toBe("omp-1");
    });
    expect(registry.listSessions().find((x) => x.id === s.id)?.model).toBe("opus-5");
  });
});
