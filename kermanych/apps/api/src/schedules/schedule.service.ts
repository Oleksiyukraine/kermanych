// apps/api/src/schedules/schedule.service.ts
// «Задачі за розкладом» on this machine (docs/specs/2026-11-06-scheduled-tasks.md): the tasks in
// the local registry (decision 1), the minute tick that fires them exactly once, and the two
// runners. A reminder writes a slip (decision 3). An agent task in a project files a hidden card
// and launches it through the supervisor as an analysis-only session, retired when its run ends
// (decisions 2, 5, 10); one without a project is a one-shot child on the chat pool (decision 9).
//
// The tick (decision 8, «Exactly once»): for every enabled task, the latest occurrence not yet
// claimed (core dueOccurrence) is claimed by inserting its run under UNIQUE (schedule_id,
// scheduled_for) — a second tick or a restart finds the row and does nothing. An agent task's
// occurrence past the catch-up window is recorded «Пропущено»; one that comes due while the
// task's previous run still goes is recorded skipped («Overlap»). A «once» task switches itself
// off after it fires; a changed schedule or a resumed task is re-armed from the moment of the
// change («Editing never fires the past»).
//
// Dependency direction: ScheduleService → { RegistryService, SupervisorService, AuthService,
// SkillsService }. The supervisor never knows this service: a project run's end comes back on
// its scheduleRunEnd$, and this service's events reach the socket through supervisor.publish,
// like MinionService's.
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Injectable, Optional, type OnModuleDestroy, type OnModuleInit } from "@nestjs/common";
import { claimTaskForLaunch, createTask, deleteTask } from "@kermanych/cloud";
import {
  dueOccurrence,
  formatZonedWall,
  MINION_TIME_CAP_MS,
  nextOccurrences,
  SCHEDULE_TICK_MS,
  type ManagementRejection,
  type ScheduleDraft,
  type ScheduleDue,
  type ScheduledTask,
  type SchedulePatch,
  type ScheduleRun,
  type ScheduleRunReason,
  type ScheduleRunStatus,
  type ScheduleSlip,
  type ScheduleSpec,
  type ScheduleTrayState,
} from "@kermanych/core";
import { RegistryService, type ScheduleRow } from "../registry/registry.service";
import { SupervisorService, type ScheduleRunEnd } from "../supervisor/supervisor.service";
import { AuthService } from "../auth/auth.service";
import { SkillsService, type AiScopeSet } from "../skills/skills.service";
import { MachineResourcesService } from "../machine/machine-resources.service";
import { RpcChatPool, readTurn } from "../assistant/rpc-chat-pool";
import { CodedError } from "../management/coded-error";
import { noAskOverlay } from "../minion/ask-overlay";
import { holdAwake } from "../minion/keep-awake";
import { scheduleTray } from "./schedule-tray";
import { firstLine, ONE_SHOT_TOOLS, scheduledRunPrompt } from "./schedule-prompt";

// The first tick waits for the api to listen: a project run launched before that gets no
// `kermanych` MCP server, and so no `report_finding` (MinionService waits a whole poll for the
// same reason). A few seconds cover the boot; the occurrence is still on time.
export const SCHEDULE_START_DELAY_MS = 5_000;

// A run without a project has no project to scope the skill library by. The skills resolver
// needs a project id that is a valid path segment; the nil UUID owns no rows, so only the user's
// own library and the Kermanych defaults resolve (decision 9: «user scope»).
const NO_PROJECT = "00000000-0000-0000-0000-000000000000";

// Every one-shot run of the machine queues on this key, so they run one at a time («Slots»).
const ONE_SHOT_QUEUE = "schedule:one-shot";

// The folder a one-shot run of task `id` works in (decision 9), under the same home the minion's
// overlay uses so a spec's override covers both.
export function scheduleDir(id: string): string {
  return join(process.env.KERMANYCH_SKILLS_HOME ?? join(homedir(), ".kermanych"), "schedules", id);
}

// A refusal of a request, carrying core's rejection: the controller answers it with a 400 whose
// body is `{ message, code, params }`.
export class ScheduleRefusal extends Error {
  constructor(readonly rejection: ManagementRejection) {
    super(rejection.text);
    this.name = "ScheduleRefusal";
  }
}

export class ScheduleNotFound extends Error {
  constructor(what: "schedule" | "slip") {
    super(`${what} not found`);
    this.name = "ScheduleNotFound";
  }
}

// A «once» whose time is at or before `now` would never fire, yet keep the app in background mode
// as an enabled task: refused on create, reschedule and resume.
function pastOnce(spec: ScheduleSpec, timeZone: string, now: string): ScheduleRefusal | undefined {
  if (spec.type !== "once" || nextOccurrences(spec, timeZone, new Date(now), 1).length) return undefined;
  return new ScheduleRefusal({ text: `час ${spec.at.replace("T", " ")} уже минув`, code: "schedule_at_past", params: { value: spec.at } });
}

// The slip's sentence for a run that was skipped or failed; the UI localizes by `reason` and
// falls back to this text.
function reasonText(reason: ScheduleRunReason, detail?: string): string {
  switch (reason) {
    case "overlap":
      return "Пропущено: попередній запуск ще триває";
    case "missed":
      return "Пропущено: Керманич не працював у цей час";
    case "not_signed_in":
      return "Не виконано: ви не ввійшли в Керманич";
    case "project_unbound":
      return "Не виконано: проєкт не привʼязано на цій машині";
    case "project_missing":
      return "Не виконано: проєкту більше немає";
    case "skill_missing":
      return `Не виконано: не знайдено навичок${detail ? `: ${detail}` : ""}`;
    case "launch_failed":
      return `Не вдалося запустити агента${detail ? `: ${detail}` : ""}`;
    case "run_failed":
      return `Запуск завершився з помилкою${detail ? `: ${detail}` : ""}`;
    case "timeout":
      return "Не виконано: вичерпано час на запуск";
  }
}

@Injectable()
export class ScheduleService implements OnModuleInit, OnModuleDestroy {
  private timer?: NodeJS.Timeout;
  private startTimer?: NodeJS.Timeout;
  // Single flight, like MinionService.poll: a tick in progress absorbs every kick into one more.
  private ticking?: Promise<void>;
  private again = false;
  private destroyed = false;
  // The tray state last told to the desktop app; it hears changes only.
  private lastTray?: string;
  private pool: RpcChatPool;

  constructor(
    private registry: RegistryService,
    private supervisor: SupervisorService,
    private auth: AuthService,
    private skills: SkillsService,
    // Optional for specs, like the chats': the renice of a one-shot child.
    @Optional() resources?: MachineResourcesService,
  ) {
    this.pool = new RpcChatPool({
      label: "schedule run",
      // A one-shot run gets «Посіпака»'s time cap as its turn budget («Unattended»).
      turnTimeoutMs: MINION_TIME_CAP_MS,
      registry,
      ...(resources ? { resources } : {}),
    });
    this.supervisor.scheduleRunEnd$.subscribe((e) => void this.onProjectRunEnd(e));
  }

  onModuleInit(): void {
    this.recoverInterrupted();
    this.timer = setInterval(() => this.kick(), SCHEDULE_TICK_MS);
    this.timer.unref();
    this.startTimer = setTimeout(() => this.kick(), SCHEDULE_START_DELAY_MS);
    this.startTimer.unref();
    this.tray();
  }

  async onModuleDestroy(): Promise<void> {
    this.destroyed = true;
    clearInterval(this.timer);
    clearTimeout(this.startTimer);
    await this.pool.dropAll();
  }

  // ── Reads ──────────────────────────────────────────────────────────────────────────────────

  list(): ScheduledTask[] {
    const now = new Date();
    const running = new Set(this.registry.listRunningScheduleRuns().map((r) => r.scheduleId));
    return this.registry.listSchedules().map((t) => this.view(t, now, running));
  }

  // `nextAt` on every read: the next occurrence after now that may still fire — so never one at
  // or before the arming.
  private view(t: ScheduleRow, now: Date, running: Set<string>): ScheduledTask {
    const after = new Date(Math.max(now.getTime(), Date.parse(t.armedAt)));
    const next = t.enabled ? nextOccurrences(t.schedule, t.timeZone, after, 1)[0] : undefined;
    return { ...t, ...(next ? { nextAt: next.toISOString() } : {}), running: running.has(t.id) };
  }

  private viewOf(id: string): ScheduledTask {
    const t = this.list().find((x) => x.id === id);
    if (!t) throw new ScheduleNotFound("schedule");
    return t;
  }

  runs(id: string): ScheduleRun[] {
    if (!this.registry.getSchedule(id)) throw new ScheduleNotFound("schedule");
    return this.registry.listScheduleRuns(id);
  }

  // Newest first; a slip snoozed into the future is hidden until the tick fires it again.
  slips(): ScheduleSlip[] {
    const now = new Date().toISOString();
    return this.registry.listScheduleSlips().filter((s) => !s.snoozedUntil || s.snoozedUntil <= now);
  }

  // ── Writes ─────────────────────────────────────────────────────────────────────────────────

  async create(draft: ScheduleDraft): Promise<ScheduledTask> {
    const skills = draft.kind === "agent" ? (draft.skills ?? []) : [];
    const now = new Date().toISOString();
    const past = pastOnce(draft.schedule, draft.timeZone, now);
    if (past) throw past;
    await this.checkRefs(draft.projectId, skills);
    const row: ScheduleRow = {
      id: randomUUID(),
      name: draft.name,
      kind: draft.kind,
      prompt: draft.prompt,
      ...(draft.projectId ? { projectId: draft.projectId } : {}),
      skills,
      ...(draft.model ? { model: draft.model } : {}),
      schedule: draft.schedule,
      timeZone: draft.timeZone,
      enabled: true,
      armedAt: now,
      createdAt: now,
      updatedAt: now,
    };
    this.registry.putSchedule(row);
    this.changed();
    return this.viewOf(row.id);
  }

  async update(id: string, patch: SchedulePatch): Promise<ScheduledTask> {
    const cur = this.registry.getSchedule(id);
    if (!cur) throw new ScheduleNotFound("schedule");
    const projectId = patch.projectId === undefined ? cur.projectId : (patch.projectId ?? undefined);
    const skills = patch.skills ?? cur.skills;
    if (patch.projectId !== undefined || patch.skills !== undefined) await this.checkRefs(projectId, skills);
    const now = new Date().toISOString();
    const model = patch.model === undefined ? cur.model : (patch.model ?? undefined);
    const schedule = patch.schedule ?? cur.schedule;
    const rescheduled = patch.schedule !== undefined && JSON.stringify(patch.schedule) !== JSON.stringify(cur.schedule);
    // A «once» that fired (and so switched itself off), moved to a new time, is armed again.
    const enabled = patch.enabled ?? (rescheduled && schedule.type === "once" ? true : cur.enabled);
    // «Editing never fires the past»: a new schedule, or a task switched back on, counts from now —
    // and a «once» whose time has gone would then never fire, so it is refused, not stored on.
    const armed = rescheduled || (enabled && !cur.enabled);
    if (armed && enabled) {
      const past = pastOnce(schedule, cur.timeZone, now);
      if (past) throw past;
    }
    const next: ScheduleRow = {
      ...cur,
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.prompt !== undefined ? { prompt: patch.prompt } : {}),
      projectId,
      skills,
      model,
      schedule,
      enabled,
      updatedAt: now,
    };
    if (armed) next.armedAt = now;
    this.registry.putSchedule(next);
    this.changed();
    return this.viewOf(id);
  }

  // The task and its run history (decision 7), a run in flight included: its row goes, so nothing
  // stays `running` — and keep-awake held — for a task that is gone. Its child goes on; its end
  // finds no row to record and writes nothing.
  remove(id: string): void {
    if (!this.registry.getSchedule(id)) throw new ScheduleNotFound("schedule");
    this.registry.deleteSchedule(id);
    this.awake();
    this.changed();
  }

  // «Запустити зараз»: a run with no `scheduled_for`, whatever the schedule and the switch say. A
  // run already in flight makes this one a skipped overlap, recorded but not announced: the
  // operator who pressed the button sees the answer.
  async runNow(id: string): Promise<ScheduleRun> {
    const t = this.registry.getSchedule(id);
    if (!t) throw new ScheduleNotFound("schedule");
    const at = new Date().toISOString();
    if (t.kind === "agent" && this.isRunning(t.id)) {
      const skipped: ScheduleRun = { id: randomUUID(), scheduleId: t.id, trigger: "manual", status: "skipped", reason: "overlap", startedAt: at, endedAt: at };
      this.registry.claimScheduleRun(skipped);
      this.runChanged(skipped);
      return skipped;
    }
    const run: ScheduleRun = { id: randomUUID(), scheduleId: t.id, trigger: "manual", status: "running", startedAt: at };
    this.registry.claimScheduleRun(run);
    this.runChanged(run);
    void this.execute(t, run, false).catch((err: unknown) => console.warn(`[schedules] run of «${t.name}» failed: ${(err as Error).message}`));
    return run;
  }

  markSeen(ids?: readonly string[]): void {
    this.registry.markScheduleSlipsSeen(ids);
  }

  // «Відкласти»: the slip hides until then and the tick fires it again; the schedule stays.
  snooze(id: string, minutes: number): void {
    if (!this.registry.getScheduleSlip(id)) throw new ScheduleNotFound("slip");
    this.registry.snoozeScheduleSlip(id, new Date(Date.now() + minutes * 60_000).toISOString());
  }

  // A project must be known here; every skill must resolve — in the project's checkout, so a
  // repository skill counts, or in the user's library for a task without a project.
  private async checkRefs(projectId: string | undefined, skills: readonly string[]): Promise<void> {
    const project = projectId ? this.registry.listProjects().find((p) => p.id === projectId) : undefined;
    if (projectId && !project)
      throw new ScheduleRefusal({ text: `проєкту ${projectId} немає на цій машині`, code: "schedule_project_unknown", params: { value: projectId } });
    if (!skills.length) return;
    const { missing } = await this.skills.assignedForNames(this.scope(project?.id, project?.workspaceId), skills, project?.localRepoPath ?? "");
    if (missing.length)
      throw new ScheduleRefusal({ text: `невідомі навички: ${missing.join(", ")}`, code: "schedule_skill_unknown", params: { value: missing.join(", ") } });
  }

  private scope(projectId: string | undefined, workspaceId: string | undefined): AiScopeSet {
    const userId = this.auth.current()?.userId;
    return { projectId: projectId ?? NO_PROJECT, ...(workspaceId ? { workspaceId } : {}), ...(userId ? { userId } : {}) };
  }

  // ── The tick ───────────────────────────────────────────────────────────────────────────────

  kick(): void {
    void this.tick();
  }

  tick(): Promise<void> {
    if (this.ticking) {
      this.again = true;
      return this.ticking;
    }
    this.ticking = (async () => {
      try {
        do {
          this.again = false;
          await this.tickOnce().catch((err: unknown) => console.warn(`[schedules] tick failed: ${(err as Error).message}`));
        } while (this.again && !this.destroyed);
      } finally {
        this.ticking = undefined;
      }
    })();
    return this.ticking;
  }

  private async tickOnce(): Promise<void> {
    if (this.destroyed) return;
    const now = new Date();
    // Snoozed slips whose time came: the same slip again, new and unseen.
    for (const due of this.registry.dueSnoozedScheduleSlips(now.toISOString())) {
      const slip = this.registry.refireScheduleSlip(due.id, now.toISOString());
      if (slip) this.supervisor.publish({ type: "schedule_slip", slip });
    }
    // Each task is read again right before it is weighed: a fire awaits a launch, and meanwhile
    // the operator may have paused, edited or deleted a task further down the list.
    for (const { id } of this.registry.listSchedules()) {
      const t = this.registry.getSchedule(id);
      if (!t?.enabled) continue;
      const at = new Date();
      const last = this.registry.lastScheduledFor(t.id);
      const due = dueOccurrence(t, last ? new Date(last) : undefined, at);
      if (due) await this.fire(t, due, at);
    }
    // The next firing moves with the clock even when nothing fired.
    this.tray();
  }

  private async fire(t: ScheduleRow, due: ScheduleDue, now: Date): Promise<void> {
    const at = now.toISOString();
    const base = { scheduleId: t.id, scheduledFor: due.at.toISOString(), trigger: due.late ? "catch-up" : "schedule", startedAt: at } as const;
    // Past the catch-up window (agent tasks only): recorded, announced, offered «Запустити зараз».
    if (due.fire === "missed") return this.skip(t, { id: randomUUID(), ...base, status: "skipped", reason: "missed", endedAt: at });
    if (t.kind === "agent" && this.isRunning(t.id)) return this.skip(t, { id: randomUUID(), ...base, status: "skipped", reason: "overlap", endedAt: at });
    const run: ScheduleRun = { id: randomUUID(), ...base, status: "running" };
    if (!this.registry.claimScheduleRun(run)) return;
    this.switchOffOnce(t);
    this.runChanged(run);
    await this.execute(t, run, due.late);
  }

  private skip(t: ScheduleRow, run: ScheduleRun): void {
    if (!this.registry.claimScheduleRun(run)) return;
    this.switchOffOnce(t);
    this.runChanged(run);
    this.slip(t, run, { text: reasonText(run.reason!), late: true });
  }

  // A «once» task has fired (or been skipped) for good. Only the switch is written: the row may
  // have been edited or deleted since the tick read it.
  private switchOffOnce(t: ScheduleRow): void {
    if (t.schedule.type !== "once") return;
    this.registry.disableSchedule(t.id, new Date().toISOString());
    this.changed();
  }

  private isRunning(scheduleId: string): boolean {
    return this.registry.listRunningScheduleRuns().some((r) => r.scheduleId === scheduleId);
  }

  // The run claimed as `running`: a reminder lands at once; an agent run starts (a project run
  // is awaited up to its launch, a one-shot run only up to its place in the queue).
  private async execute(t: ScheduleRow, run: ScheduleRun, late: boolean): Promise<void> {
    if (t.kind === "reminder") {
      if (this.finish(run, { status: "done" })) this.slip(t, run, { text: t.prompt, late });
      return;
    }
    if (t.projectId) await this.runProject(t, run, late);
    else void this.pool.enqueue(ONE_SHOT_QUEUE, () => this.oneShot(t, run, late));
  }

  // ── A run in a project (decisions 2, 5, 10) ────────────────────────────────────────────────

  // Preconditions first, nothing spent on a failing one: signed in, the project known and bound
  // here, every skill resolving in its checkout. Then the hidden card, claimed like a ▶ and
  // launched; a launch that throws deletes the card, so a failing daily task fills no backlog.
  private async runProject(t: ScheduleRow, run: ScheduleRun, late: boolean): Promise<void> {
    const user = this.auth.current();
    if (!user) return this.fail(t, run, late, "not_signed_in");
    const project = this.registry.listProjects().find((p) => p.id === t.projectId);
    if (!project) return this.fail(t, run, late, "project_missing");
    if (!project.localRepoPath) return this.fail(t, run, late, "project_unbound");
    if (t.skills.length) {
      const { missing } = await this.skills.assignedForNames({ projectId: project.id, ...(project.workspaceId ? { workspaceId: project.workspaceId } : {}), userId: user.userId }, t.skills, project.localRepoPath);
      if (missing.length) return this.fail(t, run, late, "skill_missing", missing.join(", "));
    }
    const client = this.auth.cloudClient();
    let cardId: string | undefined;
    try {
      const model = t.model ?? project.defaultModel;
      const card = await createTask(client, {
        projectId: project.id,
        title: `Розклад · ${t.name} · ${formatZonedWall(new Date(run.scheduledFor ?? run.startedAt), t.timeZone).replace("T", " ")}`,
        description: t.prompt,
        assigneeId: user.userId,
        createdBy: user.userId,
        hidden: true,
        autoRun: false,
        worktree: true,
        prefix: "chore",
        // A typed slug: the branch is named without a model call, and the supervisor still
        // de-duplicates it.
        branchSlug: `schedule-${t.id.slice(0, 8)}`,
        ...(model ? { model } : {}),
        ...(project.defaultEffort ? { effort: project.defaultEffort } : {}),
      });
      cardId = card.id;
      const won = await claimTaskForLaunch(client, card.id, user.userId, card.status);
      if (!won) throw new Error("the card could not be claimed");
      const session = await this.supervisor.launchScheduled(won, user.userId, { id: t.id, name: t.name });
      // The run may have ended already (its end finds the run by task); the patch keeps its status.
      const updated = this.registry.updateScheduleRun(run.id, { sessionId: session.id });
      if (updated) this.supervisor.publish({ type: "schedule_run_update", run: updated });
    } catch (err) {
      const message = (err as Error).message;
      console.warn(`[schedules] launch of «${t.name}» failed: ${message}`);
      if (cardId) await deleteTask(client, cardId).catch((e: unknown) => console.warn(`[schedules] could not delete card ${cardId}: ${(e as Error).message}`));
      this.fail(t, run, late, "launch_failed", message);
    }
  }

  // The supervisor saw the run end. Recorded, announced, and — unless the operator stopped,
  // finished or deleted the session himself — retired (decision 10).
  private async onProjectRunEnd(e: ScheduleRunEnd): Promise<void> {
    if (this.destroyed) return;
    const running = this.registry.listRunningScheduleRuns();
    const run = running.find((r) => r.sessionId === e.sessionId) ?? running.find((r) => r.scheduleId === e.scheduleId && !r.sessionId);
    const t = this.registry.getSchedule(e.scheduleId);
    if (run && t) {
      const late = run.trigger === "catch-up";
      const projectId = this.registry.listSessions().find((s) => s.id === e.sessionId)?.projectId ?? t.projectId;
      const extra = { sessionId: e.sessionId, ...(projectId ? { projectId } : {}) };
      if (e.outcome === "done") {
        const summary = firstLine(e.answer ?? "");
        if (this.finish(run, { status: "done", summary, sessionId: e.sessionId }))
          this.slip(t, { ...run, status: "done" }, { text: summary || `«${t.name}» виконано`, late, ...extra });
      } else {
        const reason: ScheduleRunReason = e.outcome === "timeout" ? "timeout" : "run_failed";
        if (this.finish(run, { status: "failed", reason, sessionId: e.sessionId, ...(e.detail ? { detail: e.detail } : {}) }))
          this.slip(t, { ...run, status: "failed", reason }, { text: reasonText(reason, e.detail), late, ...extra });
      }
    }
    if (!e.byOperator) await this.supervisor.retireScheduledRun(e.sessionId).catch((err: unknown) => console.warn(`[schedules] retiring ${e.sessionId}: ${(err as Error).message}`));
  }

  // ── A run without a project (decision 9) ───────────────────────────────────────────────────

  // One child in the task's own folder with read-only file tools, web search and page reading,
  // no ask tool, the user's backend default or the pinned model. The whole answer is the slip's
  // body; its first line is the summary. The child goes with the run: the next one starts clean.
  private async oneShot(t: ScheduleRow, run: ScheduleRun, late: boolean): Promise<void> {
    if (this.destroyed) return;
    const startedAt = Date.now();
    const cwd = scheduleDir(t.id);
    const key = `schedule:${t.id}`;
    try {
      await mkdir(cwd, { recursive: true });
      let block = "";
      if (t.skills.length) {
        const resolved = await this.skills.assignedForNames(this.scope(undefined, undefined), t.skills, cwd);
        if (resolved.missing.length) return this.fail(t, run, late, "skill_missing", resolved.missing.join(", "));
        block = resolved.block;
      }
      const noAsk = await noAskOverlay();
      const live = await this.pool.child(key, () => ({
        opts: { cwd, tools: [...ONE_SHOT_TOOLS], ...(t.model ? { model: t.model } : {}), ...(noAsk ? { configPaths: [noAsk] } : {}) },
      }));
      const { events, notices } = await this.pool.drive(key, live, scheduledRunPrompt({ name: t.name, prompt: t.prompt, skillsBlock: block, project: false }), []);
      const body = readTurn(events, notices, startedAt).raw.trim();
      const summary = firstLine(body);
      if (this.finish(run, { status: "done", summary }))
        this.slip(t, { ...run, status: "done" }, { text: summary || `«${t.name}» виконано`, late, ...(body ? { body } : {}) });
    } catch (err) {
      const timeout = err instanceof CodedError && err.code === "assistant_no_reply_timeout";
      this.fail(t, run, late, timeout ? "timeout" : "run_failed", (err as Error).message);
    } finally {
      await this.pool.reset(key).catch(() => {});
    }
  }

  // ── Records ────────────────────────────────────────────────────────────────────────────────

  private fail(t: ScheduleRow, run: ScheduleRun, late: boolean, reason: ScheduleRunReason, detail?: string): void {
    if (this.finish(run, { status: "failed", reason, ...(detail ? { detail } : {}) }))
      this.slip(t, { ...run, status: "failed", reason }, { text: reasonText(reason, detail), late });
  }

  // `false` when the run's row is gone — its task was deleted meanwhile — and nothing is announced.
  private finish(run: ScheduleRun, patch: { status: ScheduleRunStatus; reason?: ScheduleRunReason; detail?: string; summary?: string; sessionId?: string }): boolean {
    const done = this.registry.updateScheduleRun(run.id, { ...patch, endedAt: new Date().toISOString() });
    if (done) this.runChanged(done);
    return done !== undefined;
  }

  private slip(t: ScheduleRow, run: ScheduleRun, s: { text: string; late: boolean; body?: string; sessionId?: string; projectId?: string }): void {
    const slip: ScheduleSlip = {
      id: randomUUID(),
      kind: t.kind === "reminder" ? "reminder" : "run",
      scheduleId: t.id,
      scheduleName: t.name,
      at: new Date().toISOString(),
      ...(run.scheduledFor ? { scheduledFor: run.scheduledFor } : {}),
      text: s.text,
      ...(s.body ? { body: s.body } : {}),
      ...(t.kind === "agent" ? { runId: run.id, status: run.status, ...(run.reason ? { reason: run.reason } : {}) } : {}),
      ...(s.sessionId ? { sessionId: s.sessionId } : {}),
      ...(s.projectId ? { projectId: s.projectId } : {}),
      late: s.late,
      seen: false,
    };
    this.registry.putScheduleSlip(slip);
    this.supervisor.publish({ type: "schedule_slip", slip });
  }

  // A run row moved: the history hears it, the list's `running` flags follow, and keep-awake.
  private runChanged(run: ScheduleRun): void {
    this.supervisor.publish({ type: "schedule_run_update", run });
    this.awake();
    this.changed();
  }

  // Keep-awake holds while any agent run is in flight (a reminder's row is never running for
  // longer than its own write).
  private awake(): void {
    holdAwake("schedule", this.registry.listRunningScheduleRuns().length > 0);
  }

  private changed(): void {
    this.supervisor.publish({ type: "schedules_update", tasks: this.list() });
    this.tray();
  }

  // The desktop app hears whether any task is enabled and the next firing, on change only.
  private tray(): void {
    const enabled = this.list().filter((t) => t.enabled);
    const next = enabled.filter((t) => t.nextAt).sort((a, b) => a.nextAt!.localeCompare(b.nextAt!))[0];
    // Background mode lasts while something can still happen: an enabled task with a firing
    // ahead, or one whose run is going.
    const active = enabled.some((t) => t.nextAt !== undefined || t.running);
    const state: ScheduleTrayState = { active, ...(next ? { next: { name: next.name, at: next.nextAt! } } : {}) };
    const key = JSON.stringify(state);
    if (key === this.lastTray) return;
    this.lastTray = key;
    scheduleTray()?.(state);
  }

  // Runs left `running` by a previous process: their child died with it. Each is failed and
  // announced, and a project run's session is retired like any ended run.
  private recoverInterrupted(): void {
    for (const run of this.registry.listRunningScheduleRuns()) {
      const t = this.registry.getSchedule(run.scheduleId);
      const detail = "Kermanych was restarted during the run";
      if (t) this.fail(t, run, run.trigger === "catch-up", "run_failed", detail);
      else this.registry.updateScheduleRun(run.id, { status: "failed", reason: "run_failed", detail, endedAt: new Date().toISOString() });
      if (run.sessionId) void this.supervisor.retireScheduledRun(run.sessionId).catch(() => {});
    }
    holdAwake("schedule", false);
  }
}
