import { describe, it, expect, vi, beforeEach } from "vitest";
import type { WorktreeService } from "../src/worktree/worktree.service";

// Capture the prompt payloads so the tests can assert WHAT the session's omp agent is
// asked to do when Kermanych delegates PR creation to it (agent-driven, like resolveConflict).
type RpcOpts = { cwd: string; fork?: string; noTools?: boolean; tools?: string[] };
const started: RpcOpts[] = [];
const prompts: string[] = [];
vi.mock("../src/rpc/rpc-session", () => {
  class FakeRpc {
    constructor(opts: RpcOpts) { started.push(opts); }
    onEvent() {} onExit() {}
    async start() {}
    async switchSession() {}
    async getState() { return { sessionId: "c", sessionFile: "/tmp/c.jsonl" }; }
    async getAllMessages() { return []; }
    async stop() {}
    prompt(text: string) { prompts.push(text); }
    followUp(text: string) { prompts.push(text); }
    steer(text: string) { prompts.push(text); }
  }
  return { RpcSession: FakeRpc };
});

import { SupervisorService } from "../src/supervisor/supervisor.service";
import { RegistryService } from "../src/registry/registry.service";

function make() {
  const registry = new RegistryService(":memory:");
  const worktree = { currentBranch: vi.fn().mockResolvedValue("main") };
  // Partial mock: createPullRequest only resumes the agent — the DI seam is cast once.
  const sup = new SupervisorService(registry, worktree as unknown as WorktreeService);
  return { sup, registry };
}
beforeEach(() => { started.length = 0; prompts.length = 0; });

describe("createPullRequest", () => {
  it("refuses to open a PR for a non-agent session", async () => {
    const { sup, registry } = make();
    const g = registry.createGroup({ name: "g", projectDir: "/tmp/proj" });
    const parent = registry.createSession({ groupId: g.id, name: "AAA", task: "t", worktreePath: "/tmp/wt", branch: "feature/aaa" });
    registry.updateSession(parent.id, { ompSessionFile: "/tmp/aaa.jsonl", status: "done" });
    const disc = await sup.branchSession(parent.id);

    await expect(sup.createPullRequest(disc.id)).rejects.toThrow(/agent/i);
  });

  it("tells the agent to commit, push and open a PR at the base branch, using the built-in fallback", async () => {
    const { sup, registry } = make();
    const g = registry.createGroup({ name: "g", projectDir: "/tmp/proj" });
    const s = registry.createSession({ groupId: g.id, name: "AAA", task: "t", worktreePath: "/tmp/wt", branch: "feature/aaa", baseBranch: "dev" });
    registry.updateSession(s.id, { ompSessionFile: "/tmp/aaa.jsonl", status: "done" });

    await sup.createPullRequest(s.id);

    const p = prompts.at(-1)!;
    expect(p).toContain("feature/aaa"); // the head branch to push
    expect(p).toContain("dev"); // base-branch hint from session.baseBranch
    expect(p).toMatch(/gh pr create/); // opens the PR via gh
    expect(p).toMatch(/push/i); // pushes the branch first
    expect(p).toMatch(/Conventional Commits/); // Kermanych's built-in fallback conventions
  });

  it("prefers the group's own convention fallback over the built-in default", async () => {
    const { sup, registry } = make();
    const g = registry.createGroup({ name: "g", projectDir: "/tmp/proj", conventions: "HOUSE RULE: squash-merge only" });
    const s = registry.createSession({ groupId: g.id, name: "AAA", task: "t", worktreePath: "/tmp/wt", branch: "feature/aaa", baseBranch: "dev" });
    registry.updateSession(s.id, { status: "done" });

    await sup.createPullRequest(s.id);

    const p = prompts.at(-1)!;
    expect(p).toContain("HOUSE RULE: squash-merge only");
    expect(p).not.toContain("Conventional Commits");
  });
});
