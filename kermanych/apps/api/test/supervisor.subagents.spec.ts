import { describe, it, test, expect, vi, beforeEach } from "vitest";
import type { WorktreeService } from "../src/worktree/worktree.service";
import type { RpcEvent, ServerEvent, TranscriptEntry, SubagentInfo, SubagentMessagesPage } from "@kermanych/core";
import { SessionsController } from "../src/http/sessions.controller";

// Same seam as supervisor.live-transcript.spec: capture the supervisor's event callback so a
// test can play omp frames at it. The fake also answers the subagent surface the supervisor
// pulls (get_subagents / get_subagent_messages), driven by these module-level fixtures.
let emit: (e: RpcEvent) => void = () => {};
let registrySnapshot: SubagentInfo[] = [];
let subMessages: SubagentMessagesPage = {};
let getSubagentsCalls = 0;

vi.mock("../src/rpc/rpc-session", () => {
  class FakeRpc {
    onEvent(cb: (e: RpcEvent) => void) { emit = cb; }
    onExit() {}
    async start() {}
    isAlive() { return true; }
    async getState() { return {}; }
    async getAllMessages() { return []; }
    async switchSession() {}
    async stop() {}
    prompt() {}
    followUp() {}
    steer() {}
    async getSubagents() { getSubagentsCalls++; return registrySnapshot; }
    async getSubagentMessages() { return subMessages; }
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
    addWorktree: vi.fn().mockResolvedValue(undefined),
    removeWorktree: vi.fn().mockResolvedValue(undefined),
    removeBranch: vi.fn().mockResolvedValue(undefined),
    createBranchHere: vi.fn().mockResolvedValue(undefined),
    checkout: vi.fn().mockResolvedValue(undefined),
    currentBranch: vi.fn().mockResolvedValue("main"),
    hasUncommitted: vi.fn().mockResolvedValue(false),
  };
  const sup = new SupervisorService(registry, worktree as unknown as WorktreeService, offlineAuth(), stubSkills());
  const seen: ServerEvent[] = [];
  sup.events$.subscribe((e) => seen.push(e));
  return { sup, registry, seen };
}

const updates = (seen: ServerEvent[]): Extract<ServerEvent, { type: "subagents_update" }>[] =>
  seen.filter((e): e is Extract<ServerEvent, { type: "subagents_update" }> => e.type === "subagents_update");

beforeEach(() => {
  emit = () => {};
  registrySnapshot = [];
  subMessages = {};
  getSubagentsCalls = 0;
});

describe("subagent tree", () => {
  it("a lifecycle frame snapshots the registry and fans one subagents_update", async () => {
    const { sup, registry, seen } = make();
    const g = registry.upsertProject({ id: "p1", name: "g", localRepoPath: "/tmp/proj" });
    const chat = await sup.createChat(g.id);

    registrySnapshot = [{ id: "Task", index: 0, status: "running", agent: "general-purpose" }];
    emit({ type: "subagent_lifecycle", subagentId: "Task" });

    // refreshSubagents is fire-and-forget (an async getSubagents round-trip), so the fan-out
    // lands a tick later.
    await vi.waitFor(() => expect(updates(seen)).toHaveLength(1));
    const upd = updates(seen)[0]!;
    expect(upd.sessionId).toBe(chat.id);
    expect(upd.subagents).toEqual([{ id: "Task", index: 0, status: "running", agent: "general-purpose" }]);
  });

  it("derives parentId from a dotted subagent id", async () => {
    const { sup, registry, seen } = make();
    const g = registry.upsertProject({ id: "p1", name: "g", localRepoPath: "/tmp/proj" });
    await sup.createChat(g.id);

    registrySnapshot = [{ id: "Task.Child", index: 1, status: "running" }];
    emit({ type: "subagent_progress", subagentId: "Task.Child" });

    await vi.waitFor(() => expect(updates(seen)).toHaveLength(1));
    expect(updates(seen)[0]!.subagents[0]).toMatchObject({ id: "Task.Child", parentId: "Task" });
  });

  it("a finished task tool enriches the node with tokens, duration, model and label", async () => {
    const { sup, registry, seen } = make();
    const g = registry.upsertProject({ id: "p1", name: "g", localRepoPath: "/tmp/proj" });
    await sup.createChat(g.id);

    emit({
      type: "tool_execution_end", toolName: "task", toolCallId: "t1", isError: false,
      result: { content: [], details: { results: [
        { id: "Task", agent: "general-purpose", resolvedModel: "claude-sonnet-5", description: "Implement Task 4", task: "You are implementing Task 4.", tokens: 187_100, durationMs: 1_295_000, exitCode: 0 },
      ] } },
    } as RpcEvent);

    // Enrichment is synchronous (no registry round-trip): the details ride the end frame.
    const upd = updates(seen).at(-1)!;
    expect(upd.subagents[0]).toMatchObject({
      id: "Task", agent: "general-purpose", model: "claude-sonnet-5",
      description: "Implement Task 4", task: "You are implementing Task 4.",
      tokens: 187_100, durationMs: 1_295_000, status: "done",
    });
  });

  it("maps a non-zero task exitCode to an error status", async () => {
    const { sup, registry, seen } = make();
    const g = registry.upsertProject({ id: "p1", name: "g", localRepoPath: "/tmp/proj" });
    await sup.createChat(g.id);

    emit({
      type: "tool_execution_end", toolName: "task", toolCallId: "t1", isError: true,
      result: { content: [], details: { results: [{ id: "Task", exitCode: 1 }] } },
    } as RpcEvent);

    expect(updates(seen).at(-1)!.subagents[0]).toMatchObject({ id: "Task", status: "error" });
  });

  it("does not re-fan an identical tree when a progress burst moves no field", async () => {
    const { sup, registry, seen } = make();
    const g = registry.upsertProject({ id: "p1", name: "g", localRepoPath: "/tmp/proj" });
    await sup.createChat(g.id);

    registrySnapshot = [{ id: "Task", index: 0, status: "running" }];
    emit({ type: "subagent_progress", subagentId: "Task" });
    await vi.waitFor(() => expect(updates(seen)).toHaveLength(1));

    // A second identical snapshot must not produce a second frame.
    emit({ type: "subagent_progress", subagentId: "Task" });
    emit({ type: "subagent_progress", subagentId: "Task" });
    await vi.waitFor(() => expect(getSubagentsCalls).toBeGreaterThanOrEqual(2));
    expect(updates(seen)).toHaveLength(1);
  });

  it("subagent telemetry bumps the heartbeat but does not write to the registry per frame", async () => {
    const { sup, registry } = make();
    const g = registry.upsertProject({ id: "p1", name: "g", localRepoPath: "/tmp/proj" });
    const chat = await sup.createChat(g.id);

    const touch = vi.spyOn(registry, "touchSession");
    emit({ type: "subagent_progress", subagentId: "Task" });
    emit({ type: "subagent_lifecycle", subagentId: "Task" });
    // A burst of coalesced progress frames must not amplify into a DB write each.
    expect(touch).not.toHaveBeenCalled();

    // A real tool event still records activity.
    emit({ type: "tool_execution_start", toolName: "read", toolCallId: "c1" });
    expect(touch).toHaveBeenCalledWith(chat.id);
  });
});

describe("subagent endpoints", () => {
  it("getSubagents returns the merged tree for a live session and empty for an unknown one", async () => {
    const { sup, registry } = make();
    const g = registry.upsertProject({ id: "p1", name: "g", localRepoPath: "/tmp/proj" });
    const chat = await sup.createChat(g.id);

    registrySnapshot = [{ id: "Task", index: 0, status: "idle" }];
    expect(await sup.getSubagents(chat.id)).toEqual([{ id: "Task", index: 0, status: "idle" }]);
    expect(await sup.getSubagents("nope")).toEqual([]);
  });

  it("getSubagentTranscript renders the subagent's messages and files its tool output under the parent id", async () => {
    const { sup, registry } = make();
    const g = registry.upsertProject({ id: "p1", name: "g", localRepoPath: "/tmp/proj" });
    const chat = await sup.createChat(g.id);

    subMessages = { messages: [
      { role: "assistant", content: [{ type: "text", text: "hi from subagent" }] },
      { role: "assistant", content: [{ type: "toolCall", id: "tc1", name: "bash", arguments: { command: "ls" } }] },
      { role: "toolResult", toolCallId: "tc1", toolName: "bash", isError: false, content: [{ type: "text", text: "file.ts" }], details: { wallTimeMs: 5 } },
    ] };

    const entries = await sup.getSubagentTranscript(chat.id, "Task");
    expect(entries.find((e) => e.kind === "assistant_text")).toMatchObject({ text: "hi from subagent" });
    const toolRow = entries.find((e): e is Extract<TranscriptEntry, { kind: "tool" }> => e.kind === "tool");
    expect(toolRow).toMatchObject({ tool: "bash", status: "ok" });

    // KToolRow's "@more" fetches GET /sessions/:parentId/tools/:callId — the subagent has no
    // socket of its own, so the transcript endpoint must have filed the lines under the parent.
    expect(sup.getToolDetail(chat.id, toolRow!.id).lines.length).toBeGreaterThan(0);
  });
});

describe("controller delegation", () => {
  test("forwards subagents and subagentTranscript to the supervisor", () => {
    const sup = { getSubagents: vi.fn().mockResolvedValue([]), getSubagentTranscript: vi.fn().mockResolvedValue([]) };
    const c = new SessionsController(sup as never, {} as never, {} as never);
    c.subagents("s1");
    expect(sup.getSubagents).toHaveBeenCalledWith("s1");
    c.subagentTranscript("s1", "Task");
    expect(sup.getSubagentTranscript).toHaveBeenCalledWith("s1", "Task");
  });
});
