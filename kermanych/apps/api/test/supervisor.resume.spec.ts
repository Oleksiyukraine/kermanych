import { describe, it, expect, vi, beforeEach } from "vitest";
import type { WorktreeService } from "../src/worktree/worktree.service";
import type { OmpMessage } from "../src/supervisor/messages-to-transcript";

// Every spawned RpcSession is captured so the test can inspect which child a message was
// delivered to and can simulate a child dying (a provider outage killing the omp process).
type FakeChild = { alive: boolean; prompts: number; followUps: number; steers: number };
const instances: FakeChild[] = [];

// Every spawned claude runtime is captured with the launch opts it was constructed with, so
// the resume/branch tests can assert the resume/fork handle and read back the scripted history.
type FakeClaude = { opts: { resume?: string; fork?: string }; prompts: number; followUps: number };
const claudeInstances: FakeClaude[] = [];
// The scripted claude transcript getAllMessages() returns — a prior user prompt and answer.
const claudeHistory: OmpMessage[] = [
  { role: "user", content: [{ type: "text", text: "prior claude prompt" }] },
  { role: "assistant", content: [{ type: "text", text: "prior claude answer" }] },
];

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

vi.mock("../src/runtime/claude-code-runtime", () => {
  class FakeClaudeRuntime {
    readonly droppedFrames = 0;
    alive = true;
    prompts = 0;
    followUps = 0;
    steers = 0;
    constructor(public opts: { resume?: string; fork?: string }) { claudeInstances.push(this); }
    onEvent() {}
    onExit() {}
    async start() {}
    // claude reports only a session UUID (no session file); resume keys off ompSessionId.
    async getState() { return { sessionId: "claude-1" }; }
    async getAllMessages() { return claudeHistory; }
    async switchSession() {} // no-op on claude — resume is expressed at start()
    async setModel() {}
    async setThinkingLevel() {}
    async stop() {}
    answerUi() {}
    isAlive() { return this.alive; }
    prompt() { this.prompts++; }
    followUp() { this.followUps++; }
    steer() { this.steers++; }
  }
  return { ClaudeCodeRuntime: FakeClaudeRuntime };
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

beforeEach(() => { instances.length = 0; claudeInstances.length = 0; });

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

describe("resume claude-code", () => {
  it("resumes a dormant claude session by UUID and rehydrates its transcript", async () => {
    const { sup, registry } = make();
    const g = registry.upsertProject({ id: "p1", name: "g", localRepoPath: "/tmp/proj" });
    const s = registry.createSession({ projectId: g.id, name: "CCC", task: "t", worktreePath: "/tmp/wt", branch: "feature/ccc" });
    // A claude session persists its session UUID in ompSessionId and has NO ompSessionFile.
    registry.updateSession(s.id, { runtime: "claude-code", ompSessionId: "claude-uuid-1", status: "done" });

    expect(await sup.resume(s.id)).toEqual({ ok: true });

    // (a) the claude runtime was constructed with the resume handle = the session UUID, not a file.
    expect(claudeInstances).toHaveLength(1);
    expect(instances).toHaveLength(0); // no omp child spawned
    expect(claudeInstances[0].opts.resume).toBe("claude-uuid-1");
    expect(claudeInstances[0].opts.fork).toBeUndefined();

    // (b) getAllMessages() ran and populated the live transcript (no longer the dormant notice).
    const tx = sup.getTranscript(s.id);
    expect(tx.map((e) => e.kind)).toEqual(["user_text", "assistant_text"]);
    expect(tx.map((e) => ("text" in e ? e.text : undefined))).toEqual(["prior claude prompt", "prior claude answer"]);
  });

  it("branches a claude parent by forking its UUID and rehydrates the child from the parent", async () => {
    const { sup, registry } = make();
    const g = registry.upsertProject({ id: "p1", name: "g", localRepoPath: "/tmp/proj" });
    const parent = registry.createSession({ projectId: g.id, name: "CCC", task: "t", worktreePath: "/tmp/wt", branch: "feature/ccc" });
    registry.updateSession(parent.id, { runtime: "claude-code", ompSessionId: "claude-uuid-1", status: "done" });

    const child = await sup.branchSession(parent.id);

    // The child forks the parent's UUID (a branch is a fork), never a plain resume.
    expect(claudeInstances).toHaveLength(1);
    expect(claudeInstances[0].opts.fork).toBe("claude-uuid-1");
    expect(child.runtime).toBe("claude-code");
    // The child's transcript is rehydrated from the parent's history.
    const tx = sup.getTranscript(child.id);
    expect(tx.map((e) => e.kind)).toEqual(["user_text", "assistant_text"]);
  });
});
