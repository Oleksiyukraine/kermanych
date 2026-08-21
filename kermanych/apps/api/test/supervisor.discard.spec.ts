import { describe, it, expect, vi, beforeEach } from "vitest";
const started: any[] = [];
vi.mock("../src/rpc/rpc-session", () => {
  class FakeRpc {
    constructor(opts: any) { started.push(opts); }
    onEvent() {} onExit() {}
    async start() {} async getState() { return { sessionId: "c", sessionFile: "/tmp/c.jsonl" }; }
    async getAllMessages() { return []; } async stop() {}
    prompt() {} followUp() {} steer() {}
  }
  return { RpcSession: FakeRpc };
});
import { SupervisorService } from "../src/supervisor/supervisor.service";
import { RegistryService } from "../src/registry/registry.service";

function make() {
  const registry = new RegistryService(":memory:");
  const worktree = {
    removeWorktree: vi.fn(), removeBranch: vi.fn(), checkout: vi.fn(),
    currentBranch: vi.fn().mockResolvedValue("main"),
  } as any;
  return { sup: new SupervisorService(registry, worktree), registry, worktree };
}
beforeEach(() => { started.length = 0; });

describe("discard + cascade", () => {
  it("deletes a discussion child without any git calls", async () => {
    const { sup, registry, worktree } = make();
    const g = registry.upsertProject({ id: "p1", name: "g", localRepoPath: "/tmp/proj" });
    const parent = registry.createSession({ projectId: g.id, name: "AAA", task: "t", worktreePath: "/tmp/wt", branch: "feature/aaa" });
    registry.updateSession(parent.id, { ompSessionFile: "/tmp/aaa.jsonl", status: "done" });
    await sup.branchSession(parent.id);
    const child = registry.listSessions(g.id).find((x) => x.kind === "discussion")!;

    await sup.deleteSession(child.id);

    expect(registry.listSessions(g.id).find((x) => x.id === child.id)).toBeUndefined();
    expect(worktree.removeBranch).not.toHaveBeenCalled();
    expect(worktree.checkout).not.toHaveBeenCalled();
    expect(worktree.removeWorktree).not.toHaveBeenCalled();
  });

  it("cascade-deletes children when the parent is deleted", async () => {
    const { sup, registry } = make();
    const g = registry.upsertProject({ id: "p1", name: "g", localRepoPath: "/tmp/proj" });
    const parent = registry.createSession({ projectId: g.id, name: "AAA", task: "t", worktreePath: "", branch: "feature/aaa", worktree: false, baseBranch: "main" });
    registry.updateSession(parent.id, { ompSessionFile: "/tmp/aaa.jsonl", status: "done" });
    await sup.branchSession(parent.id);
    expect(registry.listSessions(g.id).some((x) => x.kind === "discussion")).toBe(true);

    await sup.deleteSession(parent.id);

    expect(registry.listSessions(g.id)).toHaveLength(0);
  });

  it("refuses finishSession on a discussion branch", async () => {
    const { sup, registry } = make();
    const g = registry.upsertProject({ id: "p1", name: "g", localRepoPath: "/tmp/proj" });
    const parent = registry.createSession({ projectId: g.id, name: "AAA", task: "t", worktreePath: "/tmp/wt", branch: "feature/aaa" });
    registry.updateSession(parent.id, { ompSessionFile: "/tmp/aaa.jsonl", status: "done" });
    await sup.branchSession(parent.id);
    const child = registry.listSessions(g.id).find((x) => x.kind === "discussion")!;
    await expect(sup.finishSession(child.id)).rejects.toThrow(/discussion/i);
  });
});
