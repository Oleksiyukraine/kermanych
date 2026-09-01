import { describe, it, expect } from 'vitest';
import type { Session } from '@kermanych/core';
import { searchSessions } from '../src/lib/session-search';

// Minimal session rows: only the two strings the search reads (name, branch).
function session(over: Partial<Session> & { id: string }): Session {
  return {
    projectId: 'p1',
    name: over.id,
    task: '',
    worktreePath: '',
    branch: '',
    worktree: false,
    kind: 'agent',
    status: 'thinking',
    createdAt: '2026-08-27T10:00:00.000Z',
    ...over,
  } as Session;
}

describe('searchSessions', () => {
  const byName = session({ id: 'a', name: 'Refactor codebase', branch: 'kermanych/refactor' });
  const byBranch = session({ id: 'b', name: 'Add archive button', branch: 'kermanych/add-archive-btn' });
  const neither = session({ id: 'c', name: 'Secrets page', branch: 'kermanych/ass-secrets-page' });
  const rows = [byName, byBranch, neither];

  it('returns the same array untouched for a blank or whitespace query', () => {
    expect(searchSessions(rows, '')).toBe(rows);
    expect(searchSessions(rows, '   ')).toBe(rows);
  });

  it('matches on the name, case-insensitively', () => {
    expect(searchSessions(rows, 'CODEBASE')).toEqual([byName]);
  });

  it('matches on the branch when the name does not', () => {
    expect(searchSessions(rows, 'add-archive')).toEqual([byBranch]);
  });

  it('keeps every row whose name OR branch contains the query', () => {
    // «page» is in `neither`'s name and nowhere else; «kermanych» is in every branch.
    expect(searchSessions(rows, 'page')).toEqual([neither]);
    expect(searchSessions(rows, 'kermanych')).toEqual(rows);
  });

  it('trims the query before matching', () => {
    expect(searchSessions(rows, '  codebase  ')).toEqual([byName]);
  });

  it('returns an empty list when nothing matches', () => {
    expect(searchSessions(rows, 'zzz-no-such-thing')).toEqual([]);
  });
});
