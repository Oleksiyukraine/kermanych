// apps/ui/src/lib/routines.ts
// What the Routines screen says about a routine (docs/specs/2026-10-16-routines.md): its
// schedule in words, who may do what with it, and why a run failed or was skipped. Pure, so the
// rules are testable without mounting a page.
import type { RoutineSchedule } from '@kermanych/core';
import type { WorkspaceRoutine, WorkspaceRoutineRun } from '@kermanych/cloud';

type Translate = (key: string, named?: Record<string, unknown>) => string;
type Translator = { t: Translate; te: (key: string) => boolean };

// Monday first, the way a week is read on this team's calendars; the stored numbers stay JS's
// (0 = Sunday), which is what the schedule math in core counts in.
export const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0] as const;

export function describeSchedule(t: Translate, s: RoutineSchedule): string {
  const k = 'management.routines.scheduleText.';
  switch (s.kind) {
    case 'manual':
      return t(`${k}manual`);
    case 'once':
      return t(`${k}once`, { date: s.date, time: s.time });
    case 'hourly':
      return t(`${k}hourly`, { minute: String(s.minute).padStart(2, '0') });
    case 'daily':
      return t(`${k}daily`, { time: s.time });
    case 'weekdays':
      return t(`${k}weekdays`, { time: s.time });
    case 'weekly': {
      const days = WEEK_ORDER.filter((d) => s.days.includes(d)).map((d) => t(`management.routines.weekday.${d}`));
      return t(`${k}weekly`, { days: days.join(', '), time: s.time });
    }
    case 'monthly':
      return t(`${k}monthly`, { day: s.day, time: s.time });
  }
}

// A routine acts in its author's name, so the author alone edits it and runs it by hand. The
// workspace owner may still pause or delete it — the database enforces the same split
// (20261016090000_workspace_routines.sql); this only keeps the buttons honest.
export type RoutineRights = { edit: boolean; run: boolean; toggle: boolean; remove: boolean };

export function routineRights(routine: WorkspaceRoutine, userId: string | undefined, isOwner: boolean): RoutineRights {
  const author = !!userId && routine.createdBy === userId;
  return { edit: author, run: author, toggle: author || isOwner, remove: author || isOwner };
}

// Why a run failed or was skipped, in the operator's language when the code is known: an api
// error code first (the release-notes refusals already have messages), then a routine reason,
// then the sentence the runner stored.
export function runReason(tr: Translator, run: WorkspaceRoutineRun): string | undefined {
  const code = run.errorCode;
  if (code) {
    for (const key of [`errors.${code}`, `management.routines.reason.${code}`])
      if (tr.te(key)) return tr.t(key, { ...run.errorParams });
  }
  return run.errorMessage;
}

// An instant on the routine's own clock — «Mon, 19 Oct, 10:00» — since that is the clock the
// schedule was written in, whatever zone the reader is in.
export function formatInstant(ms: number, timezone: string, locale: string): string {
  return new Intl.DateTimeFormat(locale, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: timezone,
  }).format(ms);
}

