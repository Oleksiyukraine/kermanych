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

function make() {
  const registry = new RegistryService(":memory:");
  // Partial stub: sendMessage/resume only reach isGitRepo + currentBranch. Cast through
  // unknown at the DI boundary rather than implement the full WorktreeService surface.
  const worktree = {
    isGitRepo: vi.fn().mockResolvedValue(true),
    currentBranch: vi.fn().mockResolvedValue("main"),
  } as unknown as WorktreeService;
  const sup = new SupervisorService(registry, worktree);
  return { sup, registry };
}

beforeEach(() => { instances.length = 0; });

describe("sendMessage resume-on-dead", () => {
  it("respawns a dead omp child instead of writing to its closed stdin", async () => {
    const { sup, registry } = make();
    const g = registry.createGroup({ name: "g", projectDir: "/tmp/proj" });
    const s = registry.createSession({ groupId: g.id, name: "AAA", task: "t", worktreePath: "/tmp/wt", branch: "feature/aaa" });
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
    const g = registry.createGroup({ name: "g", projectDir: "/tmp/proj" });
    const s = registry.createSession({ groupId: g.id, name: "AAA", task: "t", worktreePath: "/tmp/wt", branch: "feature/aaa" });
    registry.updateSession(s.id, { ompSessionFile: "/tmp/s.jsonl", status: "done" });

    await sup.sendMessage(s.id, "one", "follow_up");
    await sup.sendMessage(s.id, "two", "follow_up"); // child still alive → same instance
    expect(instances).toHaveLength(1);
    expect(instances[0].followUps).toBe(2);
  });
});
