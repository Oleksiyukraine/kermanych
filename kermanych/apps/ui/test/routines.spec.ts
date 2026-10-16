import { describe, expect, it } from 'vitest';
import { ROUTINE_INVALID_CODES, ROUTINE_RUN_REASONS } from '@kermanych/core';
import type { WorkspaceRoutine, WorkspaceRoutineRun } from '@kermanych/cloud';
import { globalTr } from '../src/boot/i18n';
import { uk } from '../src/i18n/uk';
import { en } from '../src/i18n/en';
import { describeSchedule, routineRights, runReason } from '../src/lib/routines';

// The editor words core's validation codes and the runner's reasons in the interface language;
// a code without a message would show the English fallback in a Ukrainian screen.
describe('routine messages', () => {
  it.each([
    ['uk', uk],
    ['en', en],
  ] as const)('every validation code and run reason has a message in %s', (_name, locale) => {
    const r = locale.management.routines as unknown as { invalid: Record<string, string>; reason: Record<string, string> };
    expect(ROUTINE_INVALID_CODES.filter((c) => !(c in r.invalid))).toEqual([]);
    expect(ROUTINE_RUN_REASONS.filter((c) => !(c in r.reason))).toEqual([]);
  });
});

const routine = { id: 'r1', createdBy: 'author' } as WorkspaceRoutine;
const run = (over: Partial<WorkspaceRoutineRun>) =>
  ({ id: 'x', routineId: 'r1', workspaceId: 'w1', trigger: 'schedule', status: 'failed', startedAt: '', ...over }) as WorkspaceRoutineRun;

describe('routineRights', () => {
  it('lets only the author edit and run a routine — it acts in their name', () => {
    expect(routineRights(routine, 'author', false)).toEqual({ edit: true, run: true, toggle: true, remove: true });
  });

  it('lets the workspace owner pause and delete, but not edit or run, someone else’s routine', () => {
    expect(routineRights(routine, 'owner', true)).toEqual({ edit: false, run: false, toggle: true, remove: true });
  });

  it('gives another member nothing', () => {
    expect(routineRights(routine, 'member', false)).toEqual({ edit: false, run: false, toggle: false, remove: false });
    expect(routineRights(routine, undefined, false).edit).toBe(false);
  });
});

describe('describeSchedule', () => {
  it('lists weekly days Monday first, whatever order they were stored in', () => {
    expect(describeSchedule(globalTr.t, { kind: 'weekly', days: [0, 5, 1], time: '09:30' })).toBe('щотижня: Пн, Пт, Нд о 09:30');
  });

  it('pads the minute of an hourly schedule', () => {
    expect(describeSchedule(globalTr.t, { kind: 'hourly', minute: 5 })).toBe('щогодини о :05');
  });
});

describe('runReason', () => {
  it('words a known api error code in the interface language', () => {
    const r = run({ status: 'skipped', errorCode: 'no_commits_in_range', errorMessage: 'fallback', errorParams: { project: 'Альфа', branch: 'main', from: 'a', to: 'b' } });
    expect(runReason(globalTr, r)).toContain('Альфа');
    expect(runReason(globalTr, r)).not.toBe('fallback');
  });

  it('words a routine reason with its parameters', () => {
    const r = run({ errorCode: 'routine_slack_failed', errorParams: { channel: 'weekly', reason: 'not_in_channel' } });
    expect(runReason(globalTr, r)).toBe('не вдалося опублікувати в #weekly: not_in_channel');
  });

  it('falls back to the stored sentence for an unknown code or none', () => {
    expect(runReason(globalTr, run({ errorCode: 'something_new', errorMessage: 'stored' }))).toBe('stored');
    expect(runReason(globalTr, run({ errorMessage: 'project not bound' }))).toBe('project not bound');
  });
});
