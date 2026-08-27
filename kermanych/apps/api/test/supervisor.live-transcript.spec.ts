import { describe, it, expect, vi, beforeEach } from "vitest";
import type { WorktreeService } from "../src/worktree/worktree.service";
import type { RpcEvent, ServerEvent, TranscriptEntry } from "@kermanych/core";
import type { ToolDetailCache } from "../src/supervisor/tool-detail-cache";

// Capture the supervisor's own event callback so a test can play omp frames at it and then
// read back the transcript it built — this is the wiring the reducer exists to feed.
let emit: (e: RpcEvent) => void = () => {};
// What a resumed child reports as its prior conversation.
let history: unknown[] = [];
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
      return history;
    }
    async switchSession() {}
    async stop() {}
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
    addWorktree: vi.fn().mockResolvedValue(undefined),
    removeWorktree: vi.fn().mockResolvedValue(undefined),
    removeBranch: vi.fn().mockResolvedValue(undefined),
    createBranchHere: vi.fn().mockResolvedValue(undefined),
    checkout: vi.fn().mockResolvedValue(undefined),
    currentBranch: vi.fn().mockResolvedValue("main"),
    hasUncommitted: vi.fn().mockResolvedValue(false),
  };
  const sup = new SupervisorService(registry, worktree as unknown as WorktreeService, offlineAuth());
  const seen: ServerEvent[] = [];
  sup.events$.subscribe((e) => seen.push(e));
  return { sup, registry, seen };
}

beforeEach(() => {
  emit = () => {};
  history = [];
});

describe("live transcript", () => {
  it("turns a streamed tool call into one completed row with stat, count and clamped detail", async () => {
    const { sup, registry, seen } = make();
    const g = registry.upsertProject({ id: "p1", name: "g", localRepoPath: "/tmp/proj" });
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

  it("carries the call's arguments across frames so a bash card shows the command that ran", async () => {
    const { sup, registry } = make();
    const g = registry.upsertProject({ id: "p1", name: "g", localRepoPath: "/tmp/proj" });
    const chat = await sup.createChat(g.id);

    // Two separate callbacks — the args are gone by the time the result lands unless the
    // service keeps them for the session.
    emit({ type: "tool_execution_start", toolName: "bash", toolCallId: "b1", args: { command: "pnpm test" } });
    emit({ type: "tool_execution_end", toolName: "bash", toolCallId: "b1", isError: false, result: { content: [{ type: "text", text: "ok" }], details: { wallTimeMs: 30 } } });

    const row = sup.getTranscript(chat.id).find((e): e is Extract<TranscriptEntry, { kind: "tool" }> => e.kind === "tool");
    expect(row).toMatchObject({ id: "b1", tool: "bash", status: "ok", target: "pnpm test", stat: "30 ms" });
    expect(row!.detail!.lines).toEqual([
      { t: "head", text: "$ pnpm test" },
      { t: "ctx", text: "ok" },
      { t: "head", text: "wall 30 ms" },
    ]);
  });

  it("keeps an unlabelled call's row, cache slot and wall time in sync, and releases its maps", async () => {
    const { sup, registry } = make();
    const g = registry.upsertProject({ id: "p1", name: "g", localRepoPath: "/tmp/proj" });
    const chat = await sup.createChat(g.id);

    // No toolCallId: the end frame's reducer mints an id that differs from the row's, so the
    // cache slot, the wall time and the map cleanup all have to key off the row instead.
    emit({ type: "tool_execution_start", toolName: "read", args: { path: "a/b.ts" } });
    emit({ type: "tool_execution_end", toolName: "read", isError: false, result: { content: [{ type: "text", text: "x\ny" }] } });

    const row = sup.getTranscript(chat.id).find((e): e is Extract<TranscriptEntry, { kind: "tool" }> => e.kind === "tool");
    expect(row).toMatchObject({ tool: "read", status: "ok", target: "a/b.ts" });
    expect(row!.ms).toBeGreaterThan(0);
    const internals = sup as unknown as { toolDetails: ToolDetailCache; map: Map<string, { toolStarted: Map<string, number>; toolArgs: Map<string, unknown> }> };
    expect(internals.toolDetails.get(chat.id, row!.id)).toHaveLength(2);
    const live = internals.map.get(chat.id)!;
    expect(live.toolStarted.size).toBe(0);
    expect(live.toolArgs.size).toBe(0);
  });

  it("completes a labelled skill row through the skill reducer, not the read one", async () => {
    const { sup, registry } = make();
    const g = registry.upsertProject({ id: "p1", name: "g", localRepoPath: "/tmp/proj" });
    const chat = await sup.createChat(g.id);

    // One event per callback is how the service drives the reducer, so the end frame has to
    // rebuild the row from the args retained for `c1` or it reduces the skill read as a file read.
    emit({ type: "tool_execution_start", toolName: "read", toolCallId: "c1", args: { path: "skill://kermanych-session" } });
    emit({
      type: "tool_execution_end", toolName: "read", toolCallId: "c1", isError: false,
      result: { content: [{ type: "text", text: "one\ntwo" }], details: { displayContent: { text: "one\ntwo", lineNumbers: [1, 2] }, totalLines: 40 } },
    });

    const row = sup.getTranscript(chat.id).find((e): e is Extract<TranscriptEntry, { kind: "tool" }> => e.kind === "tool");
    // readDisplay would have numbered the lines and stamped a "2/40 ln" stat.
    expect(row).toMatchObject({ id: "c1", tool: "skill", status: "ok", target: "kermanych-session" });
    expect(row!.stat).toBeUndefined();
    expect(row!.detail).toEqual({ lines: [{ t: "ctx", text: "one" }, { t: "ctx", text: "two" }], totalLines: 2 });
  });

  it("completes an unlabelled skill row instead of leaving it pending forever", async () => {
    const { sup, registry, seen } = make();
    const g = registry.upsertProject({ id: "p1", name: "g", localRepoPath: "/tmp/proj" });
    const chat = await sup.createChat(g.id);

    // No toolCallId: the patch's id cannot match the row's and its tool name still reads
    // `read` off the wire, so only the shared row-matching rule can pair the two.
    emit({ type: "tool_execution_start", toolName: "read", args: { path: "skill://kermanych-session" } });
    emit({ type: "tool_execution_end", toolName: "read", isError: false, result: { content: [{ type: "text", text: "x\ny" }] } });

    const row = sup.getTranscript(chat.id).find((e): e is Extract<TranscriptEntry, { kind: "tool" }> => e.kind === "tool");
    expect(row).toMatchObject({ tool: "skill", status: "ok", target: "kermanych-session" });
    expect(seen.find((e) => e.type === "transcript_update")).toMatchObject({ id: row!.id, status: "ok" });
  });

  it("records assistant text and the per-turn usage omp reports at message_end", async () => {
    const { sup, registry } = make();
    const g = registry.upsertProject({ id: "p1", name: "g", localRepoPath: "/tmp/proj" });
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

  it("normalises omp's notice levels into the transcript's own vocabulary", async () => {
    const { sup, registry } = make();
    const g = registry.upsertProject({ id: "p1", name: "g", localRepoPath: "/tmp/proj" });
    const chat = await sup.createChat(g.id);

    // omp 17.3.8 spells a warning "warning" and never "warn"; the api's own synthetic frame
    // says "warn". Both must land as `warn`, or a real warning renders as muted info text.
    emit({ type: "notice", message: "context is getting full" });
    emit({ type: "notice", level: "warning", message: "автостиснення не вдалося" });
    emit({ type: "notice", level: "warn", message: "втрачено кадр від omp" });
    emit({ type: "notice", level: "error", message: "collab ended" });

    expect(sup.getTranscript(chat.id)).toMatchObject([
      { kind: "notice", level: "info", text: "context is getting full" },
      { kind: "notice", level: "warn", text: "автостиснення не вдалося" },
      { kind: "notice", level: "warn", text: "втрачено кадр від omp" },
      { kind: "notice", level: "error", text: "collab ended" },
    ]);
  });
});

describe("rehydrated transcript", () => {
  it("rebuilds a dormant session's rows and files their full output so they can still be expanded", async () => {
    const { sup, registry } = make();
    const g = registry.upsertProject({ id: "p1", name: "g", localRepoPath: "/tmp/proj" });
    const s = registry.createSession({ projectId: g.id, name: "AAA", task: "t", worktreePath: "/tmp/wt", branch: "feature/aaa" });
    registry.updateSession(s.id, { ompSessionFile: "/tmp/s.jsonl", status: "done" });
    history = [
      { role: "assistant", content: [{ type: "toolCall", name: "bash", arguments: { command: "seq 30" } }] },
      {
        role: "toolResult", toolName: "bash", isError: false, details: { wallTimeMs: 5 },
        content: [{ type: "text", text: Array.from({ length: 30 }, (_, i) => `row ${i}`).join("\n") }],
      },
    ];

    // A send against a dormant session resumes it, which is the rehydration path.
    await sup.sendMessage(s.id, "again", "follow_up");

    const row = sup.getTranscript(s.id).find((e): e is Extract<TranscriptEntry, { kind: "tool" }> => e.kind === "tool");
    expect(row).toMatchObject({ tool: "bash", status: "ok", target: "seq 30" });
    expect(row!.detail!.lines).toHaveLength(10);
    expect(row!.detail!.totalLines).toBe(32);

    // Task 8 serves this through GET /sessions/:id/tools/:callId; until that endpoint exists,
    // assert the slot it will read, keyed by the row's own id.
    const cache = (sup as unknown as { toolDetails: ToolDetailCache }).toolDetails;
    expect(cache.get(s.id, row!.id)).toHaveLength(32);
  });
});
