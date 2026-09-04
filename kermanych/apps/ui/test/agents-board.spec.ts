import { describe, expect, it } from 'vitest';
import type { Session } from '@kermanych/core';
import type { Task } from '@kermanych/cloud';
import {
  byNewestSession,
  byNewestTask,
  filterSessions,
  filterTaskCards,
  newestActivityAt,
} from '../src/lib/agents-board';

function session(over: Partial<Session> & { id: string }): Session {
  return {
    projectId: 'p1',
    name: over.id,
    task: '',
    worktreePath: '',
    branch: '',
    worktree: true,
    kind: 'agent',
    status: 'thinking',
    createdAt: '2026-08-30T10:00:00.000Z',
    lastActivityAt: '2026-08-30T10:00:00.000Z',
    ...over,
  } as Session;
}

function card(over: Partial<Task> & { id: string }): Task {
  return {
    projectId: 'p1',
    title: over.id,
    status: 'backlog',
    worktree: true,
    hidden: false,
    createdAt: '2026-08-30T10:00:00.000Z',
    updatedAt: '2026-08-30T10:00:00.000Z',
    ...over,
  } as Task;
}

describe('filterSessions', () => {
  const rows = [
    session({ id: 's1', name: 'Login form', branch: 'feature/auth-login', model: 'claude-opus-5' }),
    session({ id: 's2', name: 'Invoices export', branch: 'fix/csv', task: 'export invoices to CSV' }),
  ];

  // The resting state is «nothing typed yet», and this runs on every keystroke: the input
  // array itself comes back, so an untouched box costs no copy and no re-render downstream.
  it('returns the very same array for an empty query', () => {
    expect(filterSessions(rows, '   ')).toBe(rows);
  });

  // Tokens are ANDed across the whole row, so two words may land in different fields — the
  // property that makes «auth opus» a usable query over a column of thirty cards.
  it('requires every token, in any field and any order', () => {
    expect(filterSessions(rows, 'auth opus').map((s) => s.id)).toEqual(['s1']);
    expect(filterSessions(rows, 'opus auth').map((s) => s.id)).toEqual(['s1']);
    expect(filterSessions(rows, 'auth csv')).toHaveLength(0);
  });

  // The brief is searched because it is the operator's own text: «what did I ask that agent
  // to do» is answerable from the card's title only when the title happens to say it.
  it('matches the launch brief and ignores case', () => {
    expect(filterSessions(rows, 'INVOICES').map((s) => s.id)).toEqual(['s2']);
    expect(filterSessions(rows, 'to csv').map((s) => s.id)).toEqual(['s2']);
  });
});

describe('filterTaskCards', () => {
  const cards = [
    card({ id: 'c1', title: 'Publish the changelog', description: 'release notes for 0.4' }),
    card({ id: 'c2', title: 'Fix the CSV export', branch: 'main' }),
  ];

  it('matches title and description', () => {
    expect(filterTaskCards(cards, 'changelog').map((c) => c.id)).toEqual(['c1']);
    expect(filterTaskCards(cards, 'release 0.4').map((c) => c.id)).toEqual(['c1']);
    expect(filterTaskCards(cards, 'csv').map((c) => c.id)).toEqual(['c2']);
  });

  // `branch` on a card is its BASE branch, seeded from the project default — every card in
  // a project carries the same one, so matching it would make «main» select the whole inbox.
  it('does not search the base branch', () => {
    expect(filterTaskCards(cards, 'main')).toHaveLength(0);
  });
});

describe('byNewestSession', () => {
  // The list's promise: freshest at the top. Activity, not creation — a long-running agent
  // that just reported a tool call is what the operator is looking at.
  it('orders by activity, newest first', () => {
    const rows = [
      session({ id: 'old', lastActivityAt: '2026-08-30T09:00:00.000Z' }),
      session({ id: 'new', lastActivityAt: '2026-08-30T12:00:00.000Z' }),
      session({ id: 'mid', lastActivityAt: '2026-08-30T11:00:00.000Z' }),
    ];
    expect([...rows].sort(byNewestSession).map((s) => s.id)).toEqual(['new', 'mid', 'old']);
  });

  // Same millisecond (a batch launch) — creation breaks the tie, so the order is stable
  // instead of depending on where the rows happened to sit in the store.
  it('breaks an activity tie by creation time', () => {
    const at = '2026-08-30T12:00:00.000Z';
    const rows = [
      session({ id: 'first', lastActivityAt: at, createdAt: '2026-08-30T08:00:00.000Z' }),
      session({ id: 'second', lastActivityAt: at, createdAt: '2026-08-30T09:00:00.000Z' }),
    ];
    expect([...rows].sort(byNewestSession).map((s) => s.id)).toEqual(['second', 'first']);
  });

  // A row whose stamp cannot be read sorts as the epoch — last — rather than returning NaN
  // from the comparator, which would leave the whole column in arbitrary order.
  it('sinks an unreadable timestamp instead of poisoning the sort', () => {
    const rows = [
      session({ id: 'broken', lastActivityAt: 'not a date', createdAt: 'not a date' }),
      session({ id: 'ok', lastActivityAt: '2026-08-30T09:00:00.000Z' }),
    ];
    expect([...rows].sort(byNewestSession).map((s) => s.id)).toEqual(['ok', 'broken']);
  });
});

describe('byNewestTask', () => {
  // Cards come from Postgres, sessions from the api's toISOString(): the two text forms
  // differ in the fraction and the zone suffix, and «+00:00» sorts before «.123Z» as text.
  // Parsing is what makes the order chronological rather than lexicographic.
  it('orders Postgres timestamps chronologically, not lexicographically', () => {
    const rows = [
      card({ id: 'older', updatedAt: '2026-08-30T12:00:00+00:00' }),
      card({ id: 'newer', updatedAt: '2026-08-30T12:00:00.500+00:00' }),
    ];
    expect([...rows].sort(byNewestTask).map((c) => c.id)).toEqual(['newer', 'older']);
  });
});

describe('newestActivityAt', () => {
  // Group ordering under a workspace scope: a project leads on its freshest row, so the
  // groups keep the same promise the rows inside them do.
  it('takes the freshest row of the group, and the epoch for an empty one', () => {
    expect(
      newestActivityAt([
        session({ id: 'a', lastActivityAt: '2026-08-30T09:00:00.000Z' }),
        session({ id: 'b', lastActivityAt: '2026-08-30T14:00:00.000Z' }),
      ]),
    ).toBe(Date.parse('2026-08-30T14:00:00.000Z'));
    expect(newestActivityAt([])).toBe(0);
  });
});
