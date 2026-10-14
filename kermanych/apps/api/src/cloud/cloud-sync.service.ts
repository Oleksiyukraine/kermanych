// apps/api/src/cloud/cloud-sync.service.ts
// Local → cloud mirror of what the supervisor owes the cloud card on its own: the coarse
// status, and a session's «Документація» / «Сесія» reports
// (docs/specs/2026-10-12-docs-tab-survives-restart.md). It never mutates a session and never
// blocks one: statuses come off `supervisor.events$`, reports are queued by the supervisor in
// the registry, and every push it owes goes through a SQLite outbox first.
import { Injectable, type OnModuleDestroy, type OnModuleInit } from "@nestjs/common";
import { ACTIVE_STATUSES, mergeTaskReports, type Session } from "@kermanych/core";
import { getTask, patchTask, pushTaskStatus, taskStatusFromSession, type TaskStatus } from "@kermanych/cloud";
import { RegistryService } from "../registry/registry.service";
import { SupervisorService } from "../supervisor/supervisor.service";
import { AuthService } from "../auth/auth.service";
import type { SupabaseClient } from "@supabase/supabase-js";

const BASE_DELAY_MS = 1_000;
const MAX_DELAY_MS = 60_000;

@Injectable()
export class CloudSyncService implements OnModuleInit, OnModuleDestroy {
  // Last status actually enqueued per TASK — the edge filter. Mirrors the `shouldNotify`
  // idiom in core/status.ts: act on transitions, not on repeats.
  private lastPushed = new Map<string, TaskStatus>();
  // sessionId → taskId. `session_removed` carries only the id and the row is already gone
  // from SQLite by then (supervisor.service.ts:817-818), so the binding must be remembered.
  private taskOf = new Map<string, string>();
  private timer?: NodeJS.Timeout;
  private draining = false;
  // A drain was asked for while one was already running — take another pass before finishing.
  private requeued = false;

  constructor(
    private supervisor: SupervisorService,
    private registry: RegistryService,
    private auth: AuthService,
  ) {}

  onModuleInit(): void {
    // Same subscription shape as EventsGateway (ws/events.gateway.ts:21-23): subscribe from
    // outside instead of reaching into the supervisor's status paths (D3).
    this.supervisor.events$.subscribe((e) => {
      if (e.type === "session_update") this.onSession(e.session);
      else if (e.type === "session_removed") this.onRemoved(e.sessionId);
    });
    // The supervisor queues a card report after every turn and on «Завершити»; the registry
    // signals it so the push leaves now rather than with the next status change.
    this.registry.reportQueued$.subscribe(() => void this.drain());
    // Relogin / TOKEN_REFRESHED: a queue parked on "not signed in" resumes immediately
    // instead of waiting out its backoff.
    this.auth.onToken(() => void this.drain());
    // A previous run may have exited with rows still queued (offline, or the shutdown
    // `stopped` writes below).
    void this.drain();
  }

  onModuleDestroy(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    // A clean shutdown must never leave the board on `thinking` (spec: "so a clean shutdown
    // never leaves the board on thinking"). Enqueue only — the write is synchronous and
    // durable, whereas an awaited HTTP push would race the process exit.
    for (const taskId of new Set(this.taskOf.values())) {
      const last = this.lastPushed.get(taskId);
      if (last && ACTIVE_STATUSES.includes(last)) {
        this.lastPushed.set(taskId, "stopped");
        this.registry.enqueueTaskStatus(taskId, "stopped", new Date().toISOString());
      }
    }
  }

  private onSession(s: Session): void {
    if (!s.taskId) return;
    this.taskOf.set(s.id, s.taskId);
    const status = taskStatusFromSession(s);
    // `pushUpdate` also fires for contextPercent/todoPhases/task edits — those must cost
    // nothing (Requirement 6: only coarse status changes leave the machine).
    if (this.lastPushed.get(s.taskId) === status) return;
    this.lastPushed.set(s.taskId, status);
    this.registry.enqueueTaskStatus(s.taskId, status, new Date().toISOString());
    void this.drain();
  }

  private onRemoved(sessionId: string): void {
    const taskId = this.taskOf.get(sessionId);
    if (!taskId) return;
    this.taskOf.delete(sessionId);
    const last = this.lastPushed.get(taskId);
    // The session is gone, so its edge-filter entry is dead weight — drop it either way. Left
    // behind, `lastPushed` grew by one entry per task for the process's whole life; a later
    // session that reuses this taskId (a relaunch) re-seeds it on its first status.
    this.lastPushed.delete(taskId);
    // D5: only an ACTIVE task needs a terminal push; a session deleted after `done`/`merged`
    // must not have its outcome overwritten by `stopped`.
    if (!last || !ACTIVE_STATUSES.includes(last)) return;
    this.registry.enqueueTaskStatus(taskId, "stopped", new Date().toISOString());
    void this.drain();
  }

  // Push everything queued. Safe to call concurrently: a call arriving mid-flight cannot
  // start a second pass (that would double-push a row), so it leaves a flag and the running
  // drain takes another pass once it is done. Without that re-pass a row enqueued while an
  // earlier pass had already read an empty queue would sit there until the next status
  // change — the queue must never be quietly behind the session.
  async drain(): Promise<void> {
    if (this.draining) {
      this.requeued = true;
      return;
    }
    this.draining = true;
    try {
      do {
        this.requeued = false;
        await this.pass();
      } while (this.requeued);
    } finally {
      this.draining = false;
    }
  }

  private async pass(): Promise<void> {
    const rows = this.registry.listOutbox();
    const reports = this.registry.listReportOutbox();
    if (!rows.length && !reports.length) return;

    let client: SupabaseClient;
    try {
      client = this.auth.cloudClient();
    } catch {
      // Signed out: nothing was attempted, so `attempts` stays untouched and the row keeps
      // its place in the queue. The next token handoff drains it.
      this.rearm([...rows, ...reports]);
      return;
    }

    for (const row of rows) {
      try {
        await pushTaskStatus(client, row.taskId, row.status, row.updatedAt);
        // Retire exactly the version just delivered. Anything enqueued during the await
        // outlives this: a `session_update` re-passes via its own `drain()`, and the
        // shutdown `stopped` is left for the retry timer or the next boot's drain.
        this.registry.dropOutbox(row.taskId, row.status, row.updatedAt);
      } catch (err) {
        const message = (err as Error).message;
        this.registry.bumpOutboxAttempt(row.taskId, row.status, row.updatedAt, message);
        console.warn(`[cloud-sync] status push for task ${row.taskId} failed (attempt ${row.attempts + 1}): ${message}`);
      }
    }

    // A report lands on the card's CURRENT value: read, merge, write. The merge is what keeps
    // reads accumulating across writes and what refuses to overwrite a relaunch's newer report,
    // so it has to run against the card, not against what this machine last sent.
    for (const row of reports) {
      try {
        const task = await getTask(client, row.taskId);
        // No task: deleted, or no longer readable by this user (left the workspace). Retrying
        // cannot change that, and the row would only hold the retry timer — so it is dropped.
        // `undefined` from the merge: the card already carries a newer session's report.
        const merged = task && mergeTaskReports({ docs: task.docsReport, session: task.sessionReport }, row.write);
        if (merged) await patchTask(client, row.taskId, { docsReport: merged.docs, sessionReport: merged.session });
        this.registry.dropReportOutbox(row.taskId, row.queuedAt);
      } catch (err) {
        const message = (err as Error).message;
        this.registry.bumpReportOutboxAttempt(row.taskId, row.queuedAt, message);
        console.warn(`[cloud-sync] report push for task ${row.taskId} failed (attempt ${row.attempts + 1}): ${message}`);
      }
    }
    this.rearm([...this.registry.listOutbox(), ...this.registry.listReportOutbox()]);
  }

  // Exponential backoff — first retry ~2 s (attempts is already 1 after the first
  // failure), doubling to a 60 s cap — driven by the least-retried row of either outbox, so
  // a single poisoned row cannot starve a fresh one. Unref'd: a pending retry must never
  // hold the process open.
  private rearm(rows: readonly { attempts: number }[]): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    if (!rows.length) return;
    const attempts = Math.min(...rows.map((r) => r.attempts));
    const delay = Math.min(BASE_DELAY_MS * 2 ** attempts, MAX_DELAY_MS);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.drain();
    }, delay);
    this.timer.unref();
  }
}
