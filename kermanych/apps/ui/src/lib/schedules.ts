// apps/ui/src/lib/schedules.ts
// «Задачі за розкладом» in the browser (docs/specs/2026-11-06-scheduled-tasks.md), pure: the
// machine's zone, a firing as the screens print it, the run reasons the UI words, and what
// «Скасувати» on an at-once ЦУК result undoes (decision 7). The occurrence math and the wall
// clocks ЦУК reads are core's (`nextOccurrences`, `describeSchedule`, `formatZonedWall`).
import type { SchedulePatch, ScheduleRunReason, ScheduledTask } from '@kermanych/core';

/** The machine's IANA zone: a task created here keeps it (spec «Defaults»: wall-clock time). */
export function machineTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

/** «чт, 6 лист., 19:00» — one firing as the operator reads it, in the task's own zone. */
export function formatFiring(at: Date | string, timeZone: string, locale: 'uk' | 'en'): string {
  return new Intl.DateTimeFormat(locale === 'uk' ? 'uk-UA' : 'en-GB', {
    timeZone,
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(typeof at === 'string' ? new Date(at) : at);
}

// Every reason a run can be skipped or fail, each worded in `cuk.schedule.reason.<reason>`. A
// Record over the union, so a reason core adds is a compile error here until it is worded.
const RUN_REASONS: Record<ScheduleRunReason, true> = {
  overlap: true,
  missed: true,
  not_signed_in: true,
  project_unbound: true,
  project_missing: true,
  skill_missing: true,
  launch_failed: true,
  run_failed: true,
  timeout: true,
};
export const SCHEDULE_RUN_REASONS = Object.keys(RUN_REASONS) as ScheduleRunReason[];

/** What «Скасувати» on an at-once ЦУК result does: drop what was created, or write back what changed. */
export type ScheduleUndo = { op: 'delete'; id: string } | { op: 'patch'; id: string; patch: SchedulePatch };

/**
 * The inverse of one at-once schedule action (decision 7). A create is undone by deleting the
 * task it made. Every other at-once action (an edit, a pause, a resume) was a patch, and is undone
 * by patching back exactly the fields it sent, at their values in `before` — so a pause of a task
 * that was already paused undoes to «paused», not to «running». Optional fields the task did not
 * have go back as `null`, the patch's «clear».
 */
export function scheduleUndo(before: ScheduledTask | undefined, after: ScheduledTask, sent?: SchedulePatch): ScheduleUndo {
  if (!before || !sent) return { op: 'delete', id: after.id };
  const back: SchedulePatch = {};
  if (sent.name !== undefined) back.name = before.name;
  if (sent.prompt !== undefined) back.prompt = before.prompt;
  if (sent.projectId !== undefined) back.projectId = before.projectId ?? null;
  if (sent.skills !== undefined) back.skills = [...before.skills];
  if (sent.model !== undefined) back.model = before.model ?? null;
  if (sent.schedule !== undefined) back.schedule = before.schedule;
  if (sent.enabled !== undefined) back.enabled = before.enabled;
  return { op: 'patch', id: before.id, patch: back };
}

/**
 * The sentence for a skipped or failed run: the UI's own wording of `reason`, so the column and
 * the history speak the active locale; the api's text when there is no reason to word.
 */
export function reasonText(t: (key: string) => string, reason: ScheduleRunReason | undefined, fallback: string): string {
  return reason ? t(`cuk.schedule.reason.${reason}`) : fallback;
}
