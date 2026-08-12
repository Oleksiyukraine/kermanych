import { describe, it, expect, vi, beforeEach } from "vitest";

const started: any[] = [];
vi.mock("../src/rpc/rpc-session", () => {
  class FakeRpc {
    opts: any;
    constructor(opts: any) { this.opts = opts; started.push(opts); }
    onEvent() {}
    onExit() {}
    async start() {}
    async getState() { return { sessionId: "omp-child", sessionFile: "/tmp/child.jsonl" }; }
    async getAllMessages() { return [{ role: "assistant", content: [{ type: "text", text: "inherited" }] }]; }
    async stop() {}
    prompt() {} followUp() {} steer() {}
  }
  return { RpcSession: FakeRpc };
});

import { SupervisorService } from "../src/supervisor/supervisor.service";
import { RegistryService } from "../src/registry/registry.service";

function make() {
  const registry = new RegistryService(":memory:");
  const worktree = {
    isGitRepo: vi.fn().mockResolvedValue(true),
    addWorktree: vi.fn(), removeWorktree: vi.fn(), removeBranch: vi.fn(),
    createBranchHere: vi.fn(), checkout: vi.fn(), currentBranch: vi.fn().mockResolvedValue("main"),
    hasUncommitted: vi.fn().mockResolvedValue(false),
  } as any;
  const sup = new SupervisorService(registry, worktree);
  return { sup, registry, worktree };
}

beforeEach(() => { started.length = 0; });

describe("branchSession", () => {
  it("forks a discussion child with parent link and no git", async () => {
    const { sup, registry } = make();
    const g = registry.createGroup({ name: "g", projectDir: "/tmp/proj" });
    // Seed a parent that already has an omp session file.
    const parent = registry.createSession({ groupId: g.id, name: "AAA", task: "t", worktreePath: "/tmp/wt", branch: "feature/aaa" });
    registry.updateSession(parent.id, { ompSessionFile: "/tmp/aaa.jsonl", status: "done" });

    const child = await sup.branchSession(parent.id);

    expect(child.kind).toBe("discussion");
    expect(child.parentSessionId).toBe(parent.id);
    expect(child.worktree).toBe(false);
    // Forked from the parent file, no tools, parent's cwd.
    expect(started.at(-1)).toMatchObject({ fork: "/tmp/aaa.jsonl", noTools: true, cwd: "/tmp/wt" });
  });

  it("rejects branching when the parent has no omp session file", async () => {
    const { sup, registry } = make();
    const g = registry.createGroup({ name: "g", projectDir: "/tmp/proj" });
    const parent = registry.createSession({ groupId: g.id, name: "AAA", task: "t", worktreePath: "", branch: "b" });
    await expect(sup.branchSession(parent.id)).rejects.toThrow(/omp session/i);
  });
});
