import { describe, expect, test } from 'vitest';
import type { DocsReport, SessionReport } from '@kermanych/core';
import { changedDocsView, ownReports, unionInOrder } from '../src/lib/session-reports';

// How «Агенти» reads the card's reports back (spec 2026-10-12, decision 10). Each rule here is
// the difference between a tab that survives a restart and one that shows another run's data
// or a row that opens onto `session has no worktree`.

const docs = (sessionId: string, changed: DocsReport['changed'] = []): DocsReport => ({
  sessionId,
  generatedAt: '2026-10-12T10:00:00.000Z',
  read: ['docs/specs/a.md'],
  changed,
});
const session = (sessionId: string): SessionReport => ({
  sessionId,
  generatedAt: '2026-10-12T10:00:00.000Z',
  runtime: 'omp',
  native: false,
  branch: 'feature/x',
  worktree: true,
  skills: ['librarian'],
});

describe('ownReports', () => {
  test("a relaunch's reports are not shown under the earlier session", () => {
    expect(ownReports({ docsReport: docs('s2'), sessionReport: session('s2') }, 's1')).toEqual({});
  });

  test('each report is judged on its own session id', () => {
    const r = ownReports({ docsReport: docs('s1'), sessionReport: session('s2') }, 's1');
    expect(r.docs?.sessionId).toBe('s1');
    expect(r.session).toBeUndefined();
  });
});

describe('unionInOrder', () => {
  test('the card first, then what only the transcript has, each path once', () => {
    expect(unionInOrder(['b.md', 'a.md'], ['a.md', 'c.md', 'b.md'])).toEqual(['b.md', 'a.md', 'c.md']);
  });

  test('a dormant session with no card report keeps the live list', () => {
    expect(unionInOrder(undefined, ['a.md'])).toEqual(['a.md']);
  });
});

describe('changedDocsView', () => {
  const card = [{ path: 'docs/specs/old.md', added: 3, removed: 1 }];
  const live = [
    { path: 'docs/specs/new.md', added: 5, removed: 0 },
    { path: 'src/main.ts', added: 9, removed: 2 },
  ];

  test('a finished session shows the card list, list-only, even with a stale listing in memory', () => {
    expect(changedDocsView({ finished: true, liveFiles: live, card })).toEqual({ docs: card, listOnly: true });
  });

  test('while the worktree exists the live listing wins, filtered to documentation', () => {
    expect(changedDocsView({ finished: false, liveFiles: live, card })).toEqual({
      docs: [live[0]],
      listOnly: false,
    });
  });

  test('an empty live listing means the documents were reverted, not «use the card»', () => {
    expect(changedDocsView({ finished: false, liveFiles: [], card }).docs).toEqual([]);
  });

  test('the card list stands in until the first listing arrives, rows still expandable', () => {
    expect(changedDocsView({ finished: false, liveFiles: null, card })).toEqual({ docs: card, listOnly: false });
  });
});
