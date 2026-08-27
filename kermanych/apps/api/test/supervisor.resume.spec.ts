import { describe, it, expect, vi, beforeEach } from "vitest";
import type { WorktreeService } from "../src/worktree/worktree.service";

// Every spawned RpcSession is captured so the test can inspect which child a message was
// delivered to and can simulate a child dying (a provider outage killing the omp process).
type FakeChild = { alive: boolean; prompts: number; followUps: number; steers: number };
const instances: FakeChild[] = [];

vi.mock("../src/rpc/rpc-session", () => {
  class FakeRpc {
    alive = true;
    prompts = 0;
    followUps = 0;
    steers = 0;
    constructor(_opts: unknown) { instances.push(this); }
    onEvent() {}
    onExit() {}
    async start() {}
    async getState() { return { sessionId: "omp-1", sessionFile: "/tmp/s.jsonl" }; }
    async getAllMessages() { return []; }
    async switchSession() {}
    async stop() {}
    isAlive() { return this.alive; }
    prompt() { this.prompts++; }
    followUp() { this.followUps++; }
    steer() { this.steers++; }
  }
  return { RpcSession: FakeRpc };
});

import { SupervisorService } from "../src/supervisor/supervisor.service";
import { RegistryService } from "../src/registry/registry.service";
import { offlineAuth } from "./offline-auth";
import { stubSkills } from "./skills-stub";

function make() {
  const registry = new RegistryService(":memory:");
  // Partial stub: sendMessage/resume only reach isGitRepo + currentBranch. Cast through
  // unknown at the DI boundary rather than implement the full WorktreeService surface.
  const worktree = {
    isGitRepo: vi.fn().mockResolvedValue(true),
    currentBranch: vi.fn().mockResolvedValue("main"),
  } as unknown as WorktreeService;
  const sup = new SupervisorService(registry, worktree, offlineAuth(), stubSkills());
  return { sup, registry };
}

beforeEach(() => { instances.length = 0; });

describe("sendMessage resume-on-dead", () => {
  it("respawns a dead omp child instead of writing to its closed stdin", async () => {
    const { sup, registry } = make();
    const g = registry.upsertProject({ id: "p1", name: "g", localRepoPath: "/tmp/proj" });
    const s = registry.createSession({ projectId: g.id, name: "AAA", task: "t", worktreePath: "/tmp/wt", branch: "feature/aaa" });
    registry.updateSession(s.id, { ompSessionFile: "/tmp/s.jsonl", status: "done" });

    // First send: dormant (no Live) → resume spawns child #0 and delivers the message.
    await sup.sendMessage(s.id, "one", "follow_up");
    expect(instances).toHaveLength(1);
    expect(instances[0].followUps).toBe(1);

    // A provider outage kills the child after its turn ended (status stayed "done", so
    // onExit left the stale Live in place — the exact "готово + no response" scenario).
    instances[0].alive = false;

    // Second send: the dead Live must be dropped and a fresh child spawned. The message
    // lands on the NEW child, never on the corpse (a write there would EPIPE-vanish).
    await sup.sendMessage(s.id, "two", "follow_up");
    expect(instances).toHaveLength(2);
    expect(instances[1].followUps).toBe(1);
    expect(instances[0].followUps).toBe(1); // corpse is never written to again
  });

  it("reuses a live child without respawning", async () => {
    const { sup, registry } = make();
    const g = registry.upsertProject({ id: "p1", name: "g", localRepoPath: "/tmp/proj" });
    const s = registry.createSession({ projectId: g.id, name: "AAA", task: "t", worktreePath: "/tmp/wt", branch: "feature/aaa" });
    registry.updateSession(s.id, { ompSessionFile: "/tmp/s.jsonl", status: "done" });

    await sup.sendMessage(s.id, "one", "follow_up");
    await sup.sendMessage(s.id, "two", "follow_up"); // child still alive → same instance
    expect(instances).toHaveLength(1);
    expect(instances[0].followUps).toBe(2);
  });
});

describe("resume", () => {
  it("rehydrates a dormant session without prompting the agent", async () => {
    const { sup, registry } = make();
    const g = registry.upsertProject({ id: "p1", name: "g", localRepoPath: "/tmp/proj" });
    const s = registry.createSession({ projectId: g.id, name: "AAA", task: "t", worktreePath: "/tmp/wt", branch: "feature/aaa" });
    registry.updateSession(s.id, { ompSessionFile: "/tmp/s.jsonl", status: "done" });

    // Dormant (the state every session is in right after an app restart): the transcript
    // endpoint can only serve the synthesised "session is dormant" notice, so the chat reads
    // empty however often the client refetches.
    expect(sup.getTranscript(s.id)).toEqual([
      expect.objectContaining({ kind: "notice", id: "dormant" }),
    ]);

    expect(await sup.resume(s.id)).toEqual({ ok: true });

    // A child is up and the transcript now comes from omp's own history (empty here — the fake
    // has no messages), not from the dormant placeholder.
    expect(instances).toHaveLength(1);
    expect(sup.getTranscript(s.id)).toEqual([]);
    // Waking the session must not put words in the operator's mouth: no turn was started.
    expect(instances[0]).toMatchObject({ prompts: 0, followUps: 0, steers: 0 });
  });

  it("leaves a live session and its running turn alone", async () => {
    const { sup, registry } = make();
    const g = registry.upsertProject({ id: "p1", name: "g", localRepoPath: "/tmp/proj" });
    const s = registry.createSession({ projectId: g.id, name: "AAA", task: "t", worktreePath: "/tmp/wt", branch: "feature/aaa" });
    registry.updateSession(s.id, { ompSessionFile: "/tmp/s.jsonl", status: "done" });

    await sup.sendMessage(s.id, "one", "follow_up");
    await sup.resume(s.id);

    // Unlike restartSession, resume never kills the child: same instance, turn untouched.
    expect(instances).toHaveLength(1);
    expect(instances[0].alive).toBe(true);
    expect(instances[0].followUps).toBe(1);
  });
});
