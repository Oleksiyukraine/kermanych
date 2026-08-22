import { describe, it, expect, vi, beforeEach } from "vitest";
import type { WorktreeService } from "../src/worktree/worktree.service";
import type { RpcEvent, ServerEvent, TranscriptEntry } from "@kermanych/core";

// Capture the supervisor's own event callback so a test can play omp frames at it and then
// read back the transcript it built — this is the wiring the reducer exists to feed.
let emit: (e: RpcEvent) => void = () => {};
vi.mock("../src/rpc/rpc-session", () => {
  class FakeRpc {
    onEvent(cb: (e: RpcEvent) => void) {
      emit = cb;
    }
    onExit() {}
    async start() {}
    isAlive() {
      return true;
    }
    async getState() {
      return {};
    }
    async getAllMessages() {
      return [];
    }
    async stop() {}
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
    addWorktree: vi.fn().mockResolvedValue(undefined),
    removeWorktree: vi.fn().mockResolvedValue(undefined),
    removeBranch: vi.fn().mockResolvedValue(undefined),
    createBranchHere: vi.fn().mockResolvedValue(undefined),
    checkout: vi.fn().mockResolvedValue(undefined),
    currentBranch: vi.fn().mockResolvedValue("main"),
    hasUncommitted: vi.fn().mockResolvedValue(false),
  };
  const sup = new SupervisorService(registry, worktree as unknown as WorktreeService);
  const seen: ServerEvent[] = [];
  sup.events$.subscribe((e) => seen.push(e));
  return { sup, registry, seen };
}

beforeEach(() => {
  emit = () => {};
});

describe("live transcript", () => {
  it("turns a streamed tool call into one completed row with stat, count and clamped detail", async () => {
    const { sup, registry, seen } = make();
    const g = registry.createGroup({ name: "g", projectDir: "/tmp/proj" });
    const chat = await sup.createChat(g.id);

    emit({ type: "tool_execution_start", toolName: "read", toolCallId: "c1", args: { path: "src/lib/tip.ts" }, intent: "Reading the tip helper" });
    emit({
      type: "tool_execution_end", toolName: "read", toolCallId: "c1", isError: false,
      result: { content: [], details: { totalLines: 2, displayContent: { text: "one\ntwo", lineNumbers: [1, 2] } } },
    });

    const tools = sup.getTranscript(chat.id).filter((e): e is Extract<TranscriptEntry, { kind: "tool" }> => e.kind === "tool");
    expect(tools).toHaveLength(1);
    expect(tools[0]).toMatchObject({
      id: "c1", tool: "read", status: "ok", intent: "Reading the tip helper", target: "lib/tip.ts", stat: "2 ln", count: 2,
    });
    expect(tools[0]!.detail).toEqual({ lines: [{ t: "ctx", n: "1", text: "one" }, { t: "ctx", n: "2", text: "two" }], totalLines: 2 });

    // The socket sees the pending row once, then a patch that carries the reduced fields.
    const appended = seen.filter((e) => e.type === "transcript_append" && e.entry.kind === "tool");
    expect(appended).toHaveLength(1);
    expect(seen.find((e) => e.type === "transcript_update")).toMatchObject({ id: "c1", status: "ok", stat: "2 ln", count: 2 });
  });

  it("records assistant text and the per-turn usage omp reports at message_end", async () => {
    const { sup, registry } = make();
    const g = registry.createGroup({ name: "g", projectDir: "/tmp/proj" });
    const chat = await sup.createChat(g.id);

    emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "all " } });
    emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "done" } });
    emit({
      type: "message_end",
      message: { role: "assistant", model: "claude-opus-4-8", duration: 900, usage: { input: 5, output: 7, cost: { total: 0.5 } } },
    });

    expect(sup.getTranscript(chat.id)).toMatchObject([
      { kind: "assistant_text", text: "all done" },
      { kind: "turn", model: "claude-opus-4-8", ms: 900, usage: { input: 5, output: 7, cacheRead: 0, cacheWrite: 0, cost: 0.5 } },
    ]);
  });

  it("shows an omp notice — including the synthetic one for a lost frame — as a transcript row", async () => {
    const { sup, registry } = make();
    const g = registry.createGroup({ name: "g", projectDir: "/tmp/proj" });
    const chat = await sup.createChat(g.id);

    emit({ type: "notice", message: "втрачено кадр від omp" });

    expect(sup.getTranscript(chat.id)).toMatchObject([{ kind: "notice", level: "info", text: "втрачено кадр від omp" }]);
  });
});
