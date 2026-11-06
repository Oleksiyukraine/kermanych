// apps/api/test/schedules.spec.ts
// «Задачі за розкладом» (docs/specs/2026-11-06-scheduled-tasks.md): the tick (one claim per
// occurrence, no refire after a restart, the overlap skip, catch-up inside and outside the
// window, the once switch-off, re-arming on an edit), the reminder slip and its snooze, a
// project run (the hidden card, the opening prompt, the no-ask overlay, the end that records,
// announces and retires the worktree, the failed launch that deletes its card, the time cap),
// a one-shot run (its folder, its tools, its stored answer), the preconditions that spend
// nothing, and the controller's refusals. Real in-memory registry, a stubbed cloud, a fake
// runtime the test drives, and a clock faked to the minute.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BadRequestException, NotFoundException } from "@nestjs/common";
import type { Task, TaskInsert } from "@kermanych/cloud";
import {
  ASSIGNED_BLOCK_HEADER,
  MINION_TIME_CAP_MS,
  SCHEDULE_TICK_MS,
  type RpcEvent,
  type ScheduleDraft,
  type ScheduleSlip,
  type ServerEvent,
} from "@kermanych/core";
import type { WorktreeService } from "../src/worktree/worktree.service";
import type { AuthService } from "../src/auth/auth.service";
import type { ModelsService } from "../src/models/models.service";
import type { MachineResourcesService } from "../src/machine/machine-resources.service";

type FakeChild = {
  opts: Record<string, unknown>;
  prompts: string[];
  alive: boolean;
  stopped: boolean;
  emit: (e: RpcEvent) => void;
  exit: (code: number | null, reason: string, cause?: string) => void;
};
const spawns: { opts: Record<string, unknown>; child: FakeChild }[] = [];
// The next child's start fails the way omp fails it: the exit callbacks fire, then start() rejects.
const startFailure = vi.hoisted(() => ({ next: undefined as string | undefined }));
vi.mock("../src/runtime/agent-runtime", () => {
  class FakeRuntime {
    prompts: string[] = [];
    alive = true;
    stopped = false;
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
    steer() {}
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
      this.stopped = true;
      this.exit(0, "stopped");
    }
  }
  return {
    createRuntime: (opts: Record<string, unknown>) => {
      const child = new FakeRuntime(opts);
      spawns.push({ opts, child: child as unknown as FakeChild });
      return child;
    },
  };
});

// The cloud: the cards the scheduler files, claims and deletes.
const USER = "11111111-1111-1111-1111-111111111111";
const cards = new Map<string, Task>();
const created: (TaskInsert & { createdBy: string })[] = [];
const deleted: string[] = [];
let cardSeq = 0;
vi.mock("@kermanych/cloud", () => ({
  getTask: async (_c: unknown, id: string) => cards.get(id),
  listProjects: async () => [],
  patchTask: async () => undefined,
  createTask: async (_c: unknown, input: TaskInsert & { createdBy: string }) => {
    created.push(input);
    const t: Task = {
      id: `card-${++cardSeq}`,
      projectId: input.projectId,
      title: input.title,
      description: input.description,
      status: "backlog",
      assigneeId: input.assigneeId,
      createdBy: input.createdBy,
      model: input.model,
      prefix: input.prefix,
      branchSlug: input.branchSlug,
      worktree: input.worktree ?? true,
      hidden: input.hidden ?? false,
      deepAnalysis: false,
      autoRun: input.autoRun ?? false,
      design: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    } as Task;
    cards.set(t.id, t);
    return t;
  },
  deleteTask: async (_c: unknown, id: string) => {
    deleted.push(id);
    cards.delete(id);
  },
  claimTaskForLaunch: async (_c: unknown, id: string, userId: string, from: Task["status"]) => {
    const t = cards.get(id);
    if (!t || t.status !== from) return undefined;
    const next: Task = { ...t, status: "queued", assigneeId: userId };
    cards.set(id, next);
    return next;
  },
  releaseLaunchClaim: async () => undefined,
}));

import { SupervisorService } from "../src/supervisor/supervisor.service";
import { RegistryService } from "../src/registry/registry.service";
import { ScheduleService, SCHEDULE_START_DELAY_MS, scheduleDir } from "../src/schedules/schedule.service";
import { SchedulesController } from "../src/http/schedules.controller";
import { scheduledRunRules } from "../src/schedules/schedule-prompt";
import { NO_ASK_OVERLAY } from "../src/minion/ask-overlay";
import { setKeepAwake } from "../src/minion/keep-awake";
import { setScheduleTray } from "../src/schedules/schedule-tray";
import { stubSkills } from "./skills-stub";
import { SkillsService } from "../src/skills/skills.service";

const resources = {
  active: () => null,
  ompOverlay: async () => undefined,
  claudeEnv: () => undefined,
  promptParagraph: () => undefined,
  renice: () => {},
  onChange: () => {},
} as unknown as MachineResourcesService;

let signedIn = true;
// Skill names the library knows; anything else is `missing`.
let knownSkills = new Set<string>();
let home = "";

function make(registry = new RegistryService(":memory:")) {
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
    changedFiles: vi.fn().mockResolvedValue([]),
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
  const assignedForNames = vi.fn(async (_scope: unknown, names: readonly string[]) => {
    const found = names.filter((n) => knownSkills.has(n));
    return {
      block: found.length ? `\n\n${ASSIGNED_BLOCK_HEADER}\n\n${found.map((n) => `### ${n}\nBody of ${n}.`).join("\n\n")}` : "",
      view: [],
      missing: names.filter((n) => !knownSkills.has(n)),
    };
  });
  const skills = Object.assign(stubSkills(), { assignedForNames }) as unknown as SkillsService;
  const models = { validModel: async (w: string | undefined) => w } as unknown as ModelsService;
  const sup = new SupervisorService(registry, worktree as unknown as WorktreeService, auth, skills, models, undefined, undefined, resources);
  const svc = new ScheduleService(registry, sup, auth, skills);
  const events: ServerEvent[] = [];
  sup.events$.subscribe((e) => events.push(e));
  const ctl = new SchedulesController(svc, registry);
  // Bound = a checkout on this machine; `false` unbinds an existing row.
  const bindProject = (id: string, bound = true) =>
    registry.listProjects().some((p) => p.id === id)
      ? registry.patchProject(id, { localRepoPath: bound ? `/tmp/kmq-schedule-${id}` : "" })
      : registry.upsertProject({ id, name: id, localRepoPath: bound ? `/tmp/kmq-schedule-${id}` : "" });
  const slips = () => events.filter((e): e is Extract<ServerEvent, { type: "schedule_slip" }> => e.type === "schedule_slip").map((e) => e.slip);
  return { registry, sup, svc, ctl, worktree, assignedForNames, events, slips, bindProject };
}

const at = (iso: string) => vi.setSystemTime(new Date(iso));

const draft = (over: Partial<ScheduleDraft> = {}): ScheduleDraft => ({
  name: "Вітаміни",
  kind: "reminder",
  prompt: "Випити вітаміни",
  schedule: { type: "daily", time: "19:00" },
  timeZone: "UTC",
  ...over,
});

// One whole answer of a child: the text, then the turn's end.
function answer(child: FakeChild, text: string) {
  child.emit({ type: "agent_start" } as RpcEvent);
  child.emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: text } } as unknown as RpcEvent);
  child.emit({ type: "message_end", message: { role: "assistant" } } as unknown as RpcEvent);
  child.emit({ type: "agent_end", isTerminal: true } as unknown as RpcEvent);
}

const childIn = (cwd: string) => spawns.find((s) => s.opts.cwd === cwd)?.child;

beforeEach(() => {
  spawns.length = 0;
  cards.clear();
  created.length = 0;
  deleted.length = 0;
  cardSeq = 0;
  signedIn = true;
  knownSkills = new Set(["weekly-report"]);
  home = mkdtempSync(join(tmpdir(), "kmq-schedules-"));
  process.env.KERMANYCH_SKILLS_HOME = home;
  vi.useFakeTimers({ toFake: ["Date"] });
});

afterEach(() => {
  vi.useRealTimers();
  setKeepAwake(undefined);
  setScheduleTray(undefined);
  delete process.env.KERMANYCH_SKILLS_HOME;
  rmSync(home, { recursive: true, force: true });
});

describe("the tick", () => {
  it("fires a reminder once per occurrence, and a restart does not fire it again", async () => {
    const { svc, registry, slips } = make();
    at("2026-11-06T18:00:00Z");
    const task = await svc.create(draft());
    expect(task.nextAt).toBe("2026-11-06T19:00:00.000Z");

    at("2026-11-06T18:59:00Z");
    await svc.tick();
    expect(registry.listScheduleRuns(task.id)).toEqual([]);

    at("2026-11-06T19:00:30Z");
    await svc.tick();
    await svc.tick();
    const runs = registry.listScheduleRuns(task.id);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ scheduledFor: "2026-11-06T19:00:00.000Z", trigger: "schedule", status: "done" });
    expect(slips()).toHaveLength(1);
    expect(slips()[0]).toMatchObject({ kind: "reminder", scheduleId: task.id, scheduleName: "Вітаміни", text: "Випити вітаміни", late: false, seen: false });
    expect(svc.list()[0]!.nextAt).toBe("2026-11-07T19:00:00.000Z");

    // A new process on the same database: the claim is there, nothing fires.
    const again = make(registry);
    at("2026-11-06T19:03:00Z");
    await again.svc.tick();
    expect(registry.listScheduleRuns(task.id)).toHaveLength(1);
    expect(again.slips()).toEqual([]);
  });

  it("lands a missed reminder once, marked late, however many were slept through", async () => {
    const { svc, registry, slips } = make();
    at("2026-11-03T12:00:00Z");
    const task = await svc.create(draft());
    at("2026-11-06T21:00:00Z");
    await svc.tick();
    expect(registry.listScheduleRuns(task.id)).toHaveLength(1);
    expect(registry.listScheduleRuns(task.id)[0]).toMatchObject({ scheduledFor: "2026-11-06T19:00:00.000Z", trigger: "catch-up" });
    expect(slips()).toHaveLength(1);
    expect(slips()[0]!.late).toBe(true);
  });

  it("switches a «once» task off after it fires", async () => {
    const { svc, slips } = make();
    at("2026-11-06T18:00:00Z");
    const task = await svc.create(draft({ schedule: { type: "once", at: "2026-11-06T18:30" } }));
    at("2026-11-06T18:30:10Z");
    await svc.tick();
    expect(slips()).toHaveLength(1);
    const after = svc.list().find((t) => t.id === task.id)!;
    expect(after.enabled).toBe(false);
    expect(after.nextAt).toBeUndefined();
  });

  it("re-arms on a changed schedule and on a resume, so an edit never fires the past", async () => {
    const { svc, registry } = make();
    at("2026-11-06T18:00:00Z");
    const task = await svc.create(draft());
    // At 19:20 the 19:00 occurrence has not been ticked yet; moving it to 19:10 must not fire 19:10.
    at("2026-11-06T19:20:00Z");
    await svc.update(task.id, { schedule: { type: "daily", time: "19:10" } });
    await svc.tick();
    expect(registry.listScheduleRuns(task.id)).toEqual([]);

    // Paused through 19:10 next day, resumed at 19:30: nothing fires for the paused time.
    await svc.update(task.id, { enabled: false });
    at("2026-11-07T19:30:00Z");
    const resumed = await svc.update(task.id, { enabled: true });
    expect(resumed.armedAt).toBe("2026-11-07T19:30:00.000Z");
    await svc.tick();
    expect(registry.listScheduleRuns(task.id)).toEqual([]);
    expect(resumed.nextAt).toBe("2026-11-08T19:10:00.000Z");

    // A rename does not re-arm.
    const renamed = await svc.update(task.id, { name: "Вітамін D" });
    expect(renamed.armedAt).toBe(resumed.armedAt);
  });

  it("catches an agent task up inside its window and records «Пропущено» outside it", async () => {
    const { svc, registry, slips } = make();
    // Every 4 hours: the window is half the period, 2 hours.
    at("2026-11-06T07:30:00Z");
    const task = await svc.create(draft({ kind: "agent", name: "Новини", prompt: "Збери новини", skills: [], schedule: { type: "hourly", every: 4, minute: 0 } }));

    // 08:00 missed by 2.5 h: past the window.
    at("2026-11-06T10:30:00Z");
    await svc.tick();
    expect(registry.listScheduleRuns(task.id)[0]).toMatchObject({ scheduledFor: "2026-11-06T08:00:00.000Z", status: "skipped", reason: "missed" });
    expect(slips().at(-1)).toMatchObject({ kind: "run", status: "skipped", reason: "missed", late: true });
    expect(spawns).toHaveLength(0);

    // 12:00 missed by 1.5 h: inside the window, run late.
    at("2026-11-06T13:30:00Z");
    await svc.tick();
    expect(registry.listScheduleRuns(task.id)[0]).toMatchObject({ scheduledFor: "2026-11-06T12:00:00.000Z", trigger: "catch-up", status: "running" });
    await vi.waitFor(() => expect(childIn(scheduleDir(task.id))).toBeDefined());
  });

  it("skips an occurrence that comes due while the previous run still goes", async () => {
    const { svc, registry, slips } = make();
    at("2026-11-06T07:30:00Z");
    const task = await svc.create(draft({ kind: "agent", name: "Новини", prompt: "Збери новини", skills: [], schedule: { type: "hourly", every: 1, minute: 0 } }));
    at("2026-11-06T08:00:10Z");
    await svc.tick();
    await vi.waitFor(() => expect(childIn(scheduleDir(task.id))).toBeDefined());
    expect(svc.list()[0]!.running).toBe(true);

    at("2026-11-06T09:00:10Z");
    await svc.tick();
    const [latest] = registry.listScheduleRuns(task.id);
    expect(latest).toMatchObject({ scheduledFor: "2026-11-06T09:00:00.000Z", status: "skipped", reason: "overlap" });
    expect(slips().at(-1)).toMatchObject({ status: "skipped", reason: "overlap" });
    expect(spawns).toHaveLength(1);
  });

  it("ticks on its own: once shortly after start, then every minute", async () => {
    // A second useFakeTimers on an installed clock keeps the first `toFake` list: reinstall.
    vi.useRealTimers();
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval", "setTimeout", "clearTimeout"] });
    const { svc, registry } = make();
    const tray = vi.fn();
    setScheduleTray(tray);
    at("2026-11-06T18:59:00Z");
    const task = await svc.create(draft());
    svc.onModuleInit();
    expect(tray).toHaveBeenLastCalledWith({ active: true, next: { name: "Вітаміни", at: "2026-11-06T19:00:00.000Z" } });
    await vi.advanceTimersByTimeAsync(SCHEDULE_START_DELAY_MS);
    expect(registry.listScheduleRuns(task.id)).toEqual([]);
    await vi.advanceTimersByTimeAsync(SCHEDULE_TICK_MS);
    expect(registry.listScheduleRuns(task.id)).toHaveLength(1);
    expect(tray).toHaveBeenLastCalledWith({ active: true, next: { name: "Вітаміни", at: "2026-11-07T19:00:00.000Z" } });
    svc.onModuleDestroy();
  });

  it("reads each task again before firing it, so a pause or delete during a slow fire holds", async () => {
    const { svc, registry, bindProject, assignedForNames } = make();
    bindProject("p1");
    at("2026-11-06T18:00:00Z");
    // First in the list: a project run whose skill check the test holds open.
    const slow = await svc.create(draft({ kind: "agent", name: "Звіт", prompt: "x", projectId: "p1", skills: ["weekly-report"] }));
    const paused = await svc.create(draft({ name: "Пауза" }));
    const gone = await svc.create(draft({ name: "Разове", schedule: { type: "once", at: "2026-11-06T19:00" } }));
    const gate = Promise.withResolvers<void>();
    assignedForNames.mockImplementationOnce(async () => {
      await gate.promise;
      return { block: "", view: [], missing: ["weekly-report"] };
    });
    at("2026-11-06T19:00:20Z");
    const tick = svc.tick();
    await vi.waitFor(() => expect(registry.listScheduleRuns(slow.id)).toHaveLength(1));
    await svc.update(paused.id, { enabled: false });
    svc.remove(gone.id);
    gate.resolve();
    await tick;
    expect(registry.listScheduleRuns(paused.id)).toEqual([]);
    expect(registry.getSchedule(gone.id)).toBeUndefined();
  });

  it("switches a fired «once» off without reverting an edit made meanwhile", async () => {
    const { svc, registry } = make();
    at("2026-11-06T18:00:00Z");
    const task = await svc.create(draft({ schedule: { type: "once", at: "2026-11-06T18:30" } }));
    at("2026-11-06T18:30:10Z");
    // The tick read the row; the operator renames it before the switch-off is written.
    const listed = registry.listSchedules();
    vi.spyOn(registry, "listSchedules").mockReturnValueOnce(listed);
    registry.putSchedule({ ...registry.getSchedule(task.id)!, name: "Перейменовано" });
    await svc.tick();
    expect(registry.getSchedule(task.id)).toMatchObject({ name: "Перейменовано", enabled: false });
  });

  it("refuses a «once» in the past, on create and on resume, and re-enables one moved to the future", async () => {
    const { svc, ctl } = make();
    const tray = vi.fn();
    setScheduleTray(tray);
    at("2026-11-06T18:00:00Z");
    await expect(svc.create(draft({ schedule: { type: "once", at: "2026-11-06T17:59" } }))).rejects.toMatchObject({ rejection: { code: "schedule_at_past", params: { value: "2026-11-06T17:59" } } });
    await expect(ctl.create(draft({ schedule: { type: "once", at: "2026-11-06T18:00" } }))).rejects.toBeInstanceOf(BadRequestException);

    const task = await svc.create(draft({ schedule: { type: "once", at: "2026-11-06T18:30" } }));
    expect(tray).toHaveBeenLastCalledWith({ active: true, next: { name: "Вітаміни", at: "2026-11-06T18:30:00.000Z" } });
    at("2026-11-06T18:30:10Z");
    await svc.tick();
    // Fired and off: nothing left to wait for, background mode ends.
    expect(tray).toHaveBeenLastCalledWith({ active: false });
    await expect(svc.update(task.id, { enabled: true })).rejects.toMatchObject({ rejection: { code: "schedule_at_past" } });
    // A rename of the fired task is no resume and is not refused.
    expect((await svc.update(task.id, { name: "Ще раз" })).enabled).toBe(false);
    const moved = await svc.update(task.id, { schedule: { type: "once", at: "2026-11-07T09:00" } });
    expect(moved).toMatchObject({ enabled: true, nextAt: "2026-11-07T09:00:00.000Z" });
  });
});

describe("reminder slips", () => {
  it("hide while snoozed and come back unseen when the snooze is up", async () => {
    const { svc, slips } = make();
    at("2026-11-06T18:00:00Z");
    await svc.create(draft());
    at("2026-11-06T19:00:05Z");
    await svc.tick();
    const [slip] = slips() as [ScheduleSlip];
    svc.markSeen([slip.id]);
    svc.snooze(slip.id, 10);
    expect(svc.slips()).toEqual([]);

    at("2026-11-06T19:05:00Z");
    await svc.tick();
    expect(slips()).toHaveLength(1);

    at("2026-11-06T19:10:30Z");
    await svc.tick();
    expect(slips()).toHaveLength(2);
    expect(slips()[1]).toMatchObject({ id: slip.id, seen: false, at: "2026-11-06T19:10:30.000Z" });
    expect(slips()[1]!.snoozedUntil).toBeUndefined();
    expect(svc.slips().map((s) => s.id)).toEqual([slip.id]);
  });

  it("deleting a task mid-run releases keep-awake and announces nothing when the run ends", async () => {
    const { svc, registry, slips } = make();
    const hold = vi.fn();
    setKeepAwake(hold);
    at("2026-11-06T08:00:00Z");
    const task = await svc.create(draft({ kind: "agent", name: "Новини", prompt: "Збери новини", skills: [] }));
    await svc.runNow(task.id);
    await vi.waitFor(() => expect(childIn(scheduleDir(task.id))?.prompts).toHaveLength(1));
    expect(hold).toHaveBeenLastCalledWith(true);
    const before = slips().length;
    svc.remove(task.id);
    expect(hold).toHaveBeenLastCalledWith(false);
    expect(registry.listRunningScheduleRuns()).toEqual([]);
    const child = childIn(scheduleDir(task.id))!;
    answer(child, "Новини");
    await vi.waitFor(() => expect(child.stopped).toBe(true));
    expect(slips()).toHaveLength(before);
    expect(hold).toHaveBeenLastCalledWith(false);
  });
});

describe("a project run", () => {
  const agentDraft = (over: Partial<ScheduleDraft> = {}) =>
    draft({ kind: "agent", name: "Звіт", prompt: "Згенеруй звіт про стан проєкту", projectId: "p1", skills: ["weekly-report"], ...over });

  it("files a hidden card, opens with the scheduled-run rules and skills, and retires its worktree when it ends", async () => {
    const { svc, registry, bindProject, worktree, slips } = make();
    const hold = vi.fn();
    setKeepAwake(hold);
    bindProject("p1");
    at("2026-11-06T18:00:00Z");
    const task = await svc.create(agentDraft());
    at("2026-11-06T19:00:20Z");
    await svc.tick();

    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({
      projectId: "p1",
      title: "Розклад · Звіт · 2026-11-06 19:00",
      description: "Згенеруй звіт про стан проєкту",
      assigneeId: USER,
      createdBy: USER,
      hidden: true,
      autoRun: false,
      worktree: true,
    });
    const session = registry.listSessions().find((s) => s.schedule?.id === task.id)!;
    expect(session).toMatchObject({ taskId: "card-1", schedule: { id: task.id, name: "Звіт" }, worktree: true });
    expect(session.deepAnalysis).toBeUndefined();
    const run = registry.listScheduleRuns(task.id)[0]!;
    expect(run).toMatchObject({ status: "running", sessionId: session.id });
    expect(hold).toHaveBeenLastCalledWith(true);

    const { child, opts } = spawns.find((s) => s.opts.cwd === session.worktreePath)!;
    const prompt = child.prompts[0]!;
    expect(prompt.startsWith(scheduledRunRules("Звіт", true))).toBe(true);
    expect(prompt).toContain("Never commit");
    expect(prompt).toContain(`${ASSIGNED_BLOCK_HEADER}\n\n### weekly-report`);
    expect(prompt).toContain("Згенеруй звіт про стан проєкту");
    expect(prompt).not.toMatch(/Co-Authored-By/);
    expect(readFileSync((opts.configPaths as string[]).at(-1)!, "utf8")).toBe(NO_ASK_OVERLAY);

    answer(child, "Усе зелене: 3 знахідки\n\nПодробиці нижче.");
    expect(registry.getScheduleRun(run.id)).toMatchObject({ status: "done", summary: "Усе зелене: 3 знахідки", sessionId: session.id });
    expect(slips().at(-1)).toMatchObject({ kind: "run", status: "done", text: "Усе зелене: 3 знахідки", sessionId: session.id, projectId: "p1", late: false });
    await vi.waitFor(() => expect(worktree.removeBranch).toHaveBeenCalledWith("/tmp/kmq-schedule-p1", session.branch));
    expect(worktree.removeWorktree).toHaveBeenCalledWith("/tmp/kmq-schedule-p1", session.worktreePath);
    await vi.waitFor(() => expect(registry.listSessions().find((s) => s.id === session.id)).toMatchObject({ status: "merged", worktreePath: "" }));
    expect(child.stopped).toBe(true);
    expect(hold).toHaveBeenLastCalledWith(false);
  });

  it("deletes the card when the launch fails", async () => {
    const { svc, registry, bindProject, slips } = make();
    bindProject("p1");
    at("2026-11-06T18:00:00Z");
    const task = await svc.create(agentDraft());
    at("2026-11-06T19:00:20Z");
    startFailure.next = "omp exploded";
    await svc.tick();
    expect(deleted).toEqual(["card-1"]);
    expect(registry.listScheduleRuns(task.id)[0]).toMatchObject({ status: "failed", reason: "launch_failed" });
    expect(registry.listSessions()).toEqual([]);
    expect(slips().at(-1)).toMatchObject({ status: "failed", reason: "launch_failed" });
  });

  it("fails without spending anything when signed out, unbound, or a skill is gone", async () => {
    const { svc, registry, bindProject, slips } = make();
    bindProject("p1");
    at("2026-11-06T18:00:00Z");
    const task = await svc.create(agentDraft());

    signedIn = false;
    let run = await svc.runNow(task.id);
    await vi.waitFor(() => expect(registry.getScheduleRun(run.id)).toMatchObject({ status: "failed", reason: "not_signed_in" }));

    signedIn = true;
    bindProject("p1", false);
    run = await svc.runNow(task.id);
    await vi.waitFor(() => expect(registry.getScheduleRun(run.id)).toMatchObject({ status: "failed", reason: "project_unbound" }));

    bindProject("p1");
    knownSkills = new Set();
    run = await svc.runNow(task.id);
    await vi.waitFor(() => expect(registry.getScheduleRun(run.id)).toMatchObject({ status: "failed", reason: "skill_missing", detail: "weekly-report" }));

    expect(created).toEqual([]);
    expect(spawns).toEqual([]);
    expect(slips().map((s) => s.reason)).toEqual(["not_signed_in", "project_unbound", "skill_missing"]);
  });

  it("fails at the time cap and is retired", async () => {
    vi.useRealTimers();
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    const { svc, registry, bindProject, worktree } = make();
    bindProject("p1");
    at("2026-11-06T18:00:00Z");
    const task = await svc.create(agentDraft({ skills: [] }));
    const run = await svc.runNow(task.id);
    await vi.waitFor(() => expect(registry.getScheduleRun(run.id)?.sessionId).toBeDefined());
    vi.advanceTimersByTime(MINION_TIME_CAP_MS);
    expect(registry.getScheduleRun(run.id)).toMatchObject({ status: "failed", reason: "timeout", trigger: "manual" });
    await vi.waitFor(() => expect(worktree.removeWorktree).toHaveBeenCalled());
  });
});

describe("a run without a project", () => {
  it("runs in its own folder with read-only tools and web search, and keeps the whole answer", async () => {
    const { svc, registry, slips } = make();
    at("2026-11-06T08:00:00Z");
    const task = await svc.create(draft({ kind: "agent", name: "Новини", prompt: "Збери новини про TypeScript", skills: ["weekly-report"] }));
    const run = await svc.runNow(task.id);
    await vi.waitFor(() => expect(childIn(scheduleDir(task.id))?.prompts).toHaveLength(1));
    const { child, opts } = spawns[0]!;
    expect(opts).toMatchObject({ cwd: scheduleDir(task.id), tools: ["read", "grep", "glob", "web_search"] });
    expect(opts.model).toBeUndefined();
    expect(readFileSync((opts.configPaths as string[]).at(-1)!, "utf8")).toBe(NO_ASK_OVERLAY);
    expect(child.prompts[0]!.startsWith(scheduledRunRules("Новини", false))).toBe(true);
    expect(child.prompts[0]).toContain("### weekly-report");
    expect(child.prompts[0]).toContain("Збери новини про TypeScript");

    answer(child, "TypeScript 6.1 вийшов\n\n- новина 1\n- новина 2");
    await vi.waitFor(() => expect(registry.getScheduleRun(run.id)).toMatchObject({ status: "done", summary: "TypeScript 6.1 вийшов" }));
    expect(slips().at(-1)).toMatchObject({ kind: "run", text: "TypeScript 6.1 вийшов", body: "TypeScript 6.1 вийшов\n\n- новина 1\n- новина 2" });
    expect(slips().at(-1)!.sessionId).toBeUndefined();
    // The child goes with its run, and no session row was made.
    await vi.waitFor(() => expect(child.stopped).toBe(true));
    expect(registry.listSessions()).toEqual([]);
  });

  it("refuses a skill that does not resolve before anything starts", async () => {
    const { svc, registry } = make();
    at("2026-11-06T08:00:00Z");
    const task = await svc.create(draft({ kind: "agent", name: "Новини", prompt: "Збери новини", skills: ["weekly-report"] }));
    knownSkills = new Set();
    const run = await svc.runNow(task.id);
    await vi.waitFor(() => expect(registry.getScheduleRun(run.id)).toMatchObject({ status: "failed", reason: "skill_missing" }));
    expect(spawns).toEqual([]);
  });
});

describe("SchedulesController", () => {
  async function refusal(run: () => unknown): Promise<{ code: string; message: string; params?: Record<string, unknown> }> {
    try {
      await run();
    } catch (e) {
      expect(e).toBeInstanceOf(BadRequestException);
      return (e as BadRequestException).getResponse() as { code: string; message: string };
    }
    throw new Error("expected the call to be refused");
  }

  it("refuses an invalid draft or patch with core's code", async () => {
    const { ctl } = make();
    at("2026-11-06T08:00:00Z");
    expect((await refusal(() => ctl.create({ ...draft(), schedule: { type: "daily", time: "25:00" } }))).code).toBe("schedule_time_invalid");
    expect((await refusal(() => ctl.create({ ...draft(), projectId: "p1" }))).code).toBe("schedule_agent_only");
    expect((await refusal(() => ctl.create({ ...draft(), timeZone: "Mars/Olympus" }))).code).toBe("schedule_timezone_invalid");
    const task = await ctl.create(draft());
    const r = await refusal(() => ctl.update(task.id, { skills: ["weekly-report"] }));
    expect(r).toMatchObject({ code: "schedule_agent_only", params: { field: "skills" } });
  });

  it("refuses an unknown project or skill, and a snooze of any other length", async () => {
    const { ctl } = make();
    at("2026-11-06T08:00:00Z");
    const agent = { ...draft(), kind: "agent" as const, prompt: "x" };
    expect(await refusal(() => ctl.create({ ...agent, projectId: "nope" }))).toMatchObject({ code: "schedule_project_unknown", params: { value: "nope" } });
    expect(await refusal(() => ctl.create({ ...agent, skills: ["no-such-skill"] }))).toMatchObject({ code: "schedule_skill_unknown", params: { value: "no-such-skill" } });
    expect(() => ctl.snooze("x", { minutes: 5 })).toThrow(BadRequestException);
  });

  it("answers 404 for an unknown task or slip", async () => {
    const { ctl } = make();
    await expect(ctl.update("nope", {})).rejects.toBeInstanceOf(NotFoundException);
    expect(() => ctl.remove("nope")).toThrow(NotFoundException);
    expect(() => ctl.runs("nope")).toThrow(NotFoundException);
    expect(() => ctl.snooze("nope", { minutes: 10 })).toThrow(NotFoundException);
  });

  it("deletes a task with its history", async () => {
    const { ctl, svc, registry } = make();
    at("2026-11-06T18:00:00Z");
    const task = await ctl.create(draft());
    at("2026-11-06T19:00:05Z");
    await svc.tick();
    expect(ctl.runs(task.id).runs).toHaveLength(1);
    expect(ctl.remove(task.id)).toEqual({ ok: true });
    expect(ctl.list().tasks).toEqual([]);
    expect(registry.listScheduleRuns(task.id)).toEqual([]);
  });
});
