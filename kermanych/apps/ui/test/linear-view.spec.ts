import { describe, expect, it } from 'vitest';
import {
  assigneeOptions,
  dateChip,
  filterByAssignee,
  filterIssues,
  UNASSIGNED,
  issuesByColumn,
  launchDefaults,
  subtasksOf,
  todayIso,
  transitionChoiceForDrop,
  type LinearTransitionView,
} from '../src/lib/linear-view';
import type { LinearColumn, LinearIssue } from '@kermanych/cloud';

const col = (position: number, name: string, stateIds: string[]): LinearColumn => ({
  integrationId: 'i1',
  workspaceId: 'w1',
  position,
  name,
  stateIds,
});

function issue(over: Partial<LinearIssue>): LinearIssue {
  return {
    integrationId: 'i1',
    workspaceId: 'w1',
    issueId: '1',
    key: 'ENG-1',
    title: 's',
    descriptionMd: '',
    priority: 0,
    priorityName: '',
    estimate: 0,
    labels: [],
    stateId: '1',
    stateName: 'Todo',
    stateCategory: 'new',
    url: 'https://linear.app/acme/issue/ENG-1',
    startDate: '',
    dueDate: '',
    linearUpdatedAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
    ...over,
  };
}

const t = (id: string, toId: string, key = 'indeterminate', name = id): LinearTransitionView => ({
  id,
  name,
  to: { id: toId, name: `S${toId}`, statusCategory: { key } },
});

describe('filterIssues', () => {
  it('returns the input array itself when nothing is typed', () => {
    const issues = [issue({ issueId: 'a' })];
    expect(filterIssues(issues, '')).toBe(issues);
  });

  it('treats a whitespace-only query as nothing typed', () => {
    const issues = [issue({ issueId: 'a' })];
    expect(filterIssues(issues, '   ')).toBe(issues);
  });

  it('matches the identifier regardless of case', () => {
    const issues = [issue({ issueId: 'a', key: 'ENG-42' }), issue({ issueId: 'b', key: 'ENG-7' })];
    expect(filterIssues(issues, 'eng-42').map((i) => i.issueId)).toEqual(['a']);
  });

  it('matches a substring of the title', () => {
    const issues = [
      issue({ issueId: 'a', title: 'Fix the sandbox timeout' }),
      issue({ issueId: 'b', title: 'Add a login button' }),
    ];
    expect(filterIssues(issues, 'sandbox').map((i) => i.issueId)).toEqual(['a']);
  });

  it('matches the assignee name', () => {
    const issues = [
      issue({ issueId: 'a', assigneeName: 'Андрій Чесноков' }),
      issue({ issueId: 'b', assigneeName: 'Олексій' }),
    ];
    expect(filterIssues(issues, 'чесноков').map((i) => i.issueId)).toEqual(['a']);
  });

  it('matches a label and the priority name', () => {
    const issues = [
      issue({ issueId: 'a', labels: ['backend', 'urgent'], priorityName: 'Urgent' }),
      issue({ issueId: 'b', labels: ['design'], priorityName: 'Low' }),
    ];
    expect(filterIssues(issues, 'urgent').map((i) => i.issueId)).toEqual(['a']);
    expect(filterIssues(issues, 'low').map((i) => i.issueId)).toEqual(['b']);
  });

  it('requires every token to match, and lets tokens land in different fields', () => {
    const issues = [
      issue({ issueId: 'a', title: 'Fix the sandbox', assigneeName: 'Андрій' }),
      issue({ issueId: 'b', title: 'Fix the login', assigneeName: 'Андрій' }),
      issue({ issueId: 'c', title: 'Fix the sandbox', assigneeName: 'Олексій' }),
    ];
    expect(filterIssues(issues, 'sandbox андрій').map((i) => i.issueId)).toEqual(['a']);
  });

  it('returns nothing when no issue matches', () => {
    const issues = [issue({ issueId: 'a', title: 'Fix the sandbox' })];
    expect(filterIssues(issues, 'nonexistent')).toEqual([]);
  });

  // The description is markdown, so searching it would match syntax: «#» or «*» would hit
  // every ticket that carries any formatting at all.
  it('does not match the markdown description', () => {
    const issues = [issue({ issueId: 'a', descriptionMd: '# Heading with sneaky body text' })];
    expect(filterIssues(issues, 'sneaky')).toEqual([]);
  });
});

describe('assigneeOptions', () => {
  it('lists one option per person, sorted by name', () => {
    const issues = [
      issue({ issueId: 'a', assigneeId: 'u2', assigneeName: 'Олексій' }),
      issue({ issueId: 'b', assigneeId: 'u1', assigneeName: 'Андрій' }),
    ];
    expect(assigneeOptions(issues)).toEqual([
      { id: 'u1', name: 'Андрій' },
      { id: 'u2', name: 'Олексій' },
    ]);
  });

  it('lists a person carrying several tickets once', () => {
    const issues = [
      issue({ issueId: 'a', assigneeId: 'u1', assigneeName: 'Андрій' }),
      issue({ issueId: 'b', assigneeId: 'u1', assigneeName: 'Андрій' }),
    ];
    expect(assigneeOptions(issues)).toEqual([{ id: 'u1', name: 'Андрій' }]);
  });

  it('offers no option for unassigned tickets', () => {
    const issues = [issue({ issueId: 'a' }), issue({ issueId: 'b', assigneeId: 'u1', assigneeName: 'Андрій' })];
    expect(assigneeOptions(issues)).toEqual([{ id: 'u1', name: 'Андрій' }]);
  });

  // An older mirror row can carry the name without the user id; the person is still a real
  // filterable person, keyed by the only identity there is.
  it('falls back to the name when the user id is missing', () => {
    const issues = [issue({ issueId: 'a', assigneeName: 'Андрій' })];
    expect(assigneeOptions(issues)).toEqual([{ id: 'Андрій', name: 'Андрій' }]);
  });
});

describe('filterByAssignee', () => {
  it('returns the input array itself when nobody is picked', () => {
    const issues = [issue({ issueId: 'a', assigneeId: 'u1', assigneeName: 'Андрій' })];
    expect(filterByAssignee(issues, '')).toBe(issues);
  });

  it('keeps only the picked person’s tickets', () => {
    const issues = [
      issue({ issueId: 'a', assigneeId: 'u1', assigneeName: 'Андрій' }),
      issue({ issueId: 'b', assigneeId: 'u2', assigneeName: 'Олексій' }),
      issue({ issueId: 'c' }),
    ];
    expect(filterByAssignee(issues, 'u1').map((i) => i.issueId)).toEqual(['a']);
  });

  it('keeps only tickets with nobody on them when Unassigned is picked', () => {
    const issues = [
      issue({ issueId: 'a', assigneeId: 'u1', assigneeName: 'Андрій' }),
      issue({ issueId: 'b' }),
    ];
    expect(filterByAssignee(issues, UNASSIGNED).map((i) => i.issueId)).toEqual(['b']);
  });

  it('matches a person keyed by name when the user id is missing', () => {
    const issues = [issue({ issueId: 'a', assigneeName: 'Андрій' }), issue({ issueId: 'b' })];
    expect(filterByAssignee(issues, 'Андрій').map((i) => i.issueId)).toEqual(['a']);
  });

  // The board applies both narrowings at once; neither may widen the other.
  it('intersects with the search box', () => {
    const issues = [
      issue({ issueId: 'a', title: 'Fix the sandbox', assigneeId: 'u1', assigneeName: 'Андрій' }),
      issue({ issueId: 'b', title: 'Fix the login', assigneeId: 'u1', assigneeName: 'Андрій' }),
      issue({ issueId: 'c', title: 'Fix the sandbox', assigneeId: 'u2', assigneeName: 'Олексій' }),
    ];
    expect(filterByAssignee(filterIssues(issues, 'sandbox'), 'u1').map((i) => i.issueId)).toEqual(['a']);
  });
});

describe('issuesByColumn', () => {
  const columns = [col(0, 'Todo', ['1']), col(1, 'In Progress', ['3'])];

  it('groups by the column holding the state and hides unmapped issues', () => {
    const grouped = issuesByColumn(columns, [
      issue({ issueId: 'a', stateId: '1' }),
      issue({ issueId: 'b', stateId: '3' }),
      issue({ issueId: 'c', stateId: '99' }), // unmapped: not on the board
    ]);
    expect(grouped[0]!.map((i) => i.issueId)).toEqual(['a']);
    expect(grouped[1]!.map((i) => i.issueId)).toEqual(['b']);
  });

  it('orders a column by newest Linear activity first', () => {
    const grouped = issuesByColumn(columns, [
      issue({ issueId: 'old', stateId: '1', linearUpdatedAt: '2026-09-01T00:00:00.000Z' }),
      issue({ issueId: 'new', stateId: '1', linearUpdatedAt: '2026-09-02T00:00:00.000Z' }),
    ]);
    expect(grouped[0]!.map((i) => i.issueId)).toEqual(['new', 'old']);
  });
});

describe('transitionChoiceForDrop', () => {
  const target = col(1, 'In Progress', ['3']);

  it('refuses when no transition reaches the column state', () => {
    expect(transitionChoiceForDrop(target, [t('11', '99')])).toEqual({ kind: 'none' });
  });

  it('transitions immediately when the single-state column is reachable', () => {
    const d = transitionChoiceForDrop(target, [t('11', '3'), t('12', '99')]);
    expect(d.kind).toBe('auto');
    expect(d.kind === 'auto' && d.transition.id).toBe('11');
  });

  // Parity with the Jira mirror: a column mapping several states still de-duplicates
  // parallel arrows and asks. (Linear columns are single-state in practice.)
  it('asks when several states are reachable, de-duplicating parallel arrows', () => {
    const multi = col(1, 'In Progress', ['3', '4']);
    const d = transitionChoiceForDrop(multi, [t('11', '3'), t('11b', '3'), t('12', '4')]);
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

  it('skips the status question entirely for a ticket already started', () => {
    const d = launchDefaults(issue({ stateCategory: 'indeterminate' }), null, projects, [t('11', '3')]);
    expect(d.askStatus).toBe(false);
    expect(d.transitionId).toBeUndefined();
  });

  it('preselects the first transition into a started state otherwise', () => {
    const d = launchDefaults(issue({ stateCategory: 'new' }), null, projects, [
      t('10', '5', 'done'),
      t('11', '3', 'indeterminate'),
    ]);
    expect(d.askStatus).toBe(true);
    expect(d.transitionId).toBe('11');
  });
});

describe('subtasksOf', () => {
  it('returns direct children even when their state is unmapped', () => {
    const issues = [
      issue({ issueId: 'a', key: 'ENG-2', parentKey: 'ENG-1' }),
      issue({ issueId: 'b', key: 'ENG-3', parentKey: 'ENG-9' }),
    ];
    expect(subtasksOf(issues, 'ENG-1').map((i) => i.key)).toEqual(['ENG-2']);
  });
});

describe('dateChip', () => {
  it('formats start and due as DD.MM, blank when Linear lacks one', () => {
    const both = dateChip(issue({ startDate: '2026-09-01', dueDate: '2026-09-12' }), '2026-09-02')!;
    expect(both.start).toBe('01.09');
    expect(both.due).toBe('12.09');
    expect(dateChip(issue({ dueDate: '2026-09-12' }), '2026-09-02')!).toMatchObject({ start: '', due: '12.09' });
    expect(dateChip(issue({ startDate: '2026-09-01' }), '2026-09-02')!).toMatchObject({ start: '01.09', due: '' });
  });

  it('has nothing to say about a ticket with no dates', () => {
    expect(dateChip(issue({}), '2026-09-02')).toBeUndefined();
  });

  it('calls a passed due date overdue, today soon, and a future one plain', () => {
    expect(dateChip(issue({ dueDate: '2026-09-01' }), '2026-09-02')!.tone).toBe('overdue');
    expect(dateChip(issue({ dueDate: '2026-09-02' }), '2026-09-02')!.tone).toBe('soon');
    expect(dateChip(issue({ dueDate: '2026-09-03' }), '2026-09-02')!.tone).toBe('plain');
  });

  // The whole point of reading stateCategory: finished work cannot be late any more (Linear
  // maps both completed and canceled to the «done» category).
  it('never calls a done ticket overdue, however long its due date has passed', () => {
    expect(dateChip(issue({ dueDate: '2020-01-01', stateCategory: 'done' }), '2026-09-02')!.tone).toBe('plain');
  });

  it('leaves a start-only ticket plain even when that start is long past', () => {
    expect(dateChip(issue({ startDate: '2020-01-01' }), '2026-09-02')!.tone).toBe('plain');
  });
});

describe('todayIso', () => {
  it('spells the LOCAL day without a UTC shift', () => {
    expect(todayIso(new Date(2026, 8, 2, 0, 30))).toBe('2026-09-02');
    expect(todayIso(new Date(2026, 0, 9, 23, 45))).toBe('2026-01-09');
  });
});
