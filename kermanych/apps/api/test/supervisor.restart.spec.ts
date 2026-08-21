import { describe, it, expect, vi, beforeEach } from "vitest";
import type { WorktreeService } from "../src/worktree/worktree.service";

// Capture every spawned RpcSession + whether it was stopped, so the test can assert that
// restartSession kills the running child and brings up a fresh one.
type FakeChild = { stopped: boolean; alive: boolean };
const instances: FakeChild[] = [];

vi.mock("../src/rpc/rpc-session", () => {
  class FakeRpc {
    stopped = false;
    alive = true;
    constructor(_opts: unknown) { instances.push(this); }
    onEvent() {}
    onExit() {}
    async start() {}
    async getState() { return { sessionId: "omp-1", sessionFile: "/tmp/s.jsonl" }; }
    async getAllMessages() { return []; }
    async switchSession() {}
    async stop() { this.stopped = true; }
    isAlive() { return this.alive; }
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
    currentBranch: vi.fn().mockResolvedValue("main"),
  } as unknown as WorktreeService;
  const sup = new SupervisorService(registry, worktree);
  return { sup, registry };
}

beforeEach(() => { instances.length = 0; });

describe("restartSession", () => {
  it("kills the running child and respawns a fresh one", async () => {
    const { sup, registry } = make();
    const g = registry.upsertProject({ id: "p1", name: "g", localRepoPath: "/tmp/proj" });
    const s = registry.createSession({ projectId: g.id, name: "AAA", task: "t", worktreePath: "/tmp/wt", branch: "feature/aaa" });
    registry.updateSession(s.id, { ompSessionFile: "/tmp/s.jsonl", status: "done" });

    // Bring up a live child (resume on the first send) — this is the "wedged" one.
    await sup.sendMessage(s.id, "one", "follow_up");
    expect(instances).toHaveLength(1);

    await sup.restartSession(s.id);

    // The old child was stopped and a brand-new child spawned in its place.
    expect(instances).toHaveLength(2);
    expect(instances[0].stopped).toBe(true);
    expect(instances[1].stopped).toBe(false);
  });

  it("resumes a dormant session that has no live child", async () => {
    const { sup, registry } = make();
    const g = registry.upsertProject({ id: "p1", name: "g", localRepoPath: "/tmp/proj" });
    const s = registry.createSession({ projectId: g.id, name: "AAA", task: "t", worktreePath: "/tmp/wt", branch: "feature/aaa" });
    registry.updateSession(s.id, { ompSessionFile: "/tmp/s.jsonl", status: "done" });

    await sup.restartSession(s.id); // no Live yet → just spawns
    expect(instances).toHaveLength(1);
  });
});
