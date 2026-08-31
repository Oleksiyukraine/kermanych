import { describe, it, expect, vi, beforeEach } from "vitest";
import type { WorktreeService } from "../src/worktree/worktree.service";
import type { RpcEvent, ServerEvent, ThinkingLevel } from "@kermanych/core";

// The supervisor's own event callback, so a test can play omp frames at it.
let emit: (e: RpcEvent) => void = () => {};
// What omp reports as its current thinking level on a state poll, when it reports one.
let reportedLevel: ThinkingLevel | undefined;
// Every set_thinking_level the supervisor sent, in order, and whether the child accepts them.
let levelsSet: ThinkingLevel[] = [];
let refuse = false;
// The order commands arrived in on a resumed child: restoring the effort BEFORE
// switch_session would be silently undone by the session file the switch loads.
let resumeOrder: string[] = [];

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
      return { sessionId: "omp-1", sessionFile: "/tmp/s.jsonl", ...(reportedLevel ? { thinkingLevel: reportedLevel } : {}) };
    }
    async getAllMessages() {
      return [];
    }
    async switchSession() {
      resumeOrder.push("switch_session");
    }
    async setThinkingLevel(level: ThinkingLevel) {
      resumeOrder.push("set_thinking_level");
      if (refuse) throw new Error("thinking level not supported by provider");
      levelsSet.push(level);
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
  const seen: ServerEvent[] = [];
  sup.events$.subscribe((e) => seen.push(e));
  return { sup, registry, seen };
}

// A live child without a cloud round-trip. `createSessionFromTask` is the only fresh birth
// path and it needs the cloud; resuming a retired row spawns the very child the effort chip
// talks to, which is all these tests need. The row starts effort-free, so the resume adds
// nothing to `levelsSet` before setEffort runs.
async function liveSession(sup: SupervisorService, registry: RegistryService, projectId: string) {
  const s = registry.createSession({ projectId, name: "AAA", task: "t", worktreePath: "/tmp/wt", branch: "feature/aaa", model: "opus-5" });
  registry.updateSession(s.id, { ompSessionFile: "/tmp/s.jsonl", status: "done" });
  await sup.sendMessage(s.id, "go", "follow_up");
  return s;
}

beforeEach(() => {
  emit = () => {};
  reportedLevel = undefined;
  levelsSet = [];
  resumeOrder = [];
  refuse = false;
});

describe("session effort", () => {
  it("tells the live child first, then records the level and broadcasts it", async () => {
    const { sup, registry, seen } = make();
    const g = registry.upsertProject({ id: "p1", name: "g", localRepoPath: "/tmp/proj" });
    const s = await liveSession(sup, registry, g.id);

    const out = await sup.setEffort(s.id, "max");

    expect(levelsSet).toEqual(["max"]);
    expect(out.effort).toBe("max");
    expect(registry.listSessions().find((x) => x.id === s.id)?.effort).toBe("max");
    expect(seen.filter((e) => e.type === "session_update" && e.session.id === s.id && e.session.effort === "max")).not.toHaveLength(0);
  });

  // omp refuses a level its provider cannot run. Writing the row anyway would leave the
  // composer naming an effort the agent is not thinking at — the one failure the chip cannot
  // show, because it looks exactly like success.
  it("leaves the row untouched when the child refuses the level", async () => {
    const { sup, registry } = make();
    const g = registry.upsertProject({ id: "p1", name: "g", localRepoPath: "/tmp/proj" });
    const s = await liveSession(sup, registry, g.id);
    await sup.setEffort(s.id, "low");
    refuse = true;

    await expect(sup.setEffort(s.id, "max")).rejects.toThrow(/not supported by provider/);
    expect(registry.listSessions().find((x) => x.id === s.id)?.effort).toBe("low");
  });

  // A backlog task has no child to tell: the level is launch config, consumed as `--thinking`
  // when it is started. Waking an omp process to record a preference would be absurd.
  it("records the level on a backlog task without spawning anything", async () => {
    const { sup, registry } = make();
    const g = registry.upsertProject({ id: "p1", name: "g", localRepoPath: "/tmp/proj" });
    // A dormant row with no live child: the merged birth path always spawns, so a backlog
    // leftover is minted straight on the registry — setEffort has nothing to wake.
    const task = registry.createSession({ projectId: g.id, name: "AAA", task: "t", worktreePath: "", branch: "", model: "opus-5" });
    registry.updateSession(task.id, { status: "backlog" });

    const out = await sup.setEffort(task.id, "medium");

    expect(levelsSet).toEqual([]);
    expect(out.effort).toBe("medium");
    expect(registry.listSessions().find((x) => x.id === task.id)?.status).toBe("backlog");
  });

  // Effort is live state, not a launch parameter: omp's own UI can change it mid-session on a
  // shared session file, so the poll reconciles rather than settling once like the model does.
  it("adopts the level omp reports when it was changed outside Kermanych", async () => {
    const { sup, registry } = make();
    const g = registry.upsertProject({ id: "p1", name: "g", localRepoPath: "/tmp/proj" });
    const s = await liveSession(sup, registry, g.id);
    await sup.setEffort(s.id, "low");
    reportedLevel = "minimal";

    emit({ type: "agent_end" });
    await vi.waitFor(() => {
      expect(registry.listSessions().find((x) => x.id === s.id)?.effort).toBe("minimal");
    });
  });

  // The reloaded session file carries its own thinking level, so a restore that ran before the
  // switch would be overwritten by it.
  it("re-asserts the saved level after the resumed child loads its session file", async () => {
    const { sup, registry } = make();
    const g = registry.upsertProject({ id: "p1", name: "g", localRepoPath: "/tmp/proj" });
    const s = registry.createSession({ projectId: g.id, name: "AAA", task: "t", worktreePath: "/tmp/wt", branch: "feature/aaa", model: "opus-5", effort: "xhigh" });
    registry.updateSession(s.id, { ompSessionFile: "/tmp/s.jsonl", status: "done" });

    await sup.sendMessage(s.id, "go", "follow_up");

    expect(levelsSet).toEqual(["xhigh"]);
    expect(resumeOrder).toEqual(["switch_session", "set_thinking_level"]);
  });

  // A child that cannot take the level must not cost the operator the whole resume — the poll
  // then reports whatever omp actually settled on.
  it("resumes anyway when the child refuses to restore the level", async () => {
    const { sup, registry } = make();
    const g = registry.upsertProject({ id: "p1", name: "g", localRepoPath: "/tmp/proj" });
    const s = registry.createSession({ projectId: g.id, name: "AAA", task: "t", worktreePath: "/tmp/wt", branch: "feature/aaa", model: "opus-5", effort: "max" });
    registry.updateSession(s.id, { ompSessionFile: "/tmp/s.jsonl", status: "done" });
    refuse = true;

    await expect(sup.sendMessage(s.id, "go", "follow_up")).resolves.toBeUndefined();
  });
});
