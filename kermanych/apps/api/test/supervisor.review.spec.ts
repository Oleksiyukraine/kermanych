import { describe, it, expect, vi, beforeEach } from "vitest";
import type { WorktreeService } from "../src/worktree/worktree.service";

// Capture RpcSession constructor opts and prompt payloads so the tests can assert
// HOW the reviewer omp child is launched (fresh, read-only) and WHAT it is asked.
type RpcOpts = { cwd: string; fork?: string; noTools?: boolean; tools?: string[] };
const started: RpcOpts[] = [];
const prompts: string[] = [];
vi.mock("../src/rpc/rpc-session", () => {
  class FakeRpc {
    constructor(opts: RpcOpts) { started.push(opts); }
    onEvent() {} onExit() {}
    async start() {} async getState() { return { sessionId: "c", sessionFile: "/tmp/c.jsonl" }; }
    async getAllMessages() { return []; } async switchSession() {} async stop() {}
    prompt(m: string) { prompts.push(m); } followUp() {} steer() {}
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
    addWorktree: vi.fn(), removeWorktree: vi.fn(), removeBranch: vi.fn(),
    createBranchHere: vi.fn(), checkout: vi.fn(),
    currentBranch: vi.fn().mockResolvedValue("main"),
    hasUncommitted: vi.fn().mockResolvedValue(false),
    diff: vi.fn().mockResolvedValue("diff --git a/x.ts b/x.ts\n+const answer = 42;"),
  };
  // Partial mock: reviewSession only touches these worktree ops. Cast once at the DI seam.
  const sup = new SupervisorService(registry, worktree as unknown as WorktreeService, offlineAuth(), stubSkills());
  return { sup, registry, worktree };
}

beforeEach(() => { started.length = 0; prompts.length = 0; });

describe("reviewSession", () => {
  it("spawns an independent reviewer: review child, read-only tools, no fork", async () => {
    const { sup, registry } = make();
    const g = registry.upsertProject({ id: "p1", name: "g", localRepoPath: "/tmp/proj" });
    const parent = registry.createSession({ projectId: g.id, name: "AAA", task: "Add feature X", worktreePath: "/tmp/wt", branch: "feature/aaa" });
    registry.updateSession(parent.id, { status: "done" });

    const review = await sup.reviewSession(parent.id);

    expect(review.kind).toBe("review");
    expect(review.parentSessionId).toBe(parent.id);
    expect(review.worktree).toBe(false);
    // Fresh conversation (no --fork) with a read-only tool subset, in the doer's worktree.
    const opts = started.at(-1)!;
    expect(opts).toMatchObject({ cwd: "/tmp/wt", tools: ["read", "grep", "glob"] });
    expect(opts.fork).toBeUndefined();
    expect(opts.noTools).toBeFalsy();
  });

  it("seeds the reviewer with the original task and the branch diff, not the doer's transcript", async () => {
    const { sup, registry, worktree } = make();
    const g = registry.upsertProject({ id: "p1", name: "g", localRepoPath: "/tmp/proj" });
    const parent = registry.createSession({ projectId: g.id, name: "AAA", task: "Add feature X", worktreePath: "/tmp/wt", branch: "feature/aaa" });
    registry.updateSession(parent.id, { status: "done" });

    await sup.reviewSession(parent.id);

    // Diff computed against the project's current branch, inside the doer's worktree.
    expect(worktree.diff).toHaveBeenCalledWith("/tmp/wt", "main");
    const p = prompts.at(-1)!;
    expect(p).toContain("Add feature X");
    expect(p).toContain("+const answer = 42;");
  });

  it("refuses to review a non-agent session", async () => {
    const { sup, registry } = make();
    const g = registry.upsertProject({ id: "p1", name: "g", localRepoPath: "/tmp/proj" });
    const parent = registry.createSession({ projectId: g.id, name: "AAA", task: "t", worktreePath: "/tmp/wt", branch: "feature/aaa" });
    registry.updateSession(parent.id, { ompSessionFile: "/tmp/aaa.jsonl", status: "done" });
    const disc = await sup.branchSession(parent.id);

    await expect(sup.reviewSession(disc.id)).rejects.toThrow(/agent/i);
  });

  it("refuses to review when the branch has no changes", async () => {
    const { sup, registry, worktree } = make();
    const g = registry.upsertProject({ id: "p1", name: "g", localRepoPath: "/tmp/proj" });
    const parent = registry.createSession({ projectId: g.id, name: "AAA", task: "t", worktreePath: "/tmp/wt", branch: "feature/aaa" });
    registry.updateSession(parent.id, { status: "done" });
    worktree.diff.mockResolvedValueOnce("   \n");

    await expect(sup.reviewSession(parent.id)).rejects.toThrow(/nothing to review|no changes/i);
  });

  it("pours a review's conclusion into the parent and retires the review as merged", async () => {
    const { sup, registry } = make();
    const g = registry.upsertProject({ id: "p1", name: "g", localRepoPath: "/tmp/proj" });
    const parent = registry.createSession({ projectId: g.id, name: "AAA", task: "t", worktreePath: "/tmp/wt", branch: "feature/aaa" });
    registry.updateSession(parent.id, { ompSessionFile: "/tmp/aaa.jsonl", status: "done" });

    const review = await sup.reviewSession(parent.id);
    await sup.mergeDiscussion(review.id, "Verdict: needs changes — bug in X");

    const updated = registry.listSessions(g.id).find((x) => x.id === review.id)!;
    expect(updated.status).toBe("merged");
    // The parent was handed the reviewer's conclusion, labelled as a review.
    expect(prompts.at(-1)).toContain("Verdict: needs changes — bug in X");
    expect(prompts.at(-1)).toMatch(/ревізі/i);
  });
});
