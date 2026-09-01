import { describe, it, expect, vi, beforeEach } from "vitest";
import type { WorktreeService } from "../src/worktree/worktree.service";
import type { RpcEvent, ServerEvent, ThinkingLevel } from "@kermanych/core";

// The supervisor's own event callback, so a test can play omp frames at it.
let emit: (e: RpcEvent) => void = () => {};
// Every set_model the supervisor sent, in order: omp addresses a model by provider + id, so
// this records the exact pair the live child was told to switch to.
let modelsSet: Array<{ provider: string; modelId: string }> = [];
// Every set_thinking_level, for the combined model+effort switch.
let levelsSet: ThinkingLevel[] = [];
// Whether the child rejects the model (omp refuses a provider it holds no credentials for).
let refuseModel = false;

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
      return { sessionId: "omp-1", sessionFile: "/tmp/s.jsonl" };
    }
    async getAllMessages() {
      return [];
    }
    async switchSession() {}
    async setModel(provider: string, modelId: string) {
      if (refuseModel) throw new Error("model not supported by provider");
      modelsSet.push({ provider, modelId });
    }
    async setThinkingLevel(level: ThinkingLevel) {
      levelsSet.push(level);
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
import { offlineAuth } from "./offline-auth";
import { stubSkills } from "./skills-stub";
import { stubModels } from "./models-stub";

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
  const sup = new SupervisorService(
    registry,
    worktree as unknown as WorktreeService,
    offlineAuth(),
    stubSkills(),
    stubModels(),
  );
  const seen: ServerEvent[] = [];
  sup.events$.subscribe((e) => seen.push(e));
  return { sup, registry, seen };
}

// A live child without a cloud round-trip, mirroring the effort spec: resuming a retired row
// spawns the very child the composer's model chip talks to. The row starts on "opus-5" (not in
// the stub catalogue) and effort-free, so the resume adds nothing to modelsSet/levelsSet before
// setSessionModel runs — the model settles from the session file, not a set_model on resume.
async function liveSession(sup: SupervisorService, registry: RegistryService, projectId: string) {
  const s = registry.createSession({ projectId, name: "AAA", task: "t", worktreePath: "/tmp/wt", branch: "feature/aaa", model: "opus-5" });
  registry.updateSession(s.id, { ompSessionFile: "/tmp/s.jsonl", status: "done" });
  await sup.sendMessage(s.id, "go", "follow_up");
  return s;
}

beforeEach(() => {
  emit = () => {};
  modelsSet = [];
  levelsSet = [];
  refuseModel = false;
});

describe("session model", () => {
  // The picker sends a bare model id; the provider set_model needs is resolved from the machine's
  // omp catalogue. The live child is told first, then the row is written, then it broadcasts.
  it("resolves the provider from the catalogue, tells the live child, then records and broadcasts", async () => {
    const { sup, registry, seen } = make();
    const g = registry.upsertProject({ id: "p1", name: "g", localRepoPath: "/tmp/proj" });
    const s = await liveSession(sup, registry, g.id);

    const out = await sup.setSessionModel(s.id, { model: "claude-fable-5" });

    expect(modelsSet).toEqual([{ provider: "anthropic", modelId: "claude-fable-5" }]);
    expect(out.model).toBe("claude-fable-5");
    expect(registry.listSessions().find((x) => x.id === s.id)?.model).toBe("claude-fable-5");
    expect(seen.filter((e) => e.type === "session_update" && e.session.id === s.id && e.session.model === "claude-fable-5")).not.toHaveLength(0);
  });

  // When the picker already knows the provider it passes it through, so a model the local
  // catalogue does not list (a different machine minted the card) still switches cleanly.
  it("uses the provider supplied by the picker without a catalogue lookup", async () => {
    const { sup, registry } = make();
    const g = registry.upsertProject({ id: "p1", name: "g", localRepoPath: "/tmp/proj" });
    const s = await liveSession(sup, registry, g.id);

    const out = await sup.setSessionModel(s.id, { model: "gpt-9", provider: "openai" });

    expect(modelsSet).toEqual([{ provider: "openai", modelId: "gpt-9" }]);
    expect(out.model).toBe("gpt-9");
  });

  // A model with no provider the catalogue can resolve cannot be addressed on the child, so the
  // switch fails loudly rather than writing a row that names a model the agent is not running.
  it("rejects a model whose provider cannot be resolved and leaves the row untouched", async () => {
    const { sup, registry } = make();
    const g = registry.upsertProject({ id: "p1", name: "g", localRepoPath: "/tmp/proj" });
    const s = await liveSession(sup, registry, g.id);

    await expect(sup.setSessionModel(s.id, { model: "ghost-9" })).rejects.toThrow(/не знайдено/);
    expect(modelsSet).toEqual([]);
    expect(registry.listSessions().find((x) => x.id === s.id)?.model).toBe("opus-5");
  });

  // omp refuses a model whose provider it holds no credentials for. Writing the row anyway would
  // leave the composer naming a model the agent is not on — the failure that looks like success.
  it("leaves the row untouched when the child refuses the model", async () => {
    const { sup, registry } = make();
    const g = registry.upsertProject({ id: "p1", name: "g", localRepoPath: "/tmp/proj" });
    const s = await liveSession(sup, registry, g.id);
    refuseModel = true;

    await expect(sup.setSessionModel(s.id, { model: "claude-fable-5" })).rejects.toThrow(/not supported by provider/);
    expect(registry.listSessions().find((x) => x.id === s.id)?.model).toBe("opus-5");
  });

  // A backlog task has no child to tell: the model is launch config, consumed as `--model` when
  // it is started. Waking an omp process to record a preference would be absurd.
  it("records the model on a backlog task without spawning anything", async () => {
    const { sup, registry } = make();
    const g = registry.upsertProject({ id: "p1", name: "g", localRepoPath: "/tmp/proj" });
    const task = registry.createSession({ projectId: g.id, name: "AAA", task: "t", worktreePath: "", branch: "", model: "opus-5" });
    registry.updateSession(task.id, { status: "backlog" });

    const out = await sup.setSessionModel(task.id, { model: "claude-fable-5" });

    expect(modelsSet).toEqual([]);
    expect(out.model).toBe("claude-fable-5");
    expect(registry.listSessions().find((x) => x.id === task.id)?.status).toBe("backlog");
  });

  // The composer can switch model and effort in one go; both reach the live child and both are
  // persisted, so a single picker action does not leave half the change on the floor.
  it("applies model and effort together on a live child", async () => {
    const { sup, registry } = make();
    const g = registry.upsertProject({ id: "p1", name: "g", localRepoPath: "/tmp/proj" });
    const s = await liveSession(sup, registry, g.id);

    const out = await sup.setSessionModel(s.id, { model: "claude-fable-5", effort: "high" });

    expect(modelsSet).toEqual([{ provider: "anthropic", modelId: "claude-fable-5" }]);
    expect(levelsSet).toEqual(["high"]);
    expect(out.model).toBe("claude-fable-5");
    expect(out.effort).toBe("high");
  });
});
