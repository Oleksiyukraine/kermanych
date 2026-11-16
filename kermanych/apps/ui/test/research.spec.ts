import { describe, expect, it } from 'vitest';
import type { Project, Session } from '@kermanych/core';
import { researchHomeProject, researchScopeIds, researchTitle, researchesIn } from '../src/lib/research';

function session(over: Partial<Session>): Session {
  return {
    id: 's',
    projectId: 'p1',
    name: 'дослідження 1',
    task: '',
    worktreePath: '',
    worktree: false,
    branch: '',
    kind: 'chat',
    status: 'done',
    createdAt: '2026-11-16T10:00:00.000Z',
    lastActivityAt: '2026-11-16T10:00:00.000Z',
    ...over,
  };
}
function project(id: string, localRepoPath: string): Project {
  return { id, name: id, localRepoPath, createdAt: '2026-11-16T10:00:00.000Z' };
}

const noCloud = { projects: [], listRead: false };

describe('researchScopeIds', () => {
  it('spans the whole workspace even with one of its projects selected', () => {
    const map = { p1: 'w1', p2: 'w1', p3: 'w2' };
    expect(researchScopeIds({ workspaceId: 'w1', projectId: 'p1' }, noCloud, map).sort()).toEqual(['p1', 'p2']);
  });

  it('is the project alone when it has no workspace', () => {
    expect(researchScopeIds({ projectId: 'local' }, noCloud, { p1: 'w1' })).toEqual(['local']);
  });

  it('is empty with nothing selected', () => {
    expect(researchScopeIds({}, noCloud, { p1: 'w1' })).toEqual([]);
  });
});

describe('researchesIn', () => {
  it('keeps live researches of the scope, newest activity first', () => {
    const list = researchesIn(
      [
        session({ id: 'old', lastActivityAt: '2026-11-16T09:00:00.000Z' }),
        session({ id: 'new', projectId: 'p2', lastActivityAt: '2026-11-16T11:00:00.000Z' }),
        session({ id: 'archived', archived: true }),
        session({ id: 'agent', kind: 'agent' }),
        session({ id: 'elsewhere', projectId: 'p9' }),
      ],
      ['p1', 'p2'],
    );
    expect(list.map((s) => s.id)).toEqual(['new', 'old']);
  });
});

describe('researchHomeProject', () => {
  const projects = [project('p1', ''), project('p2', '/repo/p2'), project('p3', '/repo/p3')];

  it('prefers the selected project when it is bound', () => {
    expect(researchHomeProject(projects, ['p1', 'p2', 'p3'], 'p3', 'p2')?.id).toBe('p3');
  });

  it('falls back to the open research’s project, then the first bound one of the scope', () => {
    expect(researchHomeProject(projects, ['p1', 'p2', 'p3'], 'p1', 'p3')?.id).toBe('p3');
    expect(researchHomeProject(projects, ['p1', 'p2', 'p3'], 'p1', undefined)?.id).toBe('p2');
  });

  it('is none when no project of the scope is bound here', () => {
    expect(researchHomeProject(projects, ['p1'], 'p1', undefined)).toBeUndefined();
  });
});

describe('researchTitle', () => {
  it('uses the opening question while the name is the server default', () => {
    expect(researchTitle({ name: 'дослідження 3', task: 'Як працює кеш?\nдеталі' })).toBe('Як працює кеш?');
    expect(researchTitle({ name: 'чат 2', task: 'Де живуть міграції' })).toBe('Де живуть міграції');
  });

  it('keeps an operator’s own name', () => {
    expect(researchTitle({ name: 'Кеш', task: 'Як працює кеш?' })).toBe('Кеш');
  });

  it('keeps the default name before the first question', () => {
    expect(researchTitle({ name: 'дослідження 3', task: '' })).toBe('дослідження 3');
  });
});
