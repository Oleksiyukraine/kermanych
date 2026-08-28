import { describe, expect, it } from 'vitest';
import type { CloudProject, Task, Workspace } from '@kermanych/cloud';
import {
  UNASSIGNED,
  canDropProject,
  filterTasks,
  groupProjectsByWorkspace,
  projectWorkspaceMap,
  scopedProjectIds,
  sessionScopedProjectIds,
} from '../src/lib/scope';

function ws(id: string, name: string, createdAt = '2026-01-01T00:00:00.000Z'): Workspace {
  return { id, name, ownerId: 'u1', createdAt };
}
function proj(id: string, workspaceId: string, name = id): CloudProject {
  return {
    id,
    name,
    workspaceId,
    carryFiles: ['.env'],
    envKeys: [],
    createdAt: '2026-01-01T00:00:00.000Z',
  };
}
function task(id: string, projectId: string, over: Partial<Task> = {}): Task {
  return {
    id,
    projectId,
    title: id,
    status: 'backlog',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...over,
  };
}

describe('groupProjectsByWorkspace', () => {
  // The names deliberately run COUNTER to the ids — 'ZZZ' before 'AAA', and the projects
  // named in reverse of their insertion order — so that cloud order and alphabetical order
  // disagree. Tidying them back into ascending order would silently stop this test from
  // catching a friendly `sort((a, b) => a.name.localeCompare(b.name))` added to the sidebar.
  it('keeps cloud order, not alphabetical order, for groups and for projects inside one', () => {
    const groups = groupProjectsByWorkspace(
      [ws('w1', 'ZZZ'), ws('w2', 'AAA')],
      [proj('p1', 'w2', 'MMM'), proj('p2', 'w1', 'YYY'), proj('p3', 'w1', 'BBB')],
    );
    expect(groups.map((g) => g.workspace.id)).toEqual(['w1', 'w2']);
    expect(groups[0]!.projects.map((p) => p.id)).toEqual(['p2', 'p3']);
    expect(groups[1]!.projects.map((p) => p.id)).toEqual(['p1']);
  });

  it('keeps an empty workspace visible so it can be filled or deleted', () => {
    const groups = groupProjectsByWorkspace([ws('w1', 'AAA')], []);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.projects).toEqual([]);
  });

  // A project whose workspace this user cannot see must not be invented into a group:
  // RLS decides which workspaces are visible, and rendering a name that does not exist
  // would be a lie. The sidebar shows such a project in its local-only bucket instead,
  // which MainLayout computes separately.
  it('drops projects whose workspace is not in the list', () => {
    const groups = groupProjectsByWorkspace([ws('w1', 'AAA')], [proj('p1', 'w-gone')]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.projects).toEqual([]);
  });
});

describe('projectWorkspaceMap', () => {
  it('maps project id to workspace id', () => {
    expect(projectWorkspaceMap([proj('p1', 'w1'), proj('p2', 'w2')])).toEqual({ p1: 'w1', p2: 'w2' });
  });
});

describe('scopedProjectIds', () => {
  const projects = [proj('p1', 'w1'), proj('p2', 'w1'), proj('p3', 'w2')];

  it('returns every project when nothing is selected', () => {
    expect(scopedProjectIds({}, projects)).toEqual(['p1', 'p2', 'p3']);
    // '' means "no filter" everywhere in this UI, so it must widen to every project
    // rather than narrow to none — the same convention filterTasks is tested for below.
    expect(scopedProjectIds({ workspaceId: '' }, projects)).toEqual(['p1', 'p2', 'p3']);
  });

  it('narrows to the selected workspace', () => {
    expect(scopedProjectIds({ workspaceId: 'w1' }, projects)).toEqual(['p1', 'p2']);
  });

  // A selected project always carries its workspace, so the scope stays the workspace
  // and the project filter does the narrowing. That keeps «Проєкти» meaningful.
  it('stays at the workspace even when a project is selected', () => {
    expect(scopedProjectIds({ workspaceId: 'w1', projectId: 'p1' }, projects)).toEqual(['p1', 'p2']);
  });

  // A LOCAL-ONLY project: no cloud row, so nothing resolved its workspace and the
  // selection carries only the project. Empty is the exact answer — the cloud holds no
  // task that belongs to a project it does not have — and the answer this replaces was
  // the widest one possible, every project in every visible workspace.
  it('scopes a project with no resolved workspace to nothing', () => {
    expect(scopedProjectIds({ projectId: 'local-only' }, projects)).toEqual([]);
    // '' is "no selection" for the workspace, so the project is what decides here too.
    expect(scopedProjectIds({ workspaceId: '', projectId: 'local-only' }, projects)).toEqual([]);
  });

  // Named for what it asserts. A workspace the cloud list does not mention holds no projects
  // we can name, and `[]` is that answer; the title used to promise the opposite ("falls back
  // to every project"), which is the widening this function was changed to stop doing.
  it('scopes a workspace it does not know to nothing', () => {
    expect(scopedProjectIds({ workspaceId: 'w-gone' }, projects)).toEqual([]);
  });
});

// The Агенти page's scope. Its rows are LOCAL sessions, so the failure mode under test is a
// developer's own running agents not rendering at all.
describe('sessionScopedProjectIds', () => {
  const projects = [proj('p1', 'w1'), proj('p2', 'w1'), proj('p3', 'w2')];
  const map = { p1: 'w1', p2: 'w1', p3: 'w2' };
  const read = { projects, listRead: true };
  // A cold offline start: the tree cache restored the map, the cloud list was never read.
  const unread = { projects: [] as CloudProject[], listRead: false };

  it('shows nothing until something is selected', () => {
    expect(sessionScopedProjectIds({}, read, map)).toEqual([]);
    // Unlike scopedProjectIds, which widens to everything for the same input: the board's
    // unscoped state is a full board, this page's is a blank invitation.
    expect(scopedProjectIds({}, projects)).toEqual(['p1', 'p2', 'p3']);
  });

  it('narrows a workspace to its projects from the cloud list once it is read', () => {
    expect(sessionScopedProjectIds({ workspaceId: 'w1' }, read, map)).toEqual(['p1', 'p2']);
  });

  // The case a project selection exists to answer, and the one scopedProjectIds gets right for
  // the board by getting it backwards for here: a local-only project has no cloud row, so no
  // workspace was resolved for it, and it is exactly where local sessions live.
  it('scopes a LOCAL-ONLY project to itself, not to nothing', () => {
    expect(sessionScopedProjectIds({ projectId: 'local-only' }, read, map)).toEqual(['local-only']);
    expect(scopedProjectIds({ projectId: 'local-only' }, projects)).toEqual([]);
  });

  // A project selection carries its workspace (the store keeps that invariant), and the
  // narrower of the two wins here — the board keeps the workspace instead.
  it('lets a project narrow inside its own workspace', () => {
    expect(sessionScopedProjectIds({ workspaceId: 'w1', projectId: 'p1' }, read, map)).toEqual(['p1']);
  });

  // THE offline branch. An unread list is not an empty cloud: answering `[]` here would hide
  // every running agent on the machine from someone who is merely offline.
  it('falls back to the cached map while the cloud list is unread', () => {
    expect(sessionScopedProjectIds({ workspaceId: 'w1' }, unread, map)).toEqual(['p1', 'p2']);
    expect(sessionScopedProjectIds({ workspaceId: 'w2' }, unread, map)).toEqual(['p3']);
    // What it would have answered without the gate, and why the gate is not decoration.
    expect(scopedProjectIds({ workspaceId: 'w1' }, unread.projects)).toEqual([]);
  });

  // `listRead` and not `projects.length`: create()/publish() append to that array, so one
  // create while Supabase was recovering would make a one-project list look authoritative and
  // scope the page to that single project.
  it('prefers the cached map over a non-empty list that was never read', () => {
    const oneCreated = { projects: [proj('p2', 'w1')], listRead: false };
    expect(sessionScopedProjectIds({ workspaceId: 'w1' }, oneCreated, map)).toEqual(['p1', 'p2']);
  });

  // Offline AND uncached: the map has no entry for this group, so no project can be named.
  // Empty here is honest — the sidebar shows such rows in its «Воркспейс невідомий» bucket.
  it('scopes a workspace the cached map cannot place to nothing', () => {
    expect(sessionScopedProjectIds({ workspaceId: 'w-gone' }, unread, map)).toEqual([]);
    expect(sessionScopedProjectIds({ workspaceId: 'w1' }, unread, {})).toEqual([]);
  });

  // '' means "no selection" throughout this UI, the convention scopedProjectIds is pinned to.
  it('treats an empty id as no selection', () => {
    expect(sessionScopedProjectIds({ workspaceId: '', projectId: '' }, read, map)).toEqual([]);
    expect(sessionScopedProjectIds({ workspaceId: 'w1', projectId: '' }, read, map)).toEqual(['p1', 'p2']);
  });
});

describe('filterTasks', () => {
  const tasks = [
    task('t1', 'p1', { assigneeId: 'u1' }),
    task('t2', 'p1'),
    task('t3', 'p2', { assigneeId: 'u2' }),
    task('t4', 'p3', { assigneeId: 'u1' }),
  ];

  it('keeps only tasks inside the scope', () => {
    const out = filterTasks(tasks, { scopedProjectIds: ['p1', 'p2'] });
    expect(out.map((t) => t.id)).toEqual(['t1', 't2', 't3']);
  });

  it('applies the project filter on top of the scope', () => {
    const out = filterTasks(tasks, { scopedProjectIds: ['p1', 'p2'], projectFilter: 'p2' });
    expect(out.map((t) => t.id)).toEqual(['t3']);
  });

  it('filters by assignee', () => {
    const out = filterTasks(tasks, { scopedProjectIds: ['p1', 'p2', 'p3'], assigneeFilter: 'u1' });
    expect(out.map((t) => t.id)).toEqual(['t1', 't4']);
  });

  it('filters unassigned tasks with the UNASSIGNED sentinel', () => {
    const out = filterTasks(tasks, { scopedProjectIds: ['p1', 'p2'], assigneeFilter: UNASSIGNED });
    expect(out.map((t) => t.id)).toEqual(['t2']);
  });

  // Both filters narrow together: picking a project and then «Не призначено» must
  // intersect, not let the unassigned branch skip the project filter.
  it('intersects the project filter with the unassigned filter', () => {
    const out = filterTasks(tasks, {
      scopedProjectIds: ['p1', 'p2'],
      projectFilter: 'p2',
      assigneeFilter: UNASSIGNED,
    });
    expect(out.map((t) => t.id)).toEqual([]);
  });

  it('treats an empty filter string as no filter', () => {
    const out = filterTasks(tasks, { scopedProjectIds: ['p1'], projectFilter: '', assigneeFilter: '' });
    expect(out.map((t) => t.id)).toEqual(['t1', 't2']);
  });
});

describe('canDropProject', () => {
  const projects = [proj('p1', 'w1'), proj('p2', 'w2')];

  it('refuses a drop onto the workspace the project is already in', () => {
    expect(canDropProject('p1', 'w1', projects)).toBe(false);
  });

  it('allows a drop onto a different workspace', () => {
    expect(canDropProject('p1', 'w2', projects)).toBe(true);
  });

  it('refuses when nothing is being dragged or the project is unknown', () => {
    expect(canDropProject(undefined, 'w2', projects)).toBe(false);
    expect(canDropProject('p-gone', 'w2', projects)).toBe(false);
  });
});
