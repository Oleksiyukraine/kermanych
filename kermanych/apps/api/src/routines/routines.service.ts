// apps/api/src/routines/routines.service.ts
// The routine runner (docs/specs/2026-10-16-routines.md): the scheduled tasks of every workspace
// the signed-in member belongs to, fired by THIS api while Kermanych is open — the model of
// Claude Desktop's local scheduled tasks, with the definitions in the team's cloud.
//
// Whose routines: only the signed-in member's own (`created_by`). A routine acts in its author's
// name — their JWT, their Slack token, their checkouts and plan — so no other member's machine
// may run it.
//
// When: every minute, and shortly after sign-in. A routine is due when its latest occurrence is
// newer than `armed_at` and inside the catch-up window (core `dueOccurrence`); only that latest
// occurrence runs, so a week offline is one catch-up, not seven.
//
// Exactly once: the run row is inserted first, and `(routine_id, scheduled_for)` is unique. A
// second machine of the same author, or this api after a restart, gets a unique violation and
// drops the occurrence (`claimRoutineRun` → undefined).
//
// One at a time: runs go through one queue — the Slack bot's idiom — so scheduled work never
// spends the plan on parallel children, and an occurrence that comes due while the same routine
// is still running is recorded as skipped.
import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from "@nestjs/common";
import { Observable, Subject } from "rxjs";
import {
  claimRoutineRun,
  createTask,
  createWorkspaceReleaseNote,
  deleteTask,
  finishRoutineRun,
  getWorkspaceRoutine,
  listProjects,
  listRunnableRoutines,
  listWorkspaces,
  patchWorkspaceRoutine,
} from "@kermanych/cloud";
import type { WorkspaceRoutine, WorkspaceRoutineRun, WorkspaceRoutineRunClaim, WorkspaceRoutineRunResult } from "@kermanych/cloud";
import { dueOccurrence, releaseRangeFor, routineLocalDate, ROUTINE_CATCH_UP_MS, type RoutineAction, type RoutineRunStatus, type ServerEvent } from "@kermanych/core";
import { AuthService } from "../auth/auth.service";
import { RegistryService } from "../registry/registry.service";
import { ReleaseNotesService, type ScheduledReleaseNotes } from "../management/release-notes.service";
import { MANAGEMENT_TOOLS } from "../management/management-chat.service";
import { managementCwd, managementRepos } from "../management/management-prompt";
import { CodedError } from "../management/coded-error";
import { SlackReleaseNotesService } from "../slack/slack-release-notes.service";
import { SupervisorService } from "../supervisor/supervisor.service";
import { runOneShot } from "../runtime/one-shot";
import { resolveRuntime } from "../runtime/resolve-runtime";
import { buildRoutineReportPrompt } from "./routine-report-prompt";

const TICK_MS = 60_000;
// After sign-in the token handoff settles first; a catch-up a few seconds later is soon enough.
const AFTER_SIGN_IN_MS = 10_000;

@Injectable()
export class RoutinesService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(RoutinesService.name);
  private events = new Subject<ServerEvent>();
  events$: Observable<ServerEvent> = this.events.asObservable();

  private timer: NodeJS.Timeout | undefined;
  private kick: NodeJS.Timeout | undefined;
  private ticking = false;
  // Occurrences this process has settled — claimed, found claimed or skipped — keyed
  // `${routineId}@${ms}`, so the minute after an occurrence does not try to claim it again.
  // Pruned past the catch-up window, after which `dueOccurrence` stops offering them anyway.
  private settled = new Map<string, number>();
  // Routines with a run queued or running on this machine.
  private busy = new Set<string>();
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private auth: AuthService,
    private registry: RegistryService,
    private releaseNotes: ReleaseNotesService,
    private slack: SlackReleaseNotesService,
    private supervisor: SupervisorService,
  ) {}

  onModuleInit(): void {
    // A preview api has no cloud, and a scheduler there would fire nothing but warnings.
    if (process.env.KERMANYCH_PREVIEW === "1") return;
    this.timer = setInterval(() => void this.tick(), TICK_MS);
    this.timer.unref();
    this.auth.onToken(() => this.soon());
    if (this.auth.current()) this.soon();
  }

  onModuleDestroy(): void {
    clearInterval(this.timer);
    clearTimeout(this.kick);
  }

  private soon(): void {
    clearTimeout(this.kick);
    this.kick = setTimeout(() => void this.tick(), AFTER_SIGN_IN_MS);
    this.kick.unref();
  }

  // The signed-in member, when their token can still reach the cloud.
  private member(now: number): string | undefined {
    const s = this.auth.current();
    if (!s) return undefined;
    if (s.expiresAt && Date.parse(s.expiresAt) <= now) return undefined;
    return s.userId;
  }

  // One pass over the member's routines. Public for the tests, which drive time explicitly.
  async tick(now = Date.now()): Promise<void> {
    const userId = this.member(now);
    if (!userId || this.ticking) return;
    this.ticking = true;
    try {
      for (const [key, at] of this.settled) if (now - at > ROUTINE_CATCH_UP_MS) this.settled.delete(key);
      const routines = await listRunnableRoutines(this.auth.cloudClient(), userId);
      for (const routine of routines) {
        const due = dueOccurrence(routine.schedule, routine.timezone, Date.parse(routine.armedAt), now);
        if (!due) continue;
        const key = `${routine.id}@${due.at}`;
        if (this.settled.has(key)) continue;
        try {
          await this.fire(routine, userId, { trigger: due.trigger, scheduledFor: new Date(due.at).toISOString() }, due.at);
          this.settled.set(key, due.at);
        } catch (err) {
          // Unsettled on purpose: a claim the cloud did not answer is retried on the next tick.
          this.log.warn(`routine «${routine.name}»: could not claim its run — ${(err as Error).message}`);
        }
      }
    } catch (err) {
      this.log.warn(`routines: could not read the schedule — ${(err as Error).message}`);
    } finally {
      this.ticking = false;
    }
  }

  // «Run now» — the author's button. The run is claimed before the answer, so the screen can
  // show it at once; the work itself goes through the same queue as every scheduled run.
  async runNow(routineId: string, userId: string): Promise<WorkspaceRoutineRun> {
    const routine = await getWorkspaceRoutine(this.auth.cloudClient(), routineId);
    if (!routine) throw new Error("routine not found");
    if (routine.createdBy !== userId) throw new Error("only the author of a routine can run it — it runs in their name");
    if (this.busy.has(routine.id)) throw new Error("this routine is already running");
    const run = await this.fire(routine, userId, { trigger: "manual" }, Date.now());
    if (!run) throw new Error("the run could not be started");
    return run;
  }

  // Claim a run and queue it. `undefined` when the occurrence was already claimed (elsewhere or
  // before a restart) or was recorded as skipped; throws when the cloud refused the claim.
  private async fire(
    routine: WorkspaceRoutine,
    userId: string,
    claim: Omit<WorkspaceRoutineRunClaim, "routineId">,
    at: number,
  ): Promise<WorkspaceRoutineRun | undefined> {
    const cloud = this.auth.cloudClient();
    if (this.busy.has(routine.id)) {
      await claimRoutineRun(cloud, {
        ...claim,
        routineId: routine.id,
        status: "skipped",
        errorCode: "routine_previous_running",
        errorMessage: "the previous run of this routine was still running",
      });
      return undefined;
    }
    const run = await claimRoutineRun(cloud, { ...claim, routineId: routine.id });
    if (!run) return undefined;
    // A one-off schedule has fired: it switches itself off, the way a Claude one-off routine
    // turns into «Ran». Not fatal — the occurrence is claimed, so it cannot run twice anyway.
    if (routine.schedule.kind === "once" && claim.trigger !== "manual")
      await patchWorkspaceRoutine(cloud, routine.id, { enabled: false }).catch((err: unknown) =>
        this.log.warn(`routine «${routine.name}»: could not switch the one-off schedule off — ${(err as Error).message}`),
      );

    this.busy.add(routine.id);
    this.emit(routine, run.id, "running");
    const date = routineLocalDate(at, routine.timezone);
    this.queue = this.queue.then(() => this.execute(routine, run, userId, date));
    return run;
  }

  // Never throws: whatever happens is the run's outcome, written to its row.
  private async execute(routine: WorkspaceRoutine, run: WorkspaceRoutineRun, userId: string, date: string): Promise<void> {
    let outcome: WorkspaceRoutineRunResult;
    try {
      outcome = await this.perform(routine, userId, date);
    } catch (err) {
      outcome =
        err instanceof CodedError
          ? { status: "failed", errorCode: err.code, errorMessage: err.message, ...(err.params ? { errorParams: err.params } : {}) }
          : { status: "failed", errorMessage: (err as Error).message };
    }
    try {
      await finishRoutineRun(this.auth.cloudClient(), run.id, outcome);
    } catch (err) {
      this.log.warn(`routine «${routine.name}»: could not record the run's outcome — ${(err as Error).message}`);
    }
    this.busy.delete(routine.id);
    this.emit(routine, run.id, outcome.status);
  }

  private perform(routine: WorkspaceRoutine, userId: string, date: string): Promise<WorkspaceRoutineRunResult> {
    if (routine.action.kind === "release_notes") return this.writeReleaseNotes(routine, routine.action, userId, date);
    return routine.projectId
      ? this.launchAgent(routine, routine.projectId, routine.action.prompt, routine.action.hideFromBoard === true, userId, date)
      : this.writeReport(routine, routine.action.prompt, userId, date);
  }

  // ── release notes ───────────────────────────────────────────────────────────

  private async writeReleaseNotes(
    routine: WorkspaceRoutine,
    action: Extract<RoutineAction, { kind: "release_notes" }>,
    userId: string,
    date: string,
  ): Promise<WorkspaceRoutineRunResult> {
    const { rangeFrom, rangeTo } = releaseRangeFor(date, action.periodDays);
    let written: ScheduledReleaseNotes;
    try {
      written = await this.releaseNotes.generateScheduled({
        sources: action.sources,
        workspaceName: await this.workspaceName(routine.workspaceId),
        rangeFrom,
        rangeTo,
        groupBy: action.groupBy,
      });
    } catch (err) {
      // A quiet period is not a failure: there is simply nothing to announce.
      if (err instanceof CodedError && err.code === "no_commits_in_range")
        return { status: "skipped", errorCode: err.code, errorMessage: err.message, ...(err.params ? { errorParams: err.params } : {}) };
      throw err;
    }
    const note = await createWorkspaceReleaseNote(this.auth.cloudClient(), {
      workspaceId: routine.workspaceId,
      sources: written.sources,
      rangeFrom,
      rangeTo,
      title: written.reply.title,
      bodyMd: written.reply.markdown,
    });
    return this.post(routine, userId, written.reply.markdown, { noteId: note.id, commitCount: written.reply.commitCount });
  }

  // ── a workspace prompt: a read-only report ──────────────────────────────────

  private async writeReport(routine: WorkspaceRoutine, instructions: string, userId: string, date: string): Promise<WorkspaceRoutineRunResult> {
    const cloud = this.auth.cloudClient();
    const workspaceProjects = (await listProjects(cloud))
      .filter((p) => p.workspaceId === routine.workspaceId)
      .map((p) => ({ id: p.id, ...(p.gitRemoteUrl ? { gitRemoteUrl: p.gitRemoteUrl } : {}) }));
    const repos = managementRepos(this.registry.listProjects(), workspaceProjects);
    const prompt = buildRoutineReportPrompt({
      workspaceName: await this.workspaceName(routine.workspaceId),
      routineName: routine.name,
      date,
      timezone: routine.timezone,
      repos,
      instructions,
      ...(routine.slack ? { slackChannel: routine.slack.channelName } : {}),
    });
    const out = await runOneShot({
      kind: resolveRuntime(process.env.KERMANYCH_RUNTIME, this.registry.getAuthSession()?.agentRuntime),
      cwd: managementCwd(repos),
      prompt,
      tools: [...MANAGEMENT_TOOLS],
      startedAt: Date.now(),
    });
    return this.post(routine, userId, out.text, { outputMd: out.text });
  }

  // ── a project prompt: an agent session ──────────────────────────────────────

  // The Jira launch precedent: a card under the author's JWT, assigned to them, then the
  // ordinary launch. A launch that fails takes its card with it, so a routine failing every
  // morning does not fill the backlog with copies of its prompt.
  private async launchAgent(
    routine: WorkspaceRoutine,
    projectId: string,
    prompt: string,
    hidden: boolean,
    userId: string,
    date: string,
  ): Promise<WorkspaceRoutineRunResult> {
    const cloud = this.auth.cloudClient();
    const task = await createTask(cloud, {
      projectId,
      title: `${routine.name} · ${date}`,
      description: prompt,
      assigneeId: userId,
      createdBy: userId,
      ...(hidden ? { hidden: true } : {}),
    });
    try {
      await this.supervisor.createSessionFromTask(task.id, userId);
    } catch (err) {
      await deleteTask(cloud, task.id).catch((e: unknown) =>
        this.log.warn(`routine «${routine.name}»: could not remove the card of a failed launch — ${(e as Error).message}`),
      );
      throw err;
    }
    return { status: "succeeded", taskId: task.id };
  }

  // ── helpers ─────────────────────────────────────────────────────────────────

  // Post the run's document when the routine names a channel. A failed post fails the run but
  // keeps what was produced: the note is stored and the report is in the history either way.
  private async post(routine: WorkspaceRoutine, userId: string, markdown: string, produced: Omit<WorkspaceRoutineRunResult, "status">): Promise<WorkspaceRoutineRunResult> {
    if (!routine.slack) return { status: "succeeded", ...produced };
    try {
      const sent = await this.slack.postToChannel(routine.workspaceId, userId, routine.slack, markdown);
      return { status: "succeeded", ...produced, slackChannelName: sent.channelName };
    } catch (err) {
      return {
        status: "failed",
        ...produced,
        errorCode: "routine_slack_failed",
        errorMessage: (err as Error).message,
        errorParams: { channel: routine.slack.channelName, reason: (err as Error).message },
      };
    }
  }

  private async workspaceName(workspaceId: string): Promise<string> {
    return (await listWorkspaces(this.auth.cloudClient())).find((w) => w.id === workspaceId)?.name ?? "";
  }

  private emit(routine: WorkspaceRoutine, runId: string, status: RoutineRunStatus): void {
    this.events.next({
      type: "routine_run",
      workspaceId: routine.workspaceId,
      routineId: routine.id,
      routineName: routine.name,
      runId,
      status,
    });
  }
}
