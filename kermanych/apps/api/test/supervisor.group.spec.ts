import { describe, it, expect, vi } from "vitest";
import type { ServerEvent } from "@kermanych/core";
import type { WorktreeService } from "../src/worktree/worktree.service";

vi.mock("../src/rpc/rpc-session", () => {
  class FakeRpc {
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
  // DI seam: on the delete path SupervisorService only touches these worktree ops,
  // so a partial mock is sufficient; cast once at the boundary.
  const worktree = {
    removeWorktree: vi.fn(),
    removeBranch: vi.fn(),
    checkout: vi.fn(),
    currentBranch: vi.fn().mockResolvedValue("main"),
  } as unknown as WorktreeService;
  return { sup: new SupervisorService(registry, worktree), registry, worktree };
}

describe("removeGroup cascade", () => {
  it("wipes every agent, discussion branch, and worktree under the project", async () => {
    const { sup, registry, worktree } = make();
    const g = registry.createGroup({ name: "g", projectDir: "/tmp/proj" });

    // A worktree agent with a discussion sub-agent forked off it.
    const wtAgent = registry.createSession({ groupId: g.id, name: "WT", task: "t", worktreePath: "/tmp/wt", branch: "feature/wt" });
    registry.updateSession(wtAgent.id, { ompSessionFile: "/tmp/wt.jsonl", status: "done" });
    await sup.branchSession(wtAgent.id);
    const child = registry.listSessions(g.id).find((x) => x.kind === "discussion")!;
    expect(child).toBeDefined();

    // An in-place agent (no worktree) sharing the project dir.
    const inPlace = registry.createSession({
      groupId: g.id, name: "IP", task: "t", worktreePath: "", branch: "fix/ip",
      worktree: false, baseBranch: "main",
    });

    const events: ServerEvent[] = [];
    const sub = sup.events$.subscribe((e) => events.push(e));

    await sup.removeGroup(g.id);
    sub.unsubscribe();

    // Every session (both agents + the sub-agent) is gone, and so is the group.
    expect(registry.listSessions(g.id)).toHaveLength(0);
    expect(registry.listGroups().find((x) => x.id === g.id)).toBeUndefined();

    // The worktree agent's git worktree + branch were retired; the in-place agent's branch too.
    expect(worktree.removeWorktree).toHaveBeenCalledWith("/tmp/proj", "/tmp/wt");
    expect(worktree.removeBranch).toHaveBeenCalledWith("/tmp/proj", "feature/wt");
    expect(worktree.removeBranch).toHaveBeenCalledWith("/tmp/proj", "fix/ip");

    // Clients learn the group (and each session) disappeared.
    expect(events.some((e) => e.type === "group_removed" && e.groupId === g.id)).toBe(true);
    for (const id of [wtAgent.id, child.id, inPlace.id])
      expect(events.some((e) => e.type === "session_removed" && e.sessionId === id)).toBe(true);
  });

  it("removes an empty project with no sessions", async () => {
    const { sup, registry } = make();
    const g = registry.createGroup({ name: "empty", projectDir: "/tmp/empty" });

    await sup.removeGroup(g.id);

    expect(registry.listGroups().find((x) => x.id === g.id)).toBeUndefined();
  });
});
