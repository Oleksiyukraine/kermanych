import { describe, it, expect, vi, beforeEach } from "vitest";
import type { WorktreeService } from "../src/worktree/worktree.service";
import type { RpcEvent } from "@kermanych/core";

// Every spawned child, its stop flag, its liveness, and the supervisor's event callback so a
// test can drive it to a running status. Mirrors the FakeRpc idiom of supervisor.restart /
// supervisor.effort — stop() also flips `alive`, which is what a real stopped child reports.
type FakeChild = { stopped: boolean; alive: boolean; emit: (e: RpcEvent) => void };
const instances: FakeChild[] = [];

vi.mock("../src/rpc/rpc-session", () => {
  class FakeRpc {
    stopped = false;
    alive = true;
    emit: (e: RpcEvent) => void = () => {};
    constructor(_opts: unknown) {
      instances.push(this as unknown as FakeChild);
    }
    onEvent(cb: (e: RpcEvent) => void) {
      this.emit = cb;
    }
    onExit() {}
    async start() {}
    async getState() {
      return { sessionId: "omp-1", sessionFile: "/tmp/s.jsonl" };
    }
    async getAllMessages() {
      return [];
    }
    async switchSession() {}
    async stop() {
      this.stopped = true;
      this.alive = false;
    }
    isAlive() {
      return this.alive;
    }
    prompt() {}
    followUp() {}
    steer() {}
  }
  return { RpcSession: FakeRpc };
});

import { SupervisorService } from "../src/supervisor/supervisor.service";
import { RegistryService } from "../src/registry/registry.service";
import { offlineAuth } from "./offline-auth";
import { stubSkills } from "./skills-stub";

const TTL_MS = 15 * 60_000;

function make() {
  const registry = new RegistryService(":memory:");
  const worktree = {
    isGitRepo: vi.fn().mockResolvedValue(true),
    currentBranch: vi.fn().mockResolvedValue("main"),
  } as unknown as WorktreeService;
  const sup = new SupervisorService(registry, worktree, offlineAuth(), stubSkills());
  return { sup, registry };
}

// A live child on a dormant "done" row — the resume-on-first-send path the restart/effort
// specs use, so no cloud round trip is needed. The FakeRpc emits nothing, so the session sits
// idle at "done" after the send, which is exactly the state the reaper is meant to collect.
async function liveDoneSession(sup: SupervisorService, registry: RegistryService): Promise<string> {
  const g = registry.upsertProject({ id: "p1", name: "g", localRepoPath: "/tmp/proj" });
  const s = registry.createSession({ projectId: g.id, name: "AAA", task: "t", worktreePath: "/tmp/wt", branch: "feature/aaa" });
  registry.updateSession(s.id, { ompSessionFile: "/tmp/s.jsonl", status: "done" });
  await sup.sendMessage(s.id, "go", "follow_up");
  return s.id;
}

// reapIdleChildren is private and takes an injectable clock, so the test drives it directly
// with a `now` past/under the TTL rather than waiting on the real 60s interval.
type Reapable = { reapIdleChildren(now?: number): void };
function reap(sup: SupervisorService, now: number): void {
  // Privacy is compile-only and the reaper is a background janitor with no public trigger, so
  // this DI/test seam casts once, to a named local, rather than inline member access.
  const reapable = sup as unknown as Reapable;
  reapable.reapIdleChildren(now);
}

beforeEach(() => {
  instances.length = 0;
});

describe("reapIdleChildren", () => {
  it("stops the resident child of an idle finished session, keeps its transcript, and respawns on the next send", async () => {
    const { sup, registry } = make();
    const id = await liveDoneSession(sup, registry);
    expect(instances).toHaveLength(1);

    const before = sup.getTranscript(id);
    // Real history, not the "session inactive" dormant notice.
    expect(before.some((e) => e.id === "dormant")).toBe(false);
    expect(before.some((e) => e.kind === "user_text")).toBe(true);

    reap(sup, Date.now() + TTL_MS + 1_000);

    expect(instances[0].stopped).toBe(true);
    // The Live stayed: getTranscript still serves the rendered history with no rehydrate.
    expect(sup.getTranscript(id)).toEqual(before);

    // A follow-up transparently respawns a fresh child (liveOrResume drops the dead one).
    await sup.sendMessage(id, "again", "follow_up");
    expect(instances).toHaveLength(2);
    expect(instances[1].stopped).toBe(false);
  });

  it("never stops a session that is actively working", async () => {
    const { sup, registry } = make();
    await liveDoneSession(sup, registry);
    // Drive it into a running tool status via the supervisor's own event path.
    instances[0].emit({ type: "tool_execution_start", toolName: "bash" } as unknown as RpcEvent);

    reap(sup, Date.now() + TTL_MS + 1_000);

    expect(instances[0].stopped).toBe(false);
  });

  it("never stops a child touched within the TTL", async () => {
    const { sup, registry } = make();
    await liveDoneSession(sup, registry);

    // Cutoff (now - TTL) sits 15 min in the past; the child was created just now.
    reap(sup, Date.now());

    expect(instances[0].stopped).toBe(false);
  });

  it("is idempotent — an already-reaped (dead) child is skipped, not stopped twice", async () => {
    const { sup, registry } = make();
    await liveDoneSession(sup, registry);
    reap(sup, Date.now() + TTL_MS + 1_000);
    expect(instances[0].stopped).toBe(true);

    instances[0].stopped = false; // observe whether a second pass touches the dead child
    reap(sup, Date.now() + TTL_MS + 1_000);

    expect(instances[0].stopped).toBe(false);
  });
});
