import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { WorktreeService } from "../src/worktree/worktree.service";
import type { RpcEvent } from "@kermanych/core";

// The stall heartbeat (`lastEventAt`) must reflect GENUINE agent progress, never the
// supervisor's own 2s get_state poll. If a poll reply refreshed it, a wedged turn (the omp
// child answers get_state but the agent run died with no terminal agent_end) would look alive
// forever and the UI stall banner + restart would never appear. These tests pin that contract.
type FakeChild = { emit?: (e: RpcEvent) => void };
const instances: FakeChild[] = [];
// Controls what the faked omp reports for get_state().isStreaming: true = a turn is genuinely
// mid-flight (thinking / streaming / a long tool call), false = no active turn.
let streaming: boolean | undefined;

vi.mock("../src/rpc/rpc-session", () => {
  class FakeRpc {
    emit?: (e: RpcEvent) => void;
    constructor(_opts: unknown) { instances.push(this as unknown as FakeChild); }
    onEvent(cb: (e: RpcEvent) => void) { this.emit = cb; }
    onExit() {}
    async start() {}
    async getState() { return { isStreaming: streaming, sessionId: "omp-1", sessionFile: "/tmp/s.jsonl" }; }
    async getAllMessages() { return []; }
    async switchSession() {}
    async stop() {}
    isAlive() { return true; }
    prompt() {}
    followUp() {}
    steer() {}
  }
  return { RpcSession: FakeRpc };
});

import { SupervisorService } from "../src/supervisor/supervisor.service";
import { RegistryService } from "../src/registry/registry.service";
import { offlineAuth } from "./offline-auth";

function make() {
  const registry = new RegistryService(":memory:");
  const worktree = {
    isGitRepo: vi.fn().mockResolvedValue(true),
    currentBranch: vi.fn().mockResolvedValue("main"),
  } as unknown as WorktreeService;
  const sup = new SupervisorService(registry, worktree, offlineAuth());
  return { sup, registry };
}

// Bring a session's omp child live (via the resume-on-send path) so its onEvent callback is
// wired and we can drive omp events by hand.
async function liveSession(sup: SupervisorService, registry: RegistryService): Promise<string> {
  const g = registry.upsertProject({ id: "p1", name: "g", localRepoPath: "/tmp/proj" });
  const s = registry.createSession({ projectId: g.id, name: "AAA", task: "t", worktreePath: "/tmp/wt", branch: "feature/aaa" });
  registry.updateSession(s.id, { ompSessionFile: "/tmp/s.jsonl", status: "done" });
  await sup.sendMessage(s.id, "go", "follow_up");
  return s.id;
}

const heartbeat = (sup: SupervisorService, id: string): number | undefined =>
  sup.snapshot().sessions.find((s) => s.id === id)?.lastEventAt;

beforeEach(() => {
  instances.length = 0;
  streaming = undefined;
});
afterEach(() => {
  vi.useRealTimers();
});

describe("stall heartbeat", () => {
  it("ignores get_state response frames but records genuine agent events", async () => {
    const { sup, registry } = make();
    const id = await liveSession(sup, registry);
    const emit = instances[0].emit!;

    vi.useFakeTimers();
    vi.setSystemTime(new Date(1_000_000));
    emit({ type: "turn_start" }); // status -> thinking; heartbeat stamped now
    const t0 = Date.now();
    expect(heartbeat(sup, id)).toBe(t0);

    // 30s elapse while only the supervisor's own poll answers (no agent events).
    vi.setSystemTime(new Date(t0 + 30_000));
    emit({ type: "response", command: "get_state", success: true });
    expect(heartbeat(sup, id)).toBe(t0); // the poll reply must NOT count as progress

    // A real agent event still advances the heartbeat.
    emit({ type: "message_start" });
    expect(heartbeat(sup, id)).toBe(t0 + 30_000);
  });

  it("refreshes the heartbeat only while omp reports a live turn (isStreaming)", async () => {
    const { sup, registry } = make();
    const id = await liveSession(sup, registry);
    const emit = instances[0].emit!;

    vi.useFakeTimers();
    vi.setSystemTime(new Date(2_000_000));
    emit({ type: "turn_start" }); // status thinking -> 2s get_state poll begins
    const start = Date.now();
    expect(heartbeat(sup, id)).toBe(start);

    // A long, event-quiet turn (e.g. a minutes-long subagent) still reports isStreaming=true,
    // so the poll keeps the heartbeat fresh — no false stall.
    streaming = true;
    await vi.advanceTimersByTimeAsync(2_000);
    const live = heartbeat(sup, id);
    expect(live).toBe(Date.now());
    expect(live).toBe(start + 2_000);

    // The turn dies without a terminal agent_end (stalled provider stream): isStreaming flips
    // false. Further polls must NOT refresh the heartbeat, so it ages past the stall threshold.
    streaming = false;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(heartbeat(sup, id)).toBe(live); // frozen at the last genuinely-live poll
    expect(Date.now() - (heartbeat(sup, id) ?? 0)).toBeGreaterThanOrEqual(60_000);
  });
});
