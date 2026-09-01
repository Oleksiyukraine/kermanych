import { describe, it, expect } from 'vitest';
import type { Session } from '@kermanych/core';
import { bucketOf } from '../src/lib/buckets';

// Minimal session rows: only the fields the bucket rule reads.
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

// The resolver both readers pass: a lookup over the sessions that exist.
function resolver(...rows: Session[]) {
  const byId = new Map(rows.map((s) => [s.id, s]));
  return (id: string) => byId.get(id);
}

describe('bucketOf', () => {
  it('files an agent by its own state, completed first', () => {
    const live = session({ id: 'a', status: 'thinking' });
    const backlog = session({ id: 'b', status: 'backlog', kind: 'task' });
    const merged = session({ id: 'c', status: 'merged' });
    const aside = session({ id: 'd', status: 'done', archived: true });
    const find = resolver(live, backlog, merged, aside);
    expect(bucketOf(live, find)).toBe('active');
    expect(bucketOf(backlog, find)).toBe('tasks');
    expect(bucketOf(merged, find)).toBe('completed');
    expect(bucketOf(aside, find)).toBe('completed');
  });

  it('files a finished-but-unclosed agent as waiting', () => {
    const done = session({ id: 'a', status: 'done' });
    const stopped = session({ id: 'b', status: 'stopped' });
    const find = resolver(done, stopped);
    expect(bucketOf(done, find)).toBe('waiting');
    expect(bucketOf(stopped, find)).toBe('waiting');
  });

  it('files an agent needing attention under errors', () => {
    const err = session({ id: 'a', status: 'error' });
    const conflict = session({ id: 'b', status: 'conflict' });
    const find = resolver(err, conflict);
    expect(bucketOf(err, find)).toBe('errors');
    expect(bucketOf(conflict, find)).toBe('errors');
  });

  // The point of the rule: branchSession settles a fresh fork at `done` immediately, so on
  // its own status every branch would leave its live parent's bucket the moment it is made.
  it('keeps a settled fork in its live parent bucket', () => {
    const parent = session({ id: 'p', status: 'waiting_input' });
    const fork = session({ id: 'f', status: 'done', kind: 'discussion', parentSessionId: 'p' });
    expect(bucketOf(fork, resolver(parent, fork))).toBe('active');
  });

  it('follows the parent out of Активні when it settles', () => {
    const parent = session({ id: 'p', status: 'merged' });
    const fork = session({ id: 'f', status: 'thinking', kind: 'review', parentSessionId: 'p' });
    expect(bucketOf(fork, resolver(parent, fork))).toBe('completed');
  });

  it('follows the parent into Завершені', () => {
    const parent = session({ id: 'p', status: 'done', archived: true });
    const fork = session({ id: 'f', status: 'done', kind: 'discussion', parentSessionId: 'p' });
    expect(bucketOf(fork, resolver(parent, fork))).toBe('completed');
  });

  // A fork outlives its parent only if a delete raced the socket update; it must still be
  // reachable in some bucket rather than dropping out of every list.
  it('falls back to its own status when the parent is gone', () => {
    const fork = session({ id: 'f', status: 'stopped', kind: 'discussion', parentSessionId: 'p' });
    expect(bucketOf(fork, resolver(fork))).toBe('waiting');
  });
});
