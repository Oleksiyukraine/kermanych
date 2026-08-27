import { describe, expect, it } from 'vitest';
import type { CloudProject, Task, Workspace } from '@kermanych/cloud';
import {
  UNASSIGNED,
  canDropProject,
  filterTasks,
  groupProjectsByWorkspace,
  projectWorkspaceMap,
  scopedProjectIds,
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

  it('falls back to every project for a workspace it does not know', () => {
    expect(scopedProjectIds({ workspaceId: 'w-gone' }, projects)).toEqual([]);
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
