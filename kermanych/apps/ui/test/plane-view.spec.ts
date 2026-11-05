import { describe, expect, it } from 'vitest';
import {
  assigneeOptions,
  dateChip,
  filterByAssignee,
  filterIssues,
  formatDuration,
  integrationForKey,
  issuesByColumn,
  launchDefaults,
  parsePlaneAddress,
  planeIssueUrl,
  priorityTone,
  priorityValue,
  subtasksOf,
  transitionChoiceForDrop,
  UNASSIGNED,
  type PlaneTransitionView,
} from '../src/lib/plane-view';
import type { PlaneColumn, PlaneIntegration, PlaneIssue } from '@kermanych/cloud';

const col = (position: number, name: string, stateIds: string[]): PlaneColumn => ({
  integrationId: 'i1',
  workspaceId: 'w1',
  position,
  name,
  stateIds,
  stateGroup: 'unstarted',
  color: '#999999',
});

function issue(over: Partial<PlaneIssue>): PlaneIssue {
  return {
    integrationId: 'i1',
    workspaceId: 'w1',
    issueId: '1',
    key: 'WEB-1',
    summary: 's',
    descriptionHtml: '',
    typeName: '',
    priority: 'none',
    labels: [],
    estimate: '',
    originalEstimateSeconds: 0,
    timeSpent: '',
    timeSpentSeconds: 0,
    startDate: '',
    dueDate: '',
    statusId: 'todo',
    statusName: 'Todo',
    statusCategory: 'new',
    planeUpdatedAt: '2026-11-01T00:00:00.000Z',
    updatedAt: '2026-11-01T00:00:00.000Z',
    ...over,
  };
}

function integration(over: Partial<PlaneIntegration>): PlaneIntegration {
  return {
    id: 'i1',
    workspaceId: 'w1',
    siteUrl: 'https://app.plane.so',
    workspaceSlug: 'my-team',
    projectId: 'p-uuid',
    projectIdentifier: 'WEB',
    projectName: 'Website',
    createdAt: '2026-11-01T00:00:00.000Z',
    updatedAt: '2026-11-01T00:00:00.000Z',
    ...over,
  };
}

const state = (id: string, key = 'indeterminate', name = `S${id}`): PlaneTransitionView => ({
  id,
  name,
  to: { id, name, statusCategory: { key } },
});

describe('filterIssues', () => {
  it('returns the input array itself when nothing is typed', () => {
    const issues = [issue({ issueId: 'a' })];
    expect(filterIssues(issues, '  ')).toBe(issues);
  });

  it('requires every token to match, and lets tokens land in different fields', () => {
    const issues = [
      issue({ issueId: 'a', summary: 'Fix the sandbox', assigneeName: 'Андрій' }),
      issue({ issueId: 'b', summary: 'Fix the login', assigneeName: 'Андрій' }),
      issue({ issueId: 'c', summary: 'Fix the sandbox', assigneeName: 'Олексій' }),
    ];
    expect(filterIssues(issues, 'sandbox андрій').map((i) => i.issueId)).toEqual(['a']);
  });

  it('matches the key, a label, the priority and the estimate', () => {
    const issues = [
      issue({ issueId: 'a', key: 'WEB-42', labels: ['backend'], priority: 'urgent', estimate: 'XL' }),
      issue({ issueId: 'b', key: 'WEB-7', labels: ['design'], priority: 'low', estimate: 'S' }),
    ];
    expect(filterIssues(issues, 'web-42').map((i) => i.issueId)).toEqual(['a']);
    expect(filterIssues(issues, 'backend').map((i) => i.issueId)).toEqual(['a']);
    expect(filterIssues(issues, 'urgent').map((i) => i.issueId)).toEqual(['a']);
    expect(filterIssues(issues, 'xl').map((i) => i.issueId)).toEqual(['a']);
  });

  // Plane's editor HTML would match markup: «div» or «href» would hit every formatted item.
  it('does not match the description markup', () => {
    const issues = [issue({ issueId: 'a', descriptionHtml: '<div class="tricky">body</div>' })];
    expect(filterIssues(issues, 'div')).toEqual([]);
  });
});

describe('assignee filter', () => {
  it('offers each person holding a card once, sorted by name, and none for the unassigned', () => {
    const issues = [
      issue({ issueId: 'a', assigneeAccountId: 'u2', assigneeName: 'Олексій' }),
      issue({ issueId: 'b', assigneeAccountId: 'u1', assigneeName: 'Андрій' }),
      issue({ issueId: 'c', assigneeAccountId: 'u1', assigneeName: 'Андрій' }),
      issue({ issueId: 'd' }),
    ];
    expect(assigneeOptions(issues)).toEqual([
      { id: 'u1', name: 'Андрій' },
      { id: 'u2', name: 'Олексій' },
    ]);
  });

  it('keeps the picked person’s cards, or only the unassigned ones', () => {
    const issues = [
      issue({ issueId: 'a', assigneeAccountId: 'u1', assigneeName: 'Андрій' }),
      issue({ issueId: 'b', assigneeAccountId: 'u2', assigneeName: 'Олексій' }),
      issue({ issueId: 'c' }),
    ];
    expect(filterByAssignee(issues, '')).toBe(issues);
    expect(filterByAssignee(issues, 'u1').map((i) => i.issueId)).toEqual(['a']);
    expect(filterByAssignee(issues, UNASSIGNED).map((i) => i.issueId)).toEqual(['c']);
  });
});

describe('issuesByColumn', () => {
  const columns = [col(0, 'Todo', ['todo']), col(1, 'In Progress', ['doing'])];

  // Triage is not in Plane's states list, so an item in it has no column — as on Plane's board.
  it('groups by state and leaves an item in a column-less state off the board', () => {
    const grouped = issuesByColumn(columns, [
      issue({ issueId: 'a', statusId: 'todo' }),
      issue({ issueId: 'b', statusId: 'doing' }),
      issue({ issueId: 'c', statusId: 'triage' }),
    ]);
    expect(grouped[0]!.map((i) => i.issueId)).toEqual(['a']);
    expect(grouped[1]!.map((i) => i.issueId)).toEqual(['b']);
  });

  it('orders a column by newest Plane activity first', () => {
    const grouped = issuesByColumn(columns, [
      issue({ issueId: 'old', planeUpdatedAt: '2026-11-01T00:00:00.000Z' }),
      issue({ issueId: 'new', planeUpdatedAt: '2026-11-02T00:00:00.000Z' }),
    ]);
    expect(grouped[0]!.map((i) => i.issueId)).toEqual(['new', 'old']);
  });
});

describe('transitionChoiceForDrop', () => {
  // A state removed in Plane since the last sweep: the column is stale, not forbidden.
  it('refuses when the column’s state is not on offer', () => {
    expect(transitionChoiceForDrop(col(1, 'Gone', ['gone']), [state('todo'), state('doing')])).toEqual({ kind: 'none' });
  });

  it('moves at once into a single-state column', () => {
    const d = transitionChoiceForDrop(col(1, 'In Progress', ['doing']), [state('todo'), state('doing')]);
    expect(d.kind === 'auto' && d.transition.id).toBe('doing');
  });
});

describe('launchDefaults', () => {
  const projects = [{ id: 'p1' }, { id: 'p2' }];

  it('prefers the remembered binding, then the sidebar scope, then a sole project', () => {
    expect(launchDefaults(issue({ kermanychProjectId: 'p2' }), 'p1', projects, []).projectId).toBe('p2');
    expect(launchDefaults(issue({ kermanychProjectId: 'gone' }), 'p1', projects, []).projectId).toBe('p1');
    expect(launchDefaults(issue({}), null, [{ id: 'only' }], []).projectId).toBe('only');
    expect(launchDefaults(issue({}), null, projects, []).projectId).toBeUndefined();
  });

  it('does not move an item already in a started state', () => {
    const d = launchDefaults(issue({ statusCategory: 'indeterminate' }), null, projects, [state('doing')]);
    expect(d.askStatus).toBe(false);
    expect(d.transitionId).toBeUndefined();
  });

  it('preselects the first started state otherwise', () => {
    const d = launchDefaults(issue({ statusCategory: 'new' }), null, projects, [
      state('done', 'done'),
      state('doing', 'indeterminate'),
    ]);
    expect(d.askStatus).toBe(true);
    expect(d.transitionId).toBe('doing');
  });
});

describe('subtasksOf', () => {
  it('returns direct children only', () => {
    const issues = [
      issue({ issueId: 'a', key: 'WEB-2', parentKey: 'WEB-1' }),
      issue({ issueId: 'b', key: 'WEB-3', parentKey: 'WEB-9' }),
    ];
    expect(subtasksOf(issues, 'WEB-1').map((i) => i.key)).toEqual(['WEB-2']);
  });
});

describe('integrationForKey', () => {
  const rows = [integration({ id: 'web', projectIdentifier: 'WEB' }), integration({ id: 'api', projectIdentifier: 'API2' })];

  it('resolves the project by the key’s identifier', () => {
    expect(integrationForKey(rows, 'WEB-42')?.id).toBe('web');
    expect(integrationForKey(rows, 'API2-7')?.id).toBe('api');
  });

  // The merge prompt then has nothing to move, rather than moving it on the wrong project.
  it('answers nothing for a disconnected project or a key without a sequence', () => {
    expect(integrationForKey(rows, 'OPS-1')).toBeUndefined();
    expect(integrationForKey(rows, 'WEB')).toBeUndefined();
  });
});

describe('planeIssueUrl', () => {
  it('links Plane Cloud through app.plane.so, whichever Cloud host was stored', () => {
    expect(planeIssueUrl(integration({ siteUrl: 'https://app.plane.so' }), 'WEB-42')).toBe(
      'https://app.plane.so/my-team/browse/WEB-42/',
    );
    expect(planeIssueUrl(integration({ siteUrl: 'https://api.plane.so' }), 'WEB-42')).toBe(
      'https://app.plane.so/my-team/browse/WEB-42/',
    );
  });

  it('links a self-hosted instance through its own origin', () => {
    expect(planeIssueUrl(integration({ siteUrl: 'https://plane.acme.io/' }), 'WEB-1')).toBe(
      'https://plane.acme.io/my-team/browse/WEB-1/',
    );
  });
});

describe('parsePlaneAddress', () => {
  it('reads the site and the workspace out of a pasted workspace URL', () => {
    expect(parsePlaneAddress('https://app.plane.so/my-team/projects/')).toEqual({
      site: 'https://app.plane.so',
      slug: 'my-team',
    });
    expect(parsePlaneAddress('plane.acme.io/eng/browse/WEB-1/')).toEqual({ site: 'https://plane.acme.io', slug: 'eng' });
  });

  it('maps every Plane Cloud host to the web app and leaves a bare origin without a slug', () => {
    expect(parsePlaneAddress('plane.so')).toEqual({ site: 'https://app.plane.so', slug: '' });
    expect(parsePlaneAddress('http://localhost:3000')).toEqual({ site: 'http://localhost:3000', slug: '' });
  });

  // Plane's own top-level pages are not workspaces, whatever the paste.
  it('does not take a Plane page for a workspace', () => {
    expect(parsePlaneAddress('https://app.plane.so/profile/')?.slug).toBe('');
    expect(parsePlaneAddress('https://app.plane.so/god-mode/')?.slug).toBe('');
  });

  it('refuses what is not an address', () => {
    expect(parsePlaneAddress('')).toBeNull();
    expect(parsePlaneAddress('my team')).toBeNull();
    expect(parsePlaneAddress('ftp://plane.acme.io')).toBeNull();
  });
});

describe('priority', () => {
  it('reads an unknown value as no priority, so the card carries no mark', () => {
    expect(priorityValue('urgent')).toBe('urgent');
    expect(priorityValue('blocker')).toBe('none');
    expect(priorityTone('blocker')).toBeUndefined();
    expect(priorityTone('none')).toBeUndefined();
  });

  it('makes urgent the loud one and tapers off below it', () => {
    expect(['urgent', 'high', 'medium', 'low'].map(priorityTone)).toEqual(['danger', 'warning', 'accent', 'faint']);
  });
});

describe('dateChip', () => {
  it('calls a passed target date overdue, today soon, and a future one plain', () => {
    expect(dateChip(issue({ dueDate: '2026-11-01' }), '2026-11-02')!.tone).toBe('overdue');
    expect(dateChip(issue({ dueDate: '2026-11-02' }), '2026-11-02')!.tone).toBe('soon');
    expect(dateChip(issue({ dueDate: '2026-11-03' }), '2026-11-02')!.tone).toBe('plain');
  });

  // Completed and cancelled both map to `done`: finished work cannot be late any more.
  it('never calls a done item overdue', () => {
    expect(dateChip(issue({ dueDate: '2020-01-01', statusCategory: 'done' }), '2026-11-02')!.tone).toBe('plain');
  });

  it('formats start and target as DD.MM and has nothing to say without dates', () => {
    expect(dateChip(issue({ startDate: '2026-11-01', dueDate: '2026-11-12' }), '2026-11-02')).toMatchObject({
      start: '01.11',
      due: '12.11',
    });
    expect(dateChip(issue({}), '2026-11-02')).toBeUndefined();
  });
});

describe('formatDuration', () => {
  // The edit form is prefilled with this, so it must be a spelling the worklog field takes.
  it('spells seconds as hours and minutes the worklog field accepts back', () => {
    expect(formatDuration(45 * 60)).toBe('45m');
    expect(formatDuration(3 * 3600)).toBe('3h');
    expect(formatDuration(3 * 3600 + 20 * 60)).toBe('3h 20m');
    // Plane counts whole minutes; hours are not folded into days.
    expect(formatDuration(10 * 3600 + 29)).toBe('10h');
  });

  it('is blank for nothing logged', () => {
    expect(formatDuration(0)).toBe('');
    expect(formatDuration(20)).toBe('');
  });
});
