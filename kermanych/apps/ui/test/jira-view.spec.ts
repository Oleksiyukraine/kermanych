import { describe, expect, it } from 'vitest';
import {
  dateChip,
  issuesByColumn,
  launchDefaults,
  subtasksOf,
  todayIso,
  transitionChoiceForDrop,
  type JiraTransitionView,
} from '../src/lib/jira-view';
import type { JiraColumn, JiraIssue } from '@kermanych/cloud';

const col = (position: number, name: string, statusIds: string[]): JiraColumn => ({
  integrationId: 'i1',
  workspaceId: 'w1',
  position,
  name,
  statusIds,
});

function issue(over: Partial<JiraIssue>): JiraIssue {
  return {
    integrationId: 'i1',
    workspaceId: 'w1',
    issueId: '1',
    key: 'KAN-1',
    summary: 's',
    descriptionHtml: '',
    typeName: '',
    typeIcon: '',
    priorityName: '',
    priorityIcon: '',
    labels: [],
    originalEstimate: '',
    startDate: '',
    dueDate: '',
    statusId: '1',
    statusName: 'To Do',
    statusCategory: 'new',
    jiraUpdatedAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
    ...over,
  };
}

const t = (id: string, toId: string, key = 'indeterminate', name = id): JiraTransitionView => ({
  id,
  name,
  to: { id: toId, name: `S${toId}`, statusCategory: { key } },
});

describe('issuesByColumn', () => {
  const columns = [col(0, 'To Do', ['1']), col(1, 'In Progress', ['3', '4'])];

  it('groups by the first column holding the status and hides unmapped issues', () => {
    const grouped = issuesByColumn(columns, [
      issue({ issueId: 'a', statusId: '1' }),
      issue({ issueId: 'b', statusId: '4' }),
      issue({ issueId: 'c', statusId: '99' }), // unmapped: not on the board, like in Jira
    ]);
    expect(grouped[0]!.map((i) => i.issueId)).toEqual(['a']);
    expect(grouped[1]!.map((i) => i.issueId)).toEqual(['b']);
  });

  it('orders a column by newest Jira activity first', () => {
    const grouped = issuesByColumn(columns, [
      issue({ issueId: 'old', statusId: '1', jiraUpdatedAt: '2026-09-01T00:00:00.000Z' }),
      issue({ issueId: 'new', statusId: '1', jiraUpdatedAt: '2026-09-02T00:00:00.000Z' }),
    ]);
    expect(grouped[0]!.map((i) => i.issueId)).toEqual(['new', 'old']);
  });
});

describe('transitionChoiceForDrop', () => {
  const target = col(1, 'In Progress', ['3', '4']);

  it('refuses when the workflow offers no way into the column', () => {
    expect(transitionChoiceForDrop(target, [t('11', '99')])).toEqual({ kind: 'none' });
  });

  it('transitions immediately when exactly one status is reachable', () => {
    const d = transitionChoiceForDrop(target, [t('11', '3'), t('12', '99')]);
    expect(d.kind).toBe('auto');
    expect(d.kind === 'auto' && d.transition.id).toBe('11');
  });

  it('asks when several statuses are reachable, de-duplicating parallel arrows', () => {
    const d = transitionChoiceForDrop(target, [t('11', '3'), t('11b', '3'), t('12', '4')]);
    expect(d.kind).toBe('pick');
    expect(d.kind === 'pick' && d.options.map((o) => o.id)).toEqual(['11', '12']);
  });
});

describe('launchDefaults', () => {
  const projects = [{ id: 'p1' }, { id: 'p2' }];

  it('prefers the remembered binding, then the sidebar scope, then a sole project', () => {
    expect(launchDefaults(issue({ kermanychProjectId: 'p2' }), 'p1', projects, []).projectId).toBe('p2');
    expect(launchDefaults(issue({}), 'p1', projects, []).projectId).toBe('p1');
    expect(launchDefaults(issue({}), null, [{ id: 'only' }], []).projectId).toBe('only');
    expect(launchDefaults(issue({}), null, projects, []).projectId).toBeUndefined();
  });

  it('ignores a remembered project that no longer exists in the workspace', () => {
    expect(launchDefaults(issue({ kermanychProjectId: 'gone' }), 'p1', projects, []).projectId).toBe('p1');
  });

  it('skips the status question entirely for a ticket already In Progress', () => {
    const d = launchDefaults(issue({ statusCategory: 'indeterminate' }), null, projects, [t('11', '3')]);
    expect(d.askStatus).toBe(false);
    expect(d.transitionId).toBeUndefined();
  });

  it('preselects the first transition into the In-Progress category otherwise', () => {
    const d = launchDefaults(issue({ statusCategory: 'new' }), null, projects, [
      t('10', '5', 'done'),
      t('11', '3', 'indeterminate'),
    ]);
    expect(d.askStatus).toBe(true);
    expect(d.transitionId).toBe('11');
  });
});

describe('subtasksOf', () => {
  it('returns direct children even when their status is unmapped', () => {
    const issues = [
      issue({ issueId: 'a', key: 'KAN-2', parentKey: 'KAN-1' }),
      issue({ issueId: 'b', key: 'KAN-3', parentKey: 'KAN-9' }),
    ];
    expect(subtasksOf(issues, 'KAN-1').map((i) => i.key)).toEqual(['KAN-2']);
  });
});

describe('dateChip', () => {
  it('shows a start–due range, and one side alone when that is all Jira has', () => {
    expect(dateChip(issue({ startDate: '2026-09-01', dueDate: '2026-09-12' }), '2026-09-02')!.text).toBe(
      '01.09 – 12.09',
    );
    expect(dateChip(issue({ dueDate: '2026-09-12' }), '2026-09-02')!.text).toBe('до 12.09');
    expect(dateChip(issue({ startDate: '2026-09-01' }), '2026-09-02')!.text).toBe('з 01.09');
  });

  it('has nothing to say about a ticket with no dates', () => {
    expect(dateChip(issue({}), '2026-09-02')).toBeUndefined();
  });

  it('calls a passed due date overdue, today soon, and a future one plain', () => {
    expect(dateChip(issue({ dueDate: '2026-09-01' }), '2026-09-02')!.tone).toBe('overdue');
    expect(dateChip(issue({ dueDate: '2026-09-02' }), '2026-09-02')!.tone).toBe('soon');
    expect(dateChip(issue({ dueDate: '2026-09-03' }), '2026-09-02')!.tone).toBe('plain');
  });

  // The whole point of reading statusCategory: finished work cannot be late any more.
  it('never calls a done ticket overdue, however long its due date has passed', () => {
    expect(dateChip(issue({ dueDate: '2020-01-01', statusCategory: 'done' }), '2026-09-02')!.tone).toBe('plain');
  });

  // A start date alone is a plan, not a problem — no colour for it.
  it('leaves a start-only ticket plain even when that start is long past', () => {
    expect(dateChip(issue({ startDate: '2020-01-01' }), '2026-09-02')!.tone).toBe('plain');
  });
});

describe('todayIso', () => {
  it('spells the LOCAL day the way Jira does, without a UTC shift', () => {
    // 00:30 local on the 2nd is the 2nd — through UTC in a +03:00 zone it would be the 1st.
    expect(todayIso(new Date(2026, 8, 2, 0, 30))).toBe('2026-09-02');
    expect(todayIso(new Date(2026, 0, 9, 23, 45))).toBe('2026-01-09');
  });
});
