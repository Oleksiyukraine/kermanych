// apps/api/test/supervisor.synergy.spec.ts
// «Синергія» (docs/specs/2026-11-06-synergy.md): a card-less prototyping agent that spawns idle
// with a narrow toolset, takes no agent slot, checkpoints every turn into git, restores a step
// as a new commit and hands over to an ordinary agent. The omp child is a FakeRpc the test
// drives; git is a real temporary repository behind the real WorktreeService.
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { setTimeout as sleep } from "node:timers/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { docsPolicy, docsPolicyAppend, synergyMessage, type RpcEvent, type ServerEvent } from "@kermanych/core";
import type { MachineResourcesService } from "../src/machine/machine-resources.service";
import type { ModelsService } from "../src/models/models.service";

type FakeChild = { opts: Record<string, unknown>; prompts: string[]; alive: boolean; stopped: boolean; emit: (e: RpcEvent) => void };
const instances: FakeChild[] = [];

vi.mock("../src/rpc/rpc-session", () => {
  class FakeRpc {
    prompts: string[] = [];
    alive = true;
    stopped = false;
    emit: (e: RpcEvent) => void = () => {};
    exit: (code: number | null, reason: string) => void = () => {};
    constructor(public opts: Record<string, unknown>) {
      instances.push(this as unknown as FakeChild);
    }
    onEvent(cb: (e: RpcEvent) => void) {
      this.emit = cb;
    }
    onExit(cb: (code: number | null, reason: string) => void) {
      this.exit = cb;
    }
    async start() {}
    async getState() {
      return { isStreaming: false };
    }
    async getAllMessages() {
      return [];
    }
    async switchSession() {}
    async setThinkingLevel() {}
    async stop() {
      this.alive = false;
      this.stopped = true;
      this.exit(0, "stopped");
    }
    isAlive() {
      return this.alive;
    }
    prompt(text: string) {
      this.prompts.push(text);
    }
    followUp(text: string) {
      this.prompts.push(text);
    }
    steer(text: string) {
      this.prompts.push(text);
    }
  }
  return { RpcSession: FakeRpc };
});

import { SupervisorService, synergyPagePath } from "../src/supervisor/supervisor.service";
import { RegistryService } from "../src/registry/registry.service";
import { WorktreeService } from "../src/worktree/worktree.service";
import { offlineAuth } from "./offline-auth";
import { stubSkills } from "./skills-stub";

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

let repo: string;
let agents: number | null = null;
const resources = {
  active: () => (agents === null ? null : { agents, subagents: 2, background: false, testWorkers: 1, lowerPriority: false, watchdog: false, criticalAction: "kill" }),
  ompOverlay: async () => undefined,
  claudeEnv: () => undefined,
  promptParagraph: () => undefined,
  renice: () => {},
  onChange: () => {},
} as unknown as MachineResourcesService;

function models(ids: string[]): ModelsService {
  return {
    list: async () => ids.map((id) => ({ id, name: id, provider: "anthropic", efforts: ["low", "medium", "high"] })),
    provider: async () => "anthropic",
    validModel: async (wanted: string | undefined) => (wanted && ids.includes(wanted) ? wanted : undefined),
  } as unknown as ModelsService;
}

function make(opts: { catalog?: string[]; platform?: "web" | "backend" } = {}) {
  const registry = new RegistryService(":memory:");
  const skills = stubSkills();
  const materialize = vi.spyOn(skills, "materialize");
  const triggers = vi.spyOn(skills, "materializeTriggers");
  const sup = new SupervisorService(registry, new WorktreeService(), offlineAuth(), skills, models(opts.catalog ?? ["claude-sonnet-5-5", "claude-opus-4-8"]), undefined, undefined, resources);
  registry.upsertProject({ id: "p1", name: "g", localRepoPath: repo, docsRequired: true, defaultModel: "claude-opus-4-8", defaultEffort: "high", ...(opts.platform ? { platform: opts.platform } : {}) });
  const events: ServerEvent[] = [];
  sup.events$.subscribe((e) => events.push(e));
  const row = (id: string) => registry.listSessions().find((s) => s.id === id)!;
  return { sup, registry, materialize, triggers, events, row };
}

// One whole turn of the running child, ending at rest.
function settle(child: FakeChild) {
  child.emit({ type: "agent_start" } as RpcEvent);
  child.emit({ type: "agent_end" } as RpcEvent);
}

const subjects = (dir: string) => git(dir, "log", "--format=%s").split("\n");

beforeEach(() => {
  instances.length = 0;
  agents = null;
  repo = mkdtempSync(join(tmpdir(), "kmq-synergy-"));
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.email", "t@example.com");
  git(repo, "config", "user.name", "T");
  writeFileSync(join(repo, "app.txt"), "v0\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "init");
});
afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe("createSynergy", () => {
  it("launches an idle synergy agent on its own branch with the fast, narrow child", async () => {
    const { sup, materialize, triggers, row } = make();
    const s = await sup.createSynergy({ projectId: "p1", topic: "Кошик" });

    expect(s.branch).toBe("synergy/koshyk");
    expect(s.prefix).toBe("synergy");
    expect(s.synergy).toEqual({});
    expect(s.taskId).toBeUndefined();
    expect(s.status).toBe("done");
    expect(existsSync(row(s.id).worktreePath)).toBe(true);
    expect(git(row(s.id).worktreePath, "rev-parse", "--abbrev-ref", "HEAD")).toBe("synergy/koshyk");

    expect(instances).toHaveLength(1);
    const child = instances[0]!;
    expect(child.prompts).toEqual([]);
    expect(child.opts).toMatchObject({ model: "claude-sonnet-5-5", thinking: "low", tools: ["read", "edit", "write", "grep", "glob"], noLsp: true });
    expect(child.opts.configPaths ?? []).toEqual([]);
    expect(child.opts.extensionPath).toBeUndefined();
    // The «Синергія» instruction replaces the docs-policy line the project would otherwise get.
    expect(child.opts.appendSystemPrompt).toContain("«Синергія»");
    expect(child.opts.appendSystemPrompt).not.toContain(docsPolicyAppend(docsPolicy(undefined)));
    expect(materialize).not.toHaveBeenCalled();
    expect(triggers).not.toHaveBeenCalled();
  });

  it("a woken child keeps the narrow toolset and the synergy append", async () => {
    const { sup, registry, materialize } = make();
    const s = await sup.createSynergy({ projectId: "p1", topic: "wake" });
    registry.updateSession(s.id, { ompSessionFile: join(repo, "wake.jsonl") });
    // The reaper (or a crash) took the child: the next request respawns it.
    instances[0]!.alive = false;
    await sup.sendMessage(s.id, "далі", "prompt");
    const woken = instances[1]!;
    expect(woken.opts).toMatchObject({ tools: ["read", "edit", "write", "grep", "glob"], noLsp: true });
    expect(woken.opts.appendSystemPrompt).toContain("«Синергія»");
    expect(woken.opts.extensionPath).toBeUndefined();
    expect(materialize).not.toHaveBeenCalled();
    expect(woken.prompts).toEqual(["далі"]);
  });

  it("names a page start after its path and falls back to the project model", async () => {
    const { sup } = make({ catalog: ["claude-opus-4-8"] });
    const s = await sup.createSynergy({ projectId: "p1", page: "http://localhost:5173/users/42?tab=a#x", effort: "medium" });
    expect(s.name).toBe("Синергія: /users/42?tab=a#x");
    expect(s.synergy).toEqual({ page: "/users/42?tab=a#x" });
    expect(s.branch.startsWith("synergy/users-42")).toBe(true);
    expect(instances[0]!.opts).toMatchObject({ model: "claude-opus-4-8", thinking: "medium" });
  });

  it("refuses garbage pages and browserless projects without leaving a row", async () => {
    const { sup, registry } = make();
    await expect(sup.createSynergy({ projectId: "p1", page: "/a b" })).rejects.toThrow(/invalid start page/);
    await expect(sup.createSynergy({ projectId: "p1", page: "javascript:alert(1)" })).rejects.toThrow(/invalid start page/);
    const backend = make({ platform: "backend" });
    await expect(backend.sup.createSynergy({ projectId: "p1" })).rejects.toThrow(/browser/);
    expect(registry.listSessions()).toHaveLength(0);
    expect(backend.registry.listSessions()).toHaveLength(0);
    expect(instances).toHaveLength(0);
  });

  it("normalises a start page", () => {
    expect(synergyPagePath("users/1")).toBe("/users/1");
    expect(synergyPagePath("https://app.test/x?y=1")).toBe("/x?y=1");
    expect(() => synergyPagePath("//evil.test/x")).toThrow();
  });
});

describe("slots", () => {
  it("a synergy session neither counts nor waits while the only slot is taken", async () => {
    agents = 1;
    const { sup, registry } = make();
    const agent = registry.createSession({ projectId: "p1", name: "a", task: "do a", worktreePath: "", branch: "feature/a", worktree: false });
    // An ordinary in-place agent mid-turn: its git is the project checkout, the spawn is the point.
    const launcher = sup as unknown as { launch(s: unknown, p: unknown): Promise<unknown> };
    await launcher.launch(agent, registry.listProjects()[0]);
    expect(sup.slotCounts()).toEqual({ running: 1, waiting: 0 });

    const s = await sup.createSynergy({ projectId: "p1", topic: "x" });
    expect(s.slotWait).toBeUndefined();
    await sup.sendMessage(s.id, "прибери кнопку", "prompt");
    expect(instances[1]!.prompts).toEqual(["прибери кнопку"]);
    expect(sup.slotCounts()).toEqual({ running: 1, waiting: 0 });
  });
});

describe("checkpoints, restore and implement", () => {
  async function prototype() {
    const ctx = make();
    const s = await ctx.sup.createSynergy({ projectId: "p1", topic: "proto" });
    const dir = ctx.row(s.id).worktreePath;
    const child = instances[0]!;
    // One operator request whose turn writes `files`, then settles and is checkpointed.
    const turn = async (request: string, files: Record<string, string>) => {
      const before = subjects(dir).length;
      await ctx.sup.sendMessage(s.id, synergyMessage(request, { page: "/cart", picks: "◎ button.buy" }), "prompt");
      for (const [f, text] of Object.entries(files)) writeFileSync(join(dir, f), text);
      settle(child);
      if (Object.keys(files).length) await vi.waitFor(() => expect(subjects(dir).length).toBe(before + 1));
    };
    return { ...ctx, s, dir, child, turn };
  }

  it("commits each changing turn as one step named after the operator's words", async () => {
    const { sup, s, dir, turn, events } = await prototype();
    await turn("прибери кнопку", { "app.txt": "v1\n" });
    expect(subjects(dir)[0]).toBe("synergy: прибери кнопку");
    expect(git(dir, "log", "-1", "--format=%B")).toContain("Co-Authored-By: Kermanych");
    expect(git(dir, "status", "--porcelain")).toBe("");
    await vi.waitFor(() => expect(events.some((e) => e.type === "synergy_steps" && e.sessionId === s.id)).toBe(true));

    const view = await sup.synergyStepsView(s.id);
    expect(view.base).toBe("main");
    expect(view.startSha).toBe(git(repo, "rev-parse", "main"));
    expect(view.steps).toEqual([expect.objectContaining({ n: 1, kind: "change", request: "прибери кнопку", page: "/cart" })]);

    // A turn that changed nothing makes no checkpoint.
    await turn("нічого", {});
    await sleep(50);
    expect((await sup.synergyStepsView(s.id)).steps).toHaveLength(1);
  });

  it("restores a step as a new commit, deleting what was added after it", async () => {
    const { sup, s, dir, child, turn } = await prototype();
    await turn("крок 1", { "app.txt": "v1\n" });
    await turn("крок 2", { "app.txt": "v2\n", "extra.txt": "new\n" });
    const view = await sup.synergyStepsView(s.id);
    const [one] = view.steps;

    await expect(sup.restoreSynergy(s.id, "deadbeef")).rejects.toThrow(/not a step/);
    child.emit({ type: "agent_start" } as RpcEvent);
    await expect(sup.restoreSynergy(s.id, one!.sha)).rejects.toThrow(/finish its turn/);
    child.emit({ type: "agent_end" } as RpcEvent);

    const after = await sup.restoreSynergy(s.id, one!.sha);
    expect(existsSync(join(dir, "extra.txt"))).toBe(false);
    expect(git(dir, "show", "HEAD:app.txt")).toBe("v1");
    expect(after.steps.map((x) => x.kind)).toEqual(["change", "change", "restore"]);
    expect(after.steps[2]).toMatchObject({ n: 3, restoreOf: one!.sha });

    const start = await sup.restoreSynergy(s.id, after.startSha);
    expect(git(dir, "show", "HEAD:app.txt")).toBe("v0");
    expect(start.steps.at(-1)).toMatchObject({ kind: "restore", restoreOf: after.startSha });
  });

  it("implement refuses with no checkpoint, then hands over to a fresh agent with the brief", async () => {
    const { sup, registry, s, child, turn, row } = await prototype();
    await expect(sup.implementSynergy(s.id, "task-1")).rejects.toThrow(/no checkpoint/);
    await turn("прибери кнопку", { "app.txt": "v1\n" });
    registry.updateSession(s.id, { ompSessionFile: join(repo, "proto.jsonl") });

    child.emit({ type: "agent_start" } as RpcEvent);
    await expect(sup.implementSynergy(s.id, "task-1")).rejects.toThrow(/finish its turn/);
    child.emit({ type: "agent_end" } as RpcEvent);

    const done = await sup.implementSynergy(s.id, "task-1");
    expect(done.synergy).toBeUndefined();
    const r = row(s.id);
    expect(r).toMatchObject({ taskId: "task-1", model: "claude-opus-4-8", effort: "high", branch: "synergy/proto", prefix: "synergy" });
    expect(r.synergy).toBeUndefined();
    expect(r.ompSessionFile).toBeFalsy();
    expect(child.stopped).toBe(true);

    const impl = instances.at(-1)!;
    expect(impl).not.toBe(child);
    expect(impl.opts.tools).toBeUndefined();
    expect(impl.opts.noLsp).toBeUndefined();
    expect(impl.opts.fork).toBeUndefined();
    expect(impl.prompts).toHaveLength(1);
    expect(impl.prompts[0]).toContain("1. прибери кнопку");
    expect(impl.prompts[0]).toContain("synergy/proto");
    expect(impl.prompts[0]).toContain("Co-Authored-By");

    // An ordinary agent now: it counts for a slot again, and synergy actions refuse it.
    await expect(sup.synergyStepsView(s.id)).rejects.toThrow(/not a «Синергія» session/);
  });
});
