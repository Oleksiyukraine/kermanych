import { describe, expect, it } from 'vitest';
import type { JiraIssue, WorkspaceReleaseNote } from '@kermanych/cloud';
import { mergeLayout } from '../src/lib/dashboard';
import { homeDigest, isForToday, todayTaskGroups } from '../src/lib/home-digest';
import type { TodoItem } from '../src/lib/home-todo';

const DAY = '2026-09-08';

// Only the fields the digest reads; the rest of a JiraIssue never reaches it.
function issue(over: Partial<JiraIssue>): JiraIssue {
  return {
    key: 'KRM-1',
    summary: 'задача',
    startDate: '',
    dueDate: DAY,
    statusCategory: 'indeterminate',
    ...over,
  } as JiraIssue;
}

describe('isForToday', () => {
  it('counts due-today, overdue and mid-window tickets; skips done and undated', () => {
    expect(isForToday(issue({}), DAY)).toBe(true);
    expect(isForToday(issue({ dueDate: '2026-09-01' }), DAY)).toBe(true); // overdue, still owed
    expect(isForToday(issue({ startDate: '2026-09-05', dueDate: '2026-09-12' }), DAY)).toBe(true);
    expect(isForToday(issue({ dueDate: '2026-09-12' }), DAY)).toBe(false); // not started
    expect(isForToday(issue({ statusCategory: 'done' }), DAY)).toBe(false);
    expect(isForToday(issue({ dueDate: '' }), DAY)).toBe(false);
  });
});

describe('todayTaskGroups', () => {
  it('groups by assignee, busiest first, the unassigned bucket last with a blank name', () => {
    const groups = todayTaskGroups(
      [
        issue({ key: 'K-1', assigneeAccountId: 'a1', assigneeName: 'Оля' }),
        issue({ key: 'K-2' }), // unassigned
        issue({ key: 'K-3', assigneeAccountId: 'b2', assigneeName: 'Іван' }),
        issue({ key: 'K-4', assigneeAccountId: 'b2', assigneeName: 'Іван', dueDate: '2026-09-01' }),
        issue({ key: 'K-5', dueDate: '2026-09-12' }), // not today — dropped
      ],
      DAY,
    );
    expect(groups.map((g) => g.name)).toEqual(['Іван', 'Оля', '']);
    expect(groups[0]!.tasks.map((t) => t.key)).toEqual(['K-3', 'K-4']);
    expect(groups[0]!.tasks[1]).toEqual({ key: 'K-4', summary: 'задача', overdue: true });
    expect(groups[2]!.tasks).toEqual([{ key: 'K-2', summary: 'задача', overdue: false }]);
  });
});

describe('homeDigest', () => {
  it('mirrors the tiles, sheds to-do formatting and caps the notes at the tile depth', () => {
    const todo: TodoItem[] = [
      { id: '1', kind: 'check', html: 'подзвонити <b>Олі</b>&nbsp;сьогодні', done: true },
      { id: '2', kind: 'number', html: 'крок', done: false },
    ];
    const notes = Array.from({ length: 7 }, (_, i) => ({
      title: `Note ${i}`,
      projectName: 'Альфа',
      createdAt: `2026-08-0${i + 1}T00:00:00.000Z`,
    })) as WorkspaceReleaseNote[];
    const out = homeDigest({
      layout: mergeLayout(null),
      todo,
      groups: [{ id: 'a1', name: 'Оля', tasks: [{ key: 'K-1', summary: 's', overdue: false }] }],
      notes,
    });
    expect(out.tiles.map((t) => t.id)).toEqual(['capacity', 'tasks', 'risks', 'releases', 'todo']);
    expect(out.tiles[0]).toEqual({ id: 'capacity', w: 2, h: 2 });
    expect(out.todo).toEqual([
      { text: 'подзвонити Олі сьогодні', kind: 'check', done: true },
      { text: 'крок', kind: 'number', done: false },
    ]);
    expect(out.tasksToday).toEqual([{ name: 'Оля', tasks: [{ key: 'K-1', summary: 's', overdue: false }] }]);
    expect(out.releases).toHaveLength(5);
    expect(out.releases[0]).toEqual({ title: 'Note 0', projectName: 'Альфа', createdAt: '2026-08-01T00:00:00.000Z' });
  });
});
