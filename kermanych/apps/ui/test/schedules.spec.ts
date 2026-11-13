import { describe, expect, it } from 'vitest';
import type { ScheduleSlip, ScheduledTask, SkillImprovementEntry } from '@kermanych/core';
import { scheduleUndo } from '../src/lib/schedules';
import { isUnseen, mergeFeed, type NotificationItem } from '../src/lib/notification-feed';
import type { AppUpdateEntry } from '../src/stores/app-update';
import { cukScheduleRows } from '../src/lib/cuk-digest';

// docs/specs/2026-11-06-scheduled-tasks.md. What the operator would notice going wrong: «Скасувати»
// on an at-once line restoring something other than what was there (decision 7), the feed out of
// time order or miscounting what is new (decision 6), and ЦУК naming a task by a ref the executor
// cannot find again.

function task(over: Partial<ScheduledTask> = {}): ScheduledTask {
  return {
    id: '0f3a9c21-7d4e-4b8a-9c1d-2e5f6a7b8c9d',
    name: 'Вітаміни',
    kind: 'reminder',
    prompt: 'Випити вітаміни',
    skills: [],
    schedule: { type: 'daily', time: '19:00' },
    timeZone: 'Europe/Kyiv',
    enabled: true,
    armedAt: '2026-11-06T10:00:00.000Z',
    createdAt: '2026-11-06T10:00:00.000Z',
    updatedAt: '2026-11-06T10:00:00.000Z',
    running: false,
    ...over,
  };
}

describe('scheduleUndo', () => {
  it('undoes a create by deleting the task it made', () => {
    expect(scheduleUndo(undefined, task())).toEqual({ op: 'delete', id: task().id });
  });

  it('undoes an edit by patching back exactly the fields it sent', () => {
    const before = task();
    const after = task({ name: 'Вітаміни D', schedule: { type: 'daily', time: '20:00' } });
    expect(scheduleUndo(before, after, { name: 'Вітаміни D', schedule: { type: 'daily', time: '20:00' } })).toEqual({
      op: 'patch',
      id: before.id,
      patch: { name: 'Вітаміни', schedule: { type: 'daily', time: '19:00' } },
    });
  });

  it('clears an optional field the task did not have', () => {
    const before = task({ kind: 'agent', skills: ['qa-tester'] });
    const after = task({ kind: 'agent', model: 'opus', projectId: 'p1', skills: [] });
    expect(scheduleUndo(before, after, { model: 'opus', projectId: 'p1', skills: [] })).toEqual({
      op: 'patch',
      id: before.id,
      patch: { model: null, projectId: null, skills: ['qa-tester'] },
    });
  });

  it('undoes a pause to the state before it, not blindly to «on»', () => {
    expect(scheduleUndo(task({ enabled: true }), task({ enabled: false }), { enabled: false })).toEqual({
      op: 'patch',
      id: task().id,
      patch: { enabled: true },
    });
    expect(scheduleUndo(task({ enabled: false }), task({ enabled: false }), { enabled: false })).toEqual({
      op: 'patch',
      id: task().id,
      patch: { enabled: false },
    });
  });
});

describe('notification feed', () => {
  const improvement = (id: string, createdAt: string, seenAt?: string): SkillImprovementEntry => ({
    id,
    skillName: 'qa-tester',
    summary: 's',
    sessionName: 'n',
    state: 'applied',
    createdAt,
    ...(seenAt ? { seenAt } : {}),
  });
  const slip = (id: string, at: string, seen = false): ScheduleSlip => ({
    id,
    kind: 'reminder',
    scheduleId: 'x',
    scheduleName: 'Вітаміни',
    at,
    text: 'Випити вітаміни',
    late: false,
    seen,
  });

  const update = (id: string, createdAt: string, seenAt?: string): AppUpdateEntry => ({
    id,
    version: '1.3.0',
    from: '1.2.0',
    createdAt,
    ...(seenAt ? { seenAt } : {}),
  });
  const idOf = (i: NotificationItem): string =>
    i.kind === 'skill-improvement' ? i.entry.id : i.kind === 'app-update' ? i.update.id : i.slip.id;

  it('merges every source newest first, whatever the timestamp form', () => {
    const feed = mergeFeed(
      [improvement('i2', '2026-11-06T12:00:00Z'), improvement('i1', '2026-11-06T08:00:00Z')],
      [slip('s2', '2026-11-06T14:30:00.000+02:00'), slip('s1', '2026-11-06T09:00:00.000Z')],
      [update('u1', '2026-11-06T10:00:00.000Z')],
    );
    expect(feed.map(idOf)).toEqual(['s2', 'i2', 'u1', 's1', 'i1']);
  });

  it('counts an improvement or an update without seenAt and a slip not seen as new', () => {
    const feed = mergeFeed(
      [improvement('i1', '2026-11-06T08:00:00Z'), improvement('i2', '2026-11-06T09:00:00Z', '2026-11-06T10:00:00Z')],
      [slip('s1', '2026-11-06T09:00:00Z'), slip('s2', '2026-11-06T10:00:00Z', true)],
      [update('u1', '2026-11-06T11:00:00Z'), update('u2', '2026-11-06T07:00:00Z', '2026-11-06T07:30:00Z')],
    );
    expect(feed.filter(isUnseen).map(idOf)).toEqual(['u1', 's1', 'i1']);
  });
});

describe('cukScheduleRows', () => {
  it('names each task by the head of its id and its next firing on its own wall clock', () => {
    const rows = cukScheduleRows(
      [
        task({ nextAt: '2026-11-06T17:00:00.000Z' }),
        task({ id: 'aa11bb22-0000-0000-0000-000000000000', name: 'Звіт', kind: 'agent', projectId: 'p1', enabled: false }),
      ],
      (id) => (id === 'p1' ? 'Керманич' : ''),
    );
    expect(rows[0]).toMatchObject({ ref: '0f3a9c21', name: 'Вітаміни', type: 'reminder', next: '2026-11-06T19:00', enabled: true });
    expect(rows[0]).not.toHaveProperty('project');
    expect(rows[1]).toMatchObject({ ref: 'aa11bb22', type: 'agent', project: 'Керманич', enabled: false });
    expect(rows[1]).not.toHaveProperty('next');
    expect(rows[0]!.when).toContain('19:00');
  });
});
