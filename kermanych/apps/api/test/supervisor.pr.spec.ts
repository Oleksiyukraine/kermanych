import { describe, it, expect, vi, beforeEach } from "vitest";
import type { WorktreeService } from "../src/worktree/worktree.service";

// Capture the prompt payloads so the tests can assert WHAT the session's omp agent is
// asked to do when Kermanych delegates PR creation to it (agent-driven, like resolveConflict).
type RpcOpts = { cwd: string; fork?: string; noTools?: boolean; tools?: string[] };
const started: RpcOpts[] = [];
const prompts: string[] = [];
// The supervisor's own event sink, captured so a test can play a turn's `agent_end` back at
// it — that frame is where the PR request turns into a status.
const eventCbs: ((e: unknown) => void)[] = [];
vi.mock("../src/rpc/rpc-session", () => {
  class FakeRpc {
    constructor(opts: RpcOpts) { started.push(opts); }
    onEvent(cb: (e: unknown) => void) { eventCbs.push(cb); }
    onExit() {}
    async start() {}
    async switchSession() {}
    async getState() { return { sessionId: "c", sessionFile: "/tmp/c.jsonl" }; }
    async getAllMessages() { return []; }
    async stop() {}
    isAlive() { return true; }
    prompt(text: string) { prompts.push(text); }
    followUp(text: string) { prompts.push(text); }
    steer(text: string) { prompts.push(text); }
  }
  return { RpcSession: FakeRpc };
});

import { SupervisorService } from "../src/supervisor/supervisor.service";
import { RegistryService } from "../src/registry/registry.service";
import { offlineAuth } from "./offline-auth";
import { stubSkills } from "./skills-stub";
import type { SkillsService } from "../src/skills/skills.service";

function make(skills: SkillsService = stubSkills()) {
  const registry = new RegistryService(":memory:");
  const worktree = { currentBranch: vi.fn().mockResolvedValue("main") };
  // Partial mock: createPullRequest only resumes the agent — the DI seam is cast once.
  const sup = new SupervisorService(registry, worktree as unknown as WorktreeService, offlineAuth(), skills);
  return { sup, registry };
}

// Replay a turn that reports a PR URL — the signal Kermanych settles `in_review` on. A
// `text_delta` then an assistant `message_end` is the minimum that makes reduceRpcEvents
// emit an `assistant_text` entry carrying the URL.
function emitPrUrl(url = "https://github.com/o/r/pull/7"): void {
  for (const cb of eventCbs) {
    cb({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: `ПР відкрито: ${url}` } });
    cb({ type: "message_end", message: { role: "assistant" } });
  }
}
beforeEach(() => { started.length = 0; prompts.length = 0; eventCbs.length = 0; });

describe("createPullRequest", () => {
  it("refuses to open a PR for a non-agent session", async () => {
    const { sup, registry } = make();
    const g = registry.upsertProject({ id: "p1", name: "g", localRepoPath: "/tmp/proj" });
    const parent = registry.createSession({ projectId: g.id, name: "AAA", task: "t", worktreePath: "/tmp/wt", branch: "feature/aaa" });
    registry.updateSession(parent.id, { ompSessionFile: "/tmp/aaa.jsonl", status: "done" });
    const disc = await sup.branchSession(parent.id);

    await expect(sup.createPullRequest(disc.id)).rejects.toThrow(/agent/i);
  });

  it("tells the agent to commit, push and open a PR at the base branch, using the built-in fallback", async () => {
    const { sup, registry } = make();
    const g = registry.upsertProject({ id: "p1", name: "g", localRepoPath: "/tmp/proj" });
    const s = registry.createSession({ projectId: g.id, name: "AAA", task: "t", worktreePath: "/tmp/wt", branch: "feature/aaa", baseBranch: "dev" });
    registry.updateSession(s.id, { ompSessionFile: "/tmp/aaa.jsonl", status: "done" });

    await sup.createPullRequest(s.id);

    const p = prompts.at(-1)!;
    expect(p).toContain("feature/aaa"); // the head branch to push
    expect(p).toContain("dev"); // base-branch hint from session.baseBranch
    expect(p).toMatch(/gh pr create/); // opens the PR via gh
    expect(p).toMatch(/push/i); // pushes the branch first
    expect(p).toMatch(/Conventional Commits/); // Kermanych's built-in fallback conventions
    expect(p).toContain("GIT_TOKEN"); // reads the project's configured token from .env first
    expect(p).toMatch(/prefer it over any/i); // GIT_TOKEN preferred over ambient creds
    expect(p).toMatch(/fall back/i); // ambient gh/git credentials only as the fallback
    expect(p).toMatch(/Co-Authored-By: Kermanych </); // credits Kermanych as a commit co-author
  });

  it("prefers the project's own convention fallback over the built-in default", async () => {
    const { sup, registry } = make();
    const g = registry.upsertProject({ id: "p1", name: "g", localRepoPath: "/tmp/proj", conventions: "HOUSE RULE: squash-merge only" });
    const s = registry.createSession({ projectId: g.id, name: "AAA", task: "t", worktreePath: "/tmp/wt", branch: "feature/aaa", baseBranch: "dev" });
    registry.updateSession(s.id, { status: "done" });

    await sup.createPullRequest(s.id);

    const p = prompts.at(-1)!;
    expect(p).toContain("HOUSE RULE: squash-merge only");
    expect(p).not.toContain("Conventional Commits");
  });

  // The whole point of an editable instruction: what reaches the child is the PROJECT's text,
  // holes filled from the same session state, with its assigned skills still trailing it.
  it("renders the project's own instruction when one exists, skills block and all", async () => {
    const skills = {
      ...stubSkills(),
      assignedFor: async () => ({ block: "\n\nSKILL BLOCK", view: [], missing: [] }),
      instructionFor: async () => "Відкрий ПР для {{branch}}. {{conventions}} {{baseLine}}",
    } as unknown as SkillsService;
    const { sup, registry } = make(skills);
    const g = registry.upsertProject({ id: "p1", name: "g", localRepoPath: "/tmp/proj" });
    const s = registry.createSession({ projectId: g.id, name: "AAA", task: "t", worktreePath: "/tmp/wt", branch: "feature/aaa", baseBranch: "dev" });
    registry.updateSession(s.id, { status: "done" });

    await sup.createPullRequest(s.id);

    const p = prompts.at(-1)!;
    expect(p.startsWith("Відкрий ПР для feature/aaa.")).toBe(true);
    expect(p).toContain("Target the PR at `dev`");
    expect(p).not.toMatch(/gh pr create/); // the default text is gone, not appended to
    expect(p.endsWith("SKILL BLOCK")).toBe(true);
  });

  it("settles the session on in_review only once the PR turn reports a PR URL", async () => {
    const { sup, registry } = make();
    const g = registry.upsertProject({ id: "p1", name: "g", localRepoPath: "/tmp/proj" });
    const s = registry.createSession({ projectId: g.id, name: "AAA", task: "t", worktreePath: "/tmp/wt", branch: "feature/aaa", baseBranch: "dev" });
    registry.updateSession(s.id, { ompSessionFile: "/tmp/aaa.jsonl", status: "done" });

    await sup.createPullRequest(s.id);
    // Mid-push the card must still read as active work, not as a review request.
    expect(sup.snapshot().sessions.find((x) => x.id === s.id)!.status).not.toBe("in_review");

    // A turn that ends WITHOUT a PR URL is not the PR landing — the agent stopped to ask for
    // a token. The card rests on done, but the request stays armed for the next turn.
    for (const cb of eventCbs) cb({ type: "agent_end", isTerminal: true });
    expect(registry.listSessions().find((x) => x.id === s.id)!.status).toBe("done");

    // The operator answers, the agent opens the PR and reports its URL: now the card moves.
    emitPrUrl();
    for (const cb of eventCbs) cb({ type: "agent_end", isTerminal: true });

    expect(registry.listSessions().find((x) => x.id === s.id)!.status).toBe("in_review");
    // …and the live entry agrees, or merge() would keep shadowing the row.
    expect(sup.snapshot().sessions.find((x) => x.id === s.id)!.status).toBe("in_review");
  });

  it("leaves an ordinary turn on done, and consumes the request once the PR is open", async () => {
    const { sup, registry } = make();
    const g = registry.upsertProject({ id: "p1", name: "g", localRepoPath: "/tmp/proj" });
    const s = registry.createSession({ projectId: g.id, name: "AAA", task: "t", worktreePath: "/tmp/wt", branch: "feature/aaa", baseBranch: "dev" });
    registry.updateSession(s.id, { ompSessionFile: "/tmp/aaa.jsonl", status: "done" });

    // An un-requested session that happens to print a PR URL must not drift onto review.
    await sup.sendMessage(s.id, "ще одну правку", "prompt");
    emitPrUrl();
    for (const cb of eventCbs) cb({ type: "agent_end", isTerminal: true });
    expect(registry.listSessions().find((x) => x.id === s.id)!.status).toBe("done");

    await sup.createPullRequest(s.id);
    emitPrUrl();
    for (const cb of eventCbs) cb({ type: "agent_end", isTerminal: true });
    expect(registry.listSessions().find((x) => x.id === s.id)!.status).toBe("in_review");

    // The request is consumed by the turn that opened the PR: a later edit falls back to done.
    await sup.sendMessage(s.id, "і ще одну", "prompt");
    for (const cb of eventCbs) cb({ type: "agent_end", isTerminal: true });
    expect(registry.listSessions().find((x) => x.id === s.id)!.status).toBe("done");
  });

  it("keeps a resumed in_review session on review instead of demoting it to done", async () => {
    const { sup, registry } = make();
    const g = registry.upsertProject({ id: "p1", name: "g", localRepoPath: "/tmp/proj" });
    const s = registry.createSession({ projectId: g.id, name: "AAA", task: "t", worktreePath: "/tmp/wt", branch: "feature/aaa", baseBranch: "dev" });
    registry.updateSession(s.id, { ompSessionFile: "/tmp/aaa.jsonl", status: "in_review" });

    await sup.resume(s.id);

    expect(registry.listSessions().find((x) => x.id === s.id)!.status).toBe("in_review");
  });
});
