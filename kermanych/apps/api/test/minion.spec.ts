// apps/api/test/minion.spec.ts
// «Посіпака» (docs/specs/2026-10-23-minion-auto-run.md): which card the poll takes and when it
// takes none, the claim and its release, the run protocol at each turn's end (verdict → docs
// turn → PR → `in_review`, or `not_needed` → `done`), the branch check before either, the
// failure count and the pause, the provider preflight, the time cap, a finding card's rules, the
// `report_outcome` tool and the routes. Real in-memory registry, a stubbed cloud, and a fake
// runtime the test drives through each turn.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HttpAdapterHost } from "@nestjs/core";
import { BadRequestException, NotFoundException } from "@nestjs/common";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Task } from "@kermanych/cloud";
import {
  MINION_AGENT_ID,
  MINION_GRACE_MS,
  MINION_OUTCOME_CONTRACT,
  MINION_POLL_MS,
  MINION_TIME_CAP_MS,
  MINION_TIME_CAP_PROMPT,
  MINION_PR_TITLE_RULE,
  agentById,
  minionFindingLine,
  renderInstruction,
  type RpcEvent,
  type ServerEvent,
  type Session,
  type Project,
} from "@kermanych/core";
import type { WorktreeService } from "../src/worktree/worktree.service";
import type { AuthService } from "../src/auth/auth.service";
import type { ModelsService } from "../src/models/models.service";
import type { PreviewService } from "../src/preview/preview.service";
import type { MachineResourcesService } from "../src/machine/machine-resources.service";
import type { RuntimeCheck, RuntimeCheckService } from "../src/runtime/runtime-check.service";

// Every managed spawn, whatever the runtime: the kind, the launch options and the child.
type FakeChild = {
  opts: Record<string, unknown>;
  prompts: string[];
  steers: string[];
  alive: boolean;
  emit: (e: RpcEvent) => void;
  exit: (code: number | null, reason: string, cause?: string) => void;
};
const spawns: { kind: string; opts: Record<string, unknown>; child: FakeChild }[] = [];
// The next child's start fails the way both runtimes fail it: the exit callbacks fire first
// (omp's failAll, claude's death path), then start() rejects.
const startFailure = vi.hoisted(() => ({ next: undefined as string | undefined }));
vi.mock("../src/runtime/agent-runtime", () => {
  class FakeRuntime {
    prompts: string[] = [];
    steers: string[] = [];
    alive = true;
    droppedFrames = 0;
    emit: (e: RpcEvent) => void = () => {};
    exit: (code: number | null, reason: string, cause?: string) => void = () => {};
    constructor(public opts: Record<string, unknown>) {}
    onEvent(cb: (e: RpcEvent) => void) {
      this.emit = cb;
    }
    onExit(cb: (code: number | null, reason: string, cause?: string) => void) {
      this.exit = cb;
    }
    async start() {
      const reason = startFailure.next;
      if (!reason) return;
      startFailure.next = undefined;
      this.alive = false;
      this.exit(1, reason);
      throw new Error(reason);
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
      this.steers.push(text);
    }
    answerUi() {}
    async getState() {
      return { isStreaming: false };
    }
    async switchSession() {}
    async setModel() {}
    async setThinkingLevel() {}
    async compact() {}
    async getAllMessages() {
      return [];
    }
    async getSubagents() {
      return [];
    }
    async getSubagentMessages() {
      return { messages: [], nextByte: 0 };
    }
    async stop() {
      this.alive = false;
      this.exit(0, "stopped");
    }
  }
  return {
    createRuntime: (kind: string, opts: Record<string, unknown>) => {
      const child = new FakeRuntime(opts);
      spawns.push({ kind, opts, child: child as unknown as FakeChild });
      return child;
    },
  };
});

// The cloud: an in-memory `tasks` map. `listMinionCandidates` and `claimMinionTask` reproduce
// the candidate predicate; `lose` names cards another machine of the same user claims first.
const USER = "11111111-1111-1111-1111-111111111111";
const OTHER = "22222222-2222-2222-2222-222222222222";
const cards = new Map<string, Task>();
const claims: string[] = [];
const releases: { id: string; previous: { status: Task["status"]; assigneeId?: string } }[] = [];
const lose = new Set<string>();
let listCalls = 0;
const eligible = (t: Task, projectIds: string[], userId: string) =>
  projectIds.includes(t.projectId) &&
  t.status === "backlog" &&
  t.autoRun &&
  t.createdBy === userId &&
  !t.deepAnalysis &&
  !t.design &&
  !t.jiraKey &&
  !t.linearKey &&
  (!t.assigneeId || t.assigneeId === userId);
vi.mock("@kermanych/cloud", () => ({
  getTask: async (_c: unknown, id: string) => cards.get(id),
  listProjects: async () => [],
  patchTask: async () => undefined,
  listMinionCandidates: async (_c: unknown, projectIds: string[], userId: string) => {
    listCalls++;
    return [...cards.values()].filter((t) => eligible(t, projectIds, userId)).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  },
  claimMinionTask: async (_c: unknown, id: string, userId: string) => {
    claims.push(id);
    const t = cards.get(id);
    if (!t) return undefined;
    if (lose.has(id)) {
      cards.set(id, { ...t, status: "queued", assigneeId: userId });
      return undefined;
    }
    if (t.status !== "backlog" || (t.assigneeId && t.assigneeId !== userId)) return undefined;
    const next: Task = { ...t, status: "queued", assigneeId: userId };
    cards.set(id, next);
    return next;
  },
  claimTaskForLaunch: async (_c: unknown, id: string, userId: string, from: Task["status"]) => {
    const t = cards.get(id);
    if (!t || t.status !== from || (t.assigneeId && t.assigneeId !== userId)) return undefined;
    const next: Task = { ...t, status: "queued", assigneeId: userId };
    cards.set(id, next);
    return next;
  },
  releaseLaunchClaim: async (_c: unknown, id: string, previous: { status: Task["status"]; assigneeId?: string }) => {
    releases.push({ id, previous });
    const t = cards.get(id);
    if (t) cards.set(id, { ...t, status: previous.status, ...(previous.assigneeId ? {} : { assigneeId: undefined }) });
  },
}));

import { SupervisorService } from "../src/supervisor/supervisor.service";
import { RegistryService } from "../src/registry/registry.service";
import { BrowserMcpService } from "../src/browser/browser-mcp.service";
import { MinionService } from "../src/minion/minion.service";
import { MinionController } from "../src/http/minion.controller";
import { NO_ASK_OVERLAY } from "../src/minion/ask-overlay";
import { setKeepAwake } from "../src/minion/keep-awake";
import { stubSkills } from "./skills-stub";
import { SkillsService } from "../src/skills/skills.service";

const NOW = "2026-10-23T10:00:00.000Z";
const PR_URL = "https://github.com/o/r/pull/7";
const http = { httpAdapter: { getHttpServer: () => ({ address: () => ({ port: 4317 }) }) } } as unknown as HttpAdapterHost;
type CallResult = { content: { type: string; text: string }[]; isError?: boolean };

// The machine profile: `agents: null` is «declined» (no slots at all).
let agents: number | null = null;
const resources = {
  active: () => (agents === null ? null : { agents, subagents: 2, background: false, testWorkers: 1, lowerPriority: false, watchdog: false, criticalAction: "kill" }),
  ompOverlay: async () => undefined,
  claudeEnv: () => undefined,
  promptParagraph: () => undefined,
  renice: () => {},
  onChange: () => {},
} as unknown as MachineResourcesService;

let signedIn = true;
let preflight: RuntimeCheck = { ok: true };
let home = "";

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
    forkStart: vi.fn(async (_repo: string, base: string) => ({ ref: base, stale: false })),
    forkPoint: vi.fn().mockResolvedValue(""),
    // A run's branch carries the agent's work unless a test says otherwise.
    changedFiles: vi.fn().mockResolvedValue([{ path: "src/login.ts", added: 12, removed: 3 }]),
    unmergedFiles: vi.fn().mockResolvedValue([]),
    hasUncommitted: vi.fn().mockResolvedValue(false),
    fetchBranch: vi.fn().mockResolvedValue("skipped"),
    refExists: vi.fn().mockResolvedValue(false),
    behindCount: vi.fn().mockResolvedValue(0),
  };
  const auth = {
    current: () => (signedIn ? { userId: USER, accessToken: "token" } : undefined),
    cloudClient: () => ({}),
  } as unknown as AuthService;
  const skills = Object.assign(stubSkills(), { assignedForNames: async () => ({ block: "", view: [], missing: [] }) });
  const models = { validModel: async (_r: string, w: string | undefined) => w } as unknown as ModelsService;
  const browser = new BrowserMcpService(registry, { urlOf: () => undefined } as unknown as PreviewService, http);
  const sup = new SupervisorService(registry, worktree as unknown as WorktreeService, auth, skills, models, undefined, browser, resources);
  const runtimeCheck = { check: vi.fn(async () => preflight) };
  const minion = new MinionService(registry, sup, auth, runtimeCheck as unknown as RuntimeCheckService);
  const events: ServerEvent[] = [];
  sup.events$.subscribe((e) => events.push(e));

  const bindProject = (id: string, active = true): Project => {
    const p = registry.upsertProject({ id, name: id, localRepoPath: `/tmp/kmq-minion-${id}` });
    if (active) registry.setMinionProject(id, true);
    return p;
  };
  const minionSessions = () => registry.listSessions().filter((s) => s.minion);
  const row = (id: string) => sup.snapshot().sessions.find((s) => s.id === id)!;
  const childOf = (id: string) => {
    const wt = registry.listSessions().find((s) => s.id === id)!.worktreePath;
    return spawns.filter((s) => s.opts.cwd === wt).at(-1)!.child;
  };
  const report = async (sessionId: string, args: unknown) =>
    ((await browser.handle(sessionId, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "report_outcome", arguments: args } })) as { result: CallResult })
      .result;
  return { sup, registry, worktree, skills, browser, minion, runtimeCheck, events, bindProject, minionSessions, row, childOf, report };
}

function card(over: Partial<Task> & { id: string; projectId: string }): Task {
  const t: Task = {
    title: `Card ${over.id}`,
    description: `do ${over.id}`,
    status: "backlog",
    createdBy: USER,
    createdAt: NOW,
    updatedAt: NOW,
    worktree: true,
    hidden: false,
    deepAnalysis: false,
    design: false,
    autoRun: true,
    ...over,
  };
  cards.set(t.id, t);
  return t;
}

// One whole turn of a running child, ending at rest.
function turn(child: FakeChild, ...middle: RpcEvent[]) {
  child.emit({ type: "agent_start" } as RpcEvent);
  for (const e of middle) child.emit(e);
  child.emit({ type: "agent_end" } as RpcEvent);
}

// A PR URL in the agent's reply: what settles a PR turn at `in_review`.
const prReply: RpcEvent[] = [
  { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: `PR: ${PR_URL}` } } as unknown as RpcEvent,
  { type: "message_end", message: { role: "assistant" } } as unknown as RpcEvent,
];

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

beforeEach(() => {
  spawns.length = 0;
  cards.clear();
  claims.length = 0;
  releases.length = 0;
  lose.clear();
  listCalls = 0;
  agents = null;
  signedIn = true;
  preflight = { ok: true };
  home = mkdtempSync(join(tmpdir(), "kmq-minion-"));
  process.env.KERMANYCH_SKILLS_HOME = home;
});

afterEach(() => {
  vi.useRealTimers();
  setKeepAwake(undefined);
  delete process.env.KERMANYCH_SKILLS_HOME;
  rmSync(home, { recursive: true, force: true });
});

describe("which card the minion takes", () => {
  it("takes the oldest eligible card across the active projects, and starts it as a minion run", async () => {
    const { minion, bindProject, minionSessions, sup, browser } = make();
    bindProject("p1");
    bindProject("p2");
    bindProject("p3", false);
    card({ id: "newer", projectId: "p1", createdAt: "2026-10-23T10:02:00.000Z" });
    card({ id: "oldest", projectId: "p2", createdAt: "2026-10-23T10:01:00.000Z", worktree: false });
    card({ id: "colleague", projectId: "p1", createdAt: "2026-10-23T09:00:00.000Z", createdBy: OTHER });
    card({ id: "inactive", projectId: "p3", createdAt: "2026-10-23T08:00:00.000Z" });

    await minion.poll();

    expect(claims).toEqual(["oldest"]);
    expect(cards.get("oldest")).toMatchObject({ status: "queued", assigneeId: USER });
    const [s] = minionSessions();
    expect(s).toMatchObject({ taskId: "oldest", projectId: "p2", minion: true, kind: "agent", runtime: "omp" });
    // The card's in-place choice is ignored: the operator works in that checkout.
    expect(s!.worktree).toBe(true);
    expect(minion.state()).toMatchObject({ running: 1, waiting: 2, projects: ["p1", "p2"] });

    // The model gets the minion's instruction around the card, then the outcome contract and the
    // work directives; the transcript shows the raw card text.
    const { child, opts } = spawns[0]!;
    const prompt = child.prompts[0]!;
    expect(prompt.startsWith(renderInstruction(agentById(MINION_AGENT_ID)!, { task: "Card oldest\n\ndo oldest" }))).toBe(true);
    expect(prompt).toContain(MINION_OUTCOME_CONTRACT);
    expect(prompt).toMatch(/Co-Authored-By: Kermanych </);
    expect(sup.getTranscript(s!.id).find((e) => e.kind === "user_text")).toMatchObject({ text: "do oldest" });
    // No ask tool (a third omp overlay), and the `kermanych` MCP server that serves report_outcome.
    const overlay = (opts.configPaths as string[]).at(-1)!;
    expect(readFileSync(overlay, "utf8")).toBe(NO_ASK_OVERLAY);
    expect(opts.mcp).toMatchObject({ name: "kermanych" });
    expect(browser.sessionFor((opts.mcp as { token: string }).token)).toBe(s!.id);

    // At the cap (1) the next poll takes nothing.
    await minion.poll();
    expect(claims).toEqual(["oldest"]);
  });

  it("gives a claude run disallowedTools instead of the overlay, on its first spawn and on a wake", async () => {
    process.env.KERMANYCH_RUNTIME = "claude-code";
    try {
      const { minion, bindProject, minionSessions, sup } = make();
      bindProject("p1");
      card({ id: "a", projectId: "p1" });
      await minion.poll();
      expect(spawns[0]!.kind).toBe("claude-code");
      expect(spawns[0]!.opts.disallowedTools).toEqual(["AskUserQuestion"]);

      const [s] = minionSessions();
      await sup.restartSession(s!.id);
      expect(spawns).toHaveLength(2);
      expect(spawns[1]!.opts.disallowedTools).toEqual(["AskUserQuestion"]);
    } finally {
      delete process.env.KERMANYCH_RUNTIME;
    }
  });

  it("takes nothing while paused", async () => {
    const { minion, bindProject } = make();
    bindProject("p1");
    card({ id: "a", projectId: "p1" });
    minion.update({ paused: true });
    // An operator pause takes nothing, but the poll still counts the waiting cards for the strip.
    await minion.poll();
    expect(minion.state().waiting).toBe(1);
    expect(claims).toEqual([]);
    expect(minion.state().pause).toMatchObject({ code: "operator" });
  });

  it("takes nothing without a free agent slot, or while an operator session waits for one", async () => {
    const { minion, bindProject, registry, sup } = make();
    const project = bindProject("p1");
    card({ id: "a", projectId: "p1" });
    agents = 1;
    const launch = (name: string) =>
      (sup as unknown as { launch(s: Session, p: Project): Promise<Session> }).launch(
        registry.createSession({ projectId: "p1", name, task: `task ${name}`, worktreePath: "", branch: `feature/${name}`, worktree: false }),
        project,
      );
    await launch("operator-a");
    await minion.poll();
    expect(claims).toEqual([]);

    // A second operator launch waits; a raised limit frees a slot, but someone still waits for it.
    await launch("operator-b");
    expect(sup.slotCounts()).toEqual({ running: 1, waiting: 1 });
    agents = 2;
    await minion.poll();
    expect(claims).toEqual([]);
  });

  it("asks the cloud again on its interval", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const { minion, bindProject } = make();
    bindProject("p1");
    minion.onModuleInit();
    expect(listCalls).toBe(0);
    vi.advanceTimersByTime(MINION_POLL_MS);
    await vi.waitFor(() => expect(listCalls).toBe(1));
    minion.onModuleDestroy();
  });
});

describe("the claim", () => {
  it("a lost claim takes nothing; the next candidate is tried", async () => {
    const { minion, bindProject, minionSessions } = make();
    bindProject("p1");
    card({ id: "first", projectId: "p1", createdAt: "2026-10-23T10:01:00.000Z" });
    lose.add("first");

    await minion.poll();
    expect(claims).toEqual(["first"]);
    expect(minionSessions()).toHaveLength(0);
    expect(releases).toEqual([]);
    expect(minion.state().failures).toBe(0);

    card({ id: "second", projectId: "p1", createdAt: "2026-10-23T10:02:00.000Z" });
    card({ id: "third", projectId: "p1", createdAt: "2026-10-23T10:03:00.000Z" });
    lose.add("second");
    await minion.poll();
    expect(claims).toEqual(["first", "second", "third"]);
    expect(minionSessions().map((s) => s.taskId)).toEqual(["third"]);
  });

  it("a failed launch puts the card back in the backlog and counts; two in a row pause", async () => {
    const { minion, bindProject, minionSessions, worktree } = make();
    bindProject("p1");
    card({ id: "a", projectId: "p1", title: "Broken A", createdAt: "2026-10-23T10:01:00.000Z" });
    card({ id: "b", projectId: "p1", title: "Broken B", createdAt: "2026-10-23T10:02:00.000Z", assigneeId: USER });
    worktree.addWorktree.mockRejectedValue(new Error("fatal: invalid reference"));

    await minion.poll();
    expect(minionSessions()).toHaveLength(0);
    expect(cards.get("a")).toMatchObject({ status: "backlog", assigneeId: undefined });
    expect(releases).toEqual([{ id: "a", previous: { status: "backlog", assigneeId: undefined } }]);
    expect(minion.state()).toMatchObject({ failures: 1 });
    expect(minion.state().pause).toBeUndefined();

    // «a» is back in the backlog and oldest: it fails again, and the minion pauses.
    await minion.poll();
    expect(minion.state()).toMatchObject({ failures: 2, pause: { code: "failures", detail: "«Broken A»: fatal: invalid reference" } });
    await minion.poll();
    expect(claims).toEqual(["a", "a"]);
    // Resumed with «a» gone: «b», already the user's, fails too and keeps that assignment.
    cards.delete("a");
    minion.update({ paused: false });
    await vi.waitFor(() => expect(releases).toHaveLength(3));
    expect(releases[2]).toEqual({ id: "b", previous: { status: "backlog", assigneeId: USER } });
    expect(cards.get("b")).toMatchObject({ status: "backlog", assigneeId: USER });
    expect(minion.state()).toMatchObject({ failures: 1 });
  });

  // Both runtimes fire the exit callbacks before start() rejects. Counted in the supervisor and
  // again in the launch path, a single bad card (a model the provider refuses) would pause it.
  it("a child that dies while its launch is starting counts once, and puts nothing but backlog on the card", async () => {
    const { minion, bindProject, minionSessions, events } = make();
    bindProject("p1");
    card({ id: "a", projectId: "p1", title: "Bad model" });
    startFailure.next = "model not available";

    await minion.poll();
    expect(minionSessions()).toHaveLength(0);
    expect(minion.state()).toMatchObject({ failures: 1 });
    expect(minion.state().pause).toBeUndefined();
    expect(cards.get("a")).toMatchObject({ status: "backlog" });
    // No `error` reached the stream the status outbox mirrors: it would race the release.
    expect(events.some((e) => e.type === "session_update" && e.session.status === "error")).toBe(false);
  });

  it("a signed-out provider pauses the minion before any claim", async () => {
    const { minion, bindProject, runtimeCheck } = make();
    bindProject("p1");
    card({ id: "a", projectId: "p1" });
    preflight = { ok: false, code: "omp_not_authenticated" };

    await minion.poll();
    expect(runtimeCheck.check).toHaveBeenCalledWith("omp");
    expect(claims).toEqual([]);
    expect(minion.state().pause).toMatchObject({ code: "signed_out" });

    // Resuming forgets the cached verdict and polls at once.
    preflight = { ok: true };
    minion.update({ paused: false });
    await minion.poll();
    expect(claims).toEqual(["a"]);
  });

  it("other preflight failures skip the poll with the reason, without pausing", async () => {
    const { minion, bindProject } = make();
    bindProject("p1");
    card({ id: "a", projectId: "p1" });
    preflight = { ok: false, code: "omp_binary_missing" };

    await minion.poll();
    expect(claims).toEqual([]);
    expect(minion.state()).toMatchObject({ pollError: "omp_binary_missing" });
    expect(minion.state().pause).toBeUndefined();
  });

  it("says why it could not ask the cloud while signed out", async () => {
    const { minion, bindProject } = make();
    bindProject("p1");
    signedIn = false;
    await minion.poll();
    expect(minion.state().pollError).toBe("not signed in");
    expect(listCalls).toBe(0);
  });

  it("a manual ▶ on an auto-run card is an ordinary session", async () => {
    const { sup, bindProject } = make();
    bindProject("p1");
    card({ id: "a", projectId: "p1" });
    const s = await sup.createSessionFromTask("a", USER);
    expect(s.minion).toBeUndefined();
    expect(spawns[0]!.child.prompts[0]).toMatch(/^do a\n\n/);
    expect(cards.get("a")).toMatchObject({ status: "queued", assigneeId: USER });
  });
});

describe("the run protocol", () => {
  it("ready → one docs turn → PR → in_review with the PR, resetting the failures", async () => {
    const { minion, bindProject, minionSessions, sup, row, childOf, report, registry } = make();
    const hold = vi.fn();
    setKeepAwake(hold);
    bindProject("p1");
    card({ id: "a", projectId: "p1" });
    registry.setMinionSettings({ cap: 1, failures: 1 });
    let gate = ["task-spec"];
    vi.spyOn(sup, "docsGate").mockImplementation(async () => ({ enabled: true, failures: gate as never }));

    await minion.poll();
    const [s] = minionSessions();
    const child = childOf(s!.id);
    expect(hold).toHaveBeenNthCalledWith(1, true);

    child.emit({ type: "agent_start" } as RpcEvent);
    expect((await report(s!.id, { outcome: "ready", summary: "Added login. Decided to reuse the OAuth helper." })).content[0]!.text).toBe(
      "Recorded: ready. End your turn now.",
    );
    child.emit({ type: "agent_end" } as RpcEvent);
    // Between the verdict and the next turn the run stays active — never `done`, which would put
    // the card in the closed lane and let another machine's ▶ start it again.
    expect(row(s!.id).status).toBe("queued");
    // The gate fails: one «Доповнити документацію» turn.
    await vi.waitFor(() => expect(child.prompts).toHaveLength(2));
    expect(child.prompts[1]).toContain("the project requires documentation");
    expect(minion.state().running).toBe(1);

    gate = [];
    turn(child);
    await vi.waitFor(() => expect(child.prompts).toHaveLength(3));
    expect(child.prompts[2]).toMatch(/gh pr create/);
    // The PR is told apart by its title, whatever the PR agent's instruction says.
    expect(child.prompts[2]).toContain(MINION_PR_TITLE_RULE);
    await flush();

    turn(child, ...prReply);
    await vi.waitFor(() => expect(row(s!.id).minionResult).toEqual({ outcome: "pr" }));
    expect(row(s!.id).status).toBe("in_review");
    expect(minion.state()).toMatchObject({ failures: 0, running: 0 });
    expect(hold).toHaveBeenLastCalledWith(false);
    // The result reaches the card with the session report.
    await vi.waitFor(() =>
      expect(registry.listReportOutbox().find((r) => r.taskId === "a")?.write.session).toMatchObject({ minion: { outcome: "pr" } }),
    );
  });

  it("a gate still failing after the docs turn hands the run to a person", async () => {
    const { minion, bindProject, minionSessions, sup, row, childOf, report } = make();
    bindProject("p1");
    card({ id: "a", projectId: "p1" });
    vi.spyOn(sup, "docsGate").mockImplementation(async () => ({ enabled: true, failures: ["task-spec", "plan"] }));

    await minion.poll();
    const [s] = minionSessions();
    const child = childOf(s!.id);
    child.emit({ type: "agent_start" } as RpcEvent);
    await report(s!.id, { outcome: "ready", summary: "done" });
    child.emit({ type: "agent_end" } as RpcEvent);
    await vi.waitFor(() => expect(child.prompts).toHaveLength(2));
    turn(child);

    await vi.waitFor(() => expect(row(s!.id).minionResult).toEqual({ outcome: "needs_decision", code: "docs_gate", reason: "task-spec, plan" }));
    expect(row(s!.id).status).toBe("in_review");
    expect(child.prompts).toHaveLength(2);
    expect(minion.state().failures).toBe(1);
  });

  it("a PR the operator opens after «потрібне рішення» becomes the card's result, counted neither way", async () => {
    const { minion, bindProject, minionSessions, sup, row, childOf, report, registry } = make();
    bindProject("p1");
    card({ id: "a", projectId: "p1" });
    await minion.poll();
    const [s] = minionSessions();
    const child = childOf(s!.id);
    child.emit({ type: "agent_start" } as RpcEvent);
    await report(s!.id, { outcome: "needs_decision", summary: "Which API version?" });
    child.emit({ type: "agent_end" } as RpcEvent);
    registry.setMinionSettings({ cap: 1, failures: 1 });

    // «Створити ПР» on the finish sheet, instead of an answer.
    await sup.createPullRequest(s!.id);
    turn(child, ...prReply);
    await vi.waitFor(() => expect(row(s!.id).minionResult).toEqual({ outcome: "pr" }));
    expect(minion.state().failures).toBe(1);
  });

  it("the agent's own needs_decision settles at in_review with its summary and resets the failures; an answer resumes the flow", async () => {
    const { minion, bindProject, minionSessions, sup, row, childOf, report, registry, events } = make();
    bindProject("p1");
    card({ id: "a", projectId: "p1" });
    registry.setMinionSettings({ cap: 1, failures: 1 });

    await minion.poll();
    const [s] = minionSessions();
    const child = childOf(s!.id);
    child.emit({ type: "agent_start" } as RpcEvent);
    await report(s!.id, { outcome: "needs_decision", summary: "The card asks for SAML, the code only has OAuth. Which one?" });
    child.emit({ type: "agent_end" } as RpcEvent);

    expect(row(s!.id).status).toBe("in_review");
    expect(row(s!.id).minionResult).toEqual({ outcome: "needs_decision", reason: "The card asks for SAML, the code only has OAuth. Which one?" });
    // The settle itself already said `in_review` — the card's status follows that event.
    const update = events.filter((e): e is Extract<ServerEvent, { type: "session_update" }> => e.type === "session_update" && e.session.id === s!.id).at(-1)!;
    expect(update.session.status).toBe("in_review");
    expect(minion.state().failures).toBe(0);
    expect(events.some((e) => e.type === "minion_update")).toBe(true);

    // The operator answers; the run continues and its next `ready` leads to the PR.
    await sup.sendMessage(s!.id, "OAuth.", "prompt");
    child.emit({ type: "agent_start" } as RpcEvent);
    await report(s!.id, { outcome: "ready", summary: "OAuth it is." });
    child.emit({ type: "agent_end" } as RpcEvent);
    await vi.waitFor(() => expect(child.prompts.at(-1)).toMatch(/gh pr create/));
  });

  // The PR turn's own report write (queued at `agent_end`, before the result) can finish its
  // diff after the result's write; the card must not keep «потрібне рішення» then.
  it("the card's report ends on the PR even when the turn's own report write finishes last", async () => {
    const { minion, bindProject, minionSessions, sup, row, childOf, report, registry, worktree } = make();
    bindProject("p1");
    card({ id: "a", projectId: "p1" });
    await minion.poll();
    const [s] = minionSessions();
    const child = childOf(s!.id);
    child.emit({ type: "agent_start" } as RpcEvent);
    await report(s!.id, { outcome: "needs_decision", summary: "Which locale?" });
    child.emit({ type: "agent_end" } as RpcEvent);
    await sup.sendMessage(s!.id, "uk-UA.", "prompt");
    child.emit({ type: "agent_start" } as RpcEvent);
    await report(s!.id, { outcome: "ready", summary: "Done." });
    child.emit({ type: "agent_end" } as RpcEvent);
    await vi.waitFor(() => expect(child.prompts.at(-1)).toMatch(/gh pr create/));

    const slowDiff = Promise.withResolvers<[]>();
    worktree.changedFiles.mockImplementationOnce(() => slowDiff.promise);
    turn(child, ...prReply);
    await vi.waitFor(() => expect(row(s!.id).minionResult).toEqual({ outcome: "pr" }));
    await flush();
    expect(registry.listReportOutbox().find((r) => r.taskId === "a")?.write.session.minion).toEqual({ outcome: "pr" });
    // The turn's own write lands last; it must carry the result too.
    slowDiff.resolve([]);
    await flush();
    expect(registry.listReportOutbox().find((r) => r.taskId === "a")?.write.session.minion).toEqual({ outcome: "pr" });
  });

  it("not_needed on an unchanged branch closes the card at done with the evidence, resetting the failures", async () => {
    const { minion, bindProject, minionSessions, sup, row, childOf, report, registry, worktree } = make();
    bindProject("p1");
    card({ id: "a", projectId: "p1" });
    registry.setMinionSettings({ cap: 1, failures: 1 });
    worktree.changedFiles.mockResolvedValue([]);
    const gate = vi.spyOn(sup, "docsGate");
    const evidence = "Already fixed on main: src/math.ts:14 clamps the value since a1b2c3d.";

    await minion.poll();
    const [s] = minionSessions();
    const child = childOf(s!.id);
    child.emit({ type: "agent_start" } as RpcEvent);
    expect((await report(s!.id, { outcome: "not_needed", summary: evidence })).content[0]!.text).toBe("Recorded: not_needed. End your turn now.");
    child.emit({ type: "agent_end" } as RpcEvent);
    // Never `done` before the branch is checked: the card would close on the agent's word alone.
    expect(row(s!.id).status).toBe("queued");

    await vi.waitFor(() => expect(row(s!.id).minionResult).toEqual({ outcome: "not_needed", reason: evidence }));
    expect(row(s!.id).status).toBe("done");
    await vi.waitFor(() => expect(minion.state()).toMatchObject({ failures: 0, running: 0 }));
    expect(child.prompts).toHaveLength(1);
    expect(gate).not.toHaveBeenCalled();
    await vi.waitFor(() =>
      expect(registry.listReportOutbox().find((r) => r.taskId === "a")?.write.session.minion).toEqual({ outcome: "not_needed", reason: evidence }),
    );
  });

  it("not_needed that left changes on the branch hands the run to a person, as a failure", async () => {
    const { minion, bindProject, minionSessions, row, childOf, report } = make();
    bindProject("p1");
    card({ id: "a", projectId: "p1" });

    await minion.poll();
    const [s] = minionSessions();
    const child = childOf(s!.id);
    child.emit({ type: "agent_start" } as RpcEvent);
    await report(s!.id, { outcome: "not_needed", summary: "The check already exists." });
    child.emit({ type: "agent_end" } as RpcEvent);

    await vi.waitFor(() => expect(row(s!.id).minionResult).toEqual({ outcome: "needs_decision", code: "has_changes", reason: "The check already exists." }));
    expect(row(s!.id).status).toBe("in_review");
    expect(minion.state().failures).toBe(1);
    expect(child.prompts).toHaveLength(1);
  });

  it("ready on an unchanged branch goes to a person before any docs or PR turn, as a failure", async () => {
    const { minion, bindProject, minionSessions, sup, row, childOf, report, worktree } = make();
    bindProject("p1");
    card({ id: "a", projectId: "p1" });
    worktree.changedFiles.mockResolvedValue([]);
    const gate = vi.spyOn(sup, "docsGate").mockImplementation(async () => ({ enabled: true, failures: ["task-spec"] }));

    await minion.poll();
    const [s] = minionSessions();
    const child = childOf(s!.id);
    child.emit({ type: "agent_start" } as RpcEvent);
    await report(s!.id, { outcome: "ready", summary: "Verified the fix." });
    child.emit({ type: "agent_end" } as RpcEvent);

    await vi.waitFor(() => expect(row(s!.id).minionResult).toEqual({ outcome: "needs_decision", code: "no_changes", reason: "Verified the fix." }));
    expect(row(s!.id).status).toBe("in_review");
    expect(minion.state().failures).toBe(1);
    expect(child.prompts).toHaveLength(1);
    expect(gate).not.toHaveBeenCalled();
  });

  // Kermanych copies them into the worktree itself; one the repository does not ignore is listed.
  it("the project's carry files are not the agent's changes", async () => {
    const { minion, bindProject, minionSessions, row, childOf, report, registry, worktree } = make();
    bindProject("p1");
    registry.patchProject("p1", { carryFiles: ["./.env", "config/local.json"] });
    card({ id: "a", projectId: "p1" });
    worktree.changedFiles.mockResolvedValue([
      { path: ".env", added: 4, removed: 0 },
      { path: "config/local.json", added: 9, removed: 0 },
    ]);

    await minion.poll();
    const [s] = minionSessions();
    const child = childOf(s!.id);
    child.emit({ type: "agent_start" } as RpcEvent);
    await report(s!.id, { outcome: "not_needed", summary: "Duplicate of «Clamp the value»." });
    child.emit({ type: "agent_end" } as RpcEvent);

    await vi.waitFor(() => expect(row(s!.id).minionResult).toEqual({ outcome: "not_needed", reason: "Duplicate of «Clamp the value»." }));
    expect(row(s!.id).status).toBe("done");
  });

  it("a stop while Kermanych checks the branch sends nothing more", async () => {
    const { minion, bindProject, minionSessions, sup, row, childOf, report, worktree } = make();
    bindProject("p1");
    card({ id: "a", projectId: "p1" });
    const slowDiff = Promise.withResolvers<{ path: string; added: number; removed: number }[]>();
    worktree.changedFiles.mockImplementation(() => slowDiff.promise);
    // What follows the verdict, only to wait for its end: what must not happen is a later send.
    const advance = vi.spyOn(sup as unknown as { advanceMinion: () => Promise<void> }, "advanceMinion");

    await minion.poll();
    const [s] = minionSessions();
    const child = childOf(s!.id);
    child.emit({ type: "agent_start" } as RpcEvent);
    await report(s!.id, { outcome: "ready", summary: "Done." });
    child.emit({ type: "agent_end" } as RpcEvent);
    await vi.waitFor(() => expect(advance).toHaveBeenCalled());

    const stopping = sup.stopSession(s!.id);
    slowDiff.resolve([{ path: "src/login.ts", added: 1, removed: 0 }]);
    await stopping;
    await advance.mock.results[0]!.value;

    expect(row(s!.id)).toMatchObject({ status: "stopped", minionResult: { outcome: "stopped" } });
    expect(spawns.flatMap((x) => x.child.prompts).some((p) => /gh pr create/.test(p))).toBe(false);
    expect(minion.state().running).toBe(0);
  });

  it("a turn without a verdict settles at in_review as a failure", async () => {
    const { minion, bindProject, minionSessions, row, childOf } = make();
    bindProject("p1");
    card({ id: "a", projectId: "p1" });

    await minion.poll();
    const [s] = minionSessions();
    turn(childOf(s!.id));

    expect(row(s!.id).status).toBe("in_review");
    expect(row(s!.id).minionResult).toEqual({ outcome: "needs_decision", code: "no_outcome" });
    expect(minion.state().failures).toBe(1);
  });

  it("a PR turn without a PR is a failure; two failures pause; a resume clears them", async () => {
    const { minion, bindProject, minionSessions, row, childOf, report } = make();
    bindProject("p1");
    card({ id: "a", projectId: "p1", title: "First", createdAt: "2026-10-23T10:01:00.000Z" });
    card({ id: "b", projectId: "p1", title: "Second", createdAt: "2026-10-23T10:02:00.000Z" });

    await minion.poll();
    const first = minionSessions()[0]!;
    turn(childOf(first.id));
    expect(minion.state().failures).toBe(1);
    // The run ended: the minion polls again by itself and takes the next card.
    await vi.waitFor(() => expect(minionSessions()).toHaveLength(2));
    await minion.poll();

    const second = minionSessions()[1]!;
    const child = childOf(second.id);
    child.emit({ type: "agent_start" } as RpcEvent);
    await report(second.id, { outcome: "ready", summary: "done" });
    child.emit({ type: "agent_end" } as RpcEvent);
    await vi.waitFor(() => expect(child.prompts.at(-1)).toMatch(/gh pr create/));
    await flush();
    turn(child);

    await vi.waitFor(() => expect(row(second.id).minionResult).toEqual({ outcome: "needs_decision", code: "no_pr" }));
    expect(row(second.id).status).toBe("in_review");
    expect(minion.state()).toMatchObject({ failures: 2, pause: { code: "failures", detail: "«Second»: no_pr" } });

    minion.update({ paused: false });
    expect(minion.state().failures).toBe(0);
    expect(minion.state().pause).toBeUndefined();
  });

  it("the operator's stop ends the run as stopped and changes nothing in the count", async () => {
    const { minion, bindProject, minionSessions, sup, row, registry } = make();
    bindProject("p1");
    card({ id: "a", projectId: "p1" });
    registry.setMinionSettings({ cap: 1, failures: 1 });

    await minion.poll();
    const [s] = minionSessions();
    await sup.stopSession(s!.id);

    expect(row(s!.id)).toMatchObject({ status: "stopped", minionResult: { outcome: "stopped" } });
    expect(minion.state()).toMatchObject({ failures: 1, running: 0 });
  });

  it("a child that dies is a failed run; dying signed out also pauses the minion", async () => {
    const { minion, bindProject, minionSessions, row, childOf } = make();
    bindProject("p1");
    card({ id: "a", projectId: "p1" });

    await minion.poll();
    const [s] = minionSessions();
    const child = childOf(s!.id);
    child.emit({ type: "agent_start" } as RpcEvent);
    child.alive = false;
    child.exit(1, "Not logged in", "omp_not_authenticated");

    await vi.waitFor(() => expect(row(s!.id).minionResult).toEqual({ outcome: "failed", code: "session_error", reason: "Not logged in" }));
    expect(row(s!.id).status).toBe("error");
    expect(minion.state()).toMatchObject({ failures: 1, pause: { code: "signed_out" } });
  });

  it("the time cap tells the run to stop, then stops the turn and counts a failure", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { minion, bindProject, minionSessions, row, childOf } = make();
    bindProject("p1");
    card({ id: "a", projectId: "p1" });

    await minion.poll();
    const [s] = minionSessions();
    const child = childOf(s!.id);
    child.emit({ type: "agent_start" } as RpcEvent);

    await vi.advanceTimersByTimeAsync(MINION_TIME_CAP_MS);
    await vi.waitFor(() => expect(child.steers).toEqual([MINION_TIME_CAP_PROMPT]));
    expect(child.alive).toBe(true);

    await vi.advanceTimersByTimeAsync(MINION_GRACE_MS);
    await vi.waitFor(() => expect(row(s!.id).minionResult).toEqual({ outcome: "needs_decision", code: "time_cap" }));
    expect(child.alive).toBe(false);
    // The session stays for the operator, on review.
    expect(row(s!.id).status).toBe("in_review");
    expect(minion.state().failures).toBe(1);
  });

  it("a verdict within the grace is kept, and the cap still counts as a failure", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { minion, bindProject, minionSessions, row, childOf, report } = make();
    bindProject("p1");
    card({ id: "a", projectId: "p1" });

    await minion.poll();
    const [s] = minionSessions();
    const child = childOf(s!.id);
    child.emit({ type: "agent_start" } as RpcEvent);
    await vi.advanceTimersByTimeAsync(MINION_TIME_CAP_MS);
    await vi.waitFor(() => expect(child.steers).toHaveLength(1));
    await report(s!.id, { outcome: "needs_decision", summary: "Half done: the API part is left." });
    child.emit({ type: "agent_end" } as RpcEvent);
    await vi.advanceTimersByTimeAsync(MINION_GRACE_MS);

    expect(child.alive).toBe(true);
    expect(row(s!.id).minionResult).toEqual({ outcome: "needs_decision", code: "time_cap", reason: "Half done: the API part is left." });
    expect(minion.state().failures).toBe(1);
  });

  it("an operator who answered the run takes the clock away", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { minion, bindProject, minionSessions, sup, childOf } = make();
    bindProject("p1");
    card({ id: "a", projectId: "p1" });

    await minion.poll();
    const [s] = minionSessions();
    const child = childOf(s!.id);
    child.emit({ type: "agent_start" } as RpcEvent);
    await sup.sendMessage(s!.id, "focus on the API first", "steer");
    await vi.advanceTimersByTimeAsync(MINION_TIME_CAP_MS + MINION_GRACE_MS);

    expect(child.steers).toEqual(["focus on the API first"]);
    expect(child.alive).toBe(true);
  });
});

describe("a card filed from a finding", () => {
  it("tells the run its kind and brings the minion-findings rules; an ordinary card gets neither", async () => {
    const { minion, bindProject, minionSessions, registry, skills, childOf } = make();
    // The real resolution over an empty library: the default skill, with nothing set up.
    const library = new SkillsService({ cloudClient: () => ({}) } as never);
    library.readAssignments = async () => [];
    library.readSkills = async () => [];
    Object.assign(skills, { assignedFor: library.assignedFor.bind(library) });
    bindProject("p1");
    registry.setMinionSettings({ cap: 2, failures: 0 });
    card({ id: "finding", projectId: "p1", findingKind: "security", createdAt: "2026-10-23T10:01:00.000Z" });
    card({ id: "plain", projectId: "p1", createdAt: "2026-10-23T10:02:00.000Z" });

    await minion.poll();
    await minion.poll();
    const byCard = (taskId: string) => minionSessions().find((s) => s.taskId === taskId)!;

    // Stamped on the session, so a relaunch of the run gets the same rules.
    expect(byCard("finding").findingKind).toBe("security");
    const prompt = childOf(byCard("finding").id).prompts[0]!;
    const at = (text: string) => prompt.indexOf(text);
    expect(at("do finding")).toBeGreaterThan(-1);
    expect(at(minionFindingLine("security"))).toBeGreaterThan(at("do finding"));
    expect(at("## security")).toBeGreaterThan(at(minionFindingLine("security")));
    expect(at(MINION_OUTCOME_CONTRACT)).toBeGreaterThan(at("## security"));

    expect(byCard("plain").findingKind).toBeUndefined();
    const plain = childOf(byCard("plain").id).prompts[0]!;
    expect(plain).not.toContain("«Знахідка»");
    expect(plain).not.toContain("## security");
  });
});

describe("report_outcome", () => {
  it("is listed only for minion sessions and refused for any other", async () => {
    const { minion, bindProject, minionSessions, browser, registry, report } = make();
    bindProject("p1");
    card({ id: "a", projectId: "p1" });
    await minion.poll();
    const [s] = minionSessions();
    const plain = registry.createSession({ projectId: "p1", name: "n", task: "t", worktreePath: "", branch: "b" });

    const names = async (id: string) =>
      ((await browser.handle(id, { jsonrpc: "2.0", id: 1, method: "tools/list" })) as { result: { tools: { name: string }[] } }).result.tools.map((t) => t.name);
    expect(await names(s!.id)).toContain("report_outcome");
    expect(await names(plain.id)).not.toContain("report_outcome");

    const refused = await report(plain.id, { outcome: "ready", summary: "x" });
    expect(refused.isError).toBe(true);
    expect(refused.content[0]!.text).toMatch(/only for «Посіпака» runs/);
  });

  it("refuses bad arguments, naming the field", async () => {
    const { minion, bindProject, minionSessions, report } = make();
    bindProject("p1");
    card({ id: "a", projectId: "p1" });
    await minion.poll();
    const [s] = minionSessions();

    const badOutcome = await report(s!.id, { outcome: "done", summary: "x" });
    expect(badOutcome).toMatchObject({ isError: true });
    expect(badOutcome.content[0]!.text).toMatch(/outcome must be one of/);
    const badSummary = await report(s!.id, { outcome: "ready", summary: "  " });
    expect(badSummary.content[0]!.text).toMatch(/summary must be/);
  });
});

describe("routes", () => {
  it("validate the cap, pause and activation", async () => {
    const { minion, bindProject, registry } = make();
    const ctl = new MinionController(minion);
    bindProject("p1", false);
    registry.upsertProject({ id: "unbound", name: "u", localRepoPath: "" });

    expect(() => ctl.update({ cap: 0 })).toThrow(BadRequestException);
    expect(() => ctl.update({ cap: "2" })).toThrow(BadRequestException);
    expect(() => ctl.update({ paused: "yes" })).toThrow(BadRequestException);
    expect(ctl.update({ cap: 3 })).toMatchObject({ cap: 3 });
    expect(ctl.update({ cap: 99 })).toMatchObject({ cap: 8 });

    expect(() => ctl.setProject("nope", { active: true })).toThrow(NotFoundException);
    expect(() => ctl.setProject("unbound", { active: true })).toThrow("project not bound");
    expect(() => ctl.setProject("p1", { active: "on" })).toThrow(BadRequestException);
    expect(ctl.setProject("p1", { active: true })).toMatchObject({ projects: ["p1"] });
    expect(ctl.get()).toMatchObject({ cap: 8, failures: 0, running: 0, projects: ["p1"] });
    expect(ctl.setProject("p1", { active: false }).projects).toEqual([]);
    await minion.poll();
  });

  it("a removed project leaves the activated list", () => {
    const { minion, bindProject, registry } = make();
    bindProject("p1");
    registry.removeProject("p1");
    expect(minion.state().projects).toEqual([]);
  });
});
