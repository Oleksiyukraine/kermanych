import { describe, it, expect } from 'vitest';
import type { Session } from '@kermanych/core';
import { attentionByProject, attentionOutside, flagsError, isUnseen, isYourTurnEvent, levelOf, sumAttention, yourTurnCount, NO_ATTENTION } from '../src/lib/attention';

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
    createdAt: '2026-09-29T10:00:00.000Z',
    lastActivityAt: '2026-09-29T10:00:00.000Z',
    ...over,
  } as Session;
}

const allUnseen = (): boolean => true;
const noneUnseen = (): boolean => false;

describe('levelOf', () => {
  it('ranks a question first, live agents above an error, an error above an unread result', () => {
    expect(levelOf({ input: 1, error: 1, running: 3, result: 2 })).toBe('input');
    expect(levelOf({ input: 0, error: 1, running: 3, result: 2 })).toBe('running');
    expect(levelOf({ input: 0, error: 1, running: 0, result: 2 })).toBe('error');
    expect(levelOf({ input: 0, error: 0, running: 0, result: 2 })).toBe('result');
    expect(levelOf(NO_ATTENTION)).toBe('idle');
  });
});

describe('flagsError', () => {
  it('keeps an error visible on the pill that outranks it', () => {
    expect(flagsError({ ...NO_ATTENTION, error: 1, running: 1 })).toBe(true);
    expect(flagsError({ ...NO_ATTENTION, error: 1, input: 1 })).toBe(true);
  });

  it('does not flag when the error is the mark itself or there is none', () => {
    expect(flagsError({ ...NO_ATTENTION, error: 1, result: 2 })).toBe(false);
    expect(flagsError({ ...NO_ATTENTION, running: 3 })).toBe(false);
  });
});

describe('attentionByProject', () => {
  it('tallies each state per project', () => {
    const map = attentionByProject(
      [
        session({ id: 'a', status: 'waiting_input' }),
        session({ id: 'b', status: 'tool' }),
        session({ id: 'c', status: 'queued' }),
        session({ id: 'd', status: 'conflict' }),
        session({ id: 'e', status: 'in_review' }),
        session({ id: 'f', status: 'error', projectId: 'p2' }),
      ],
      allUnseen,
    );
    expect(map.get('p1')).toEqual({ input: 1, error: 1, running: 2, result: 1 });
    expect(map.get('p2')).toEqual({ input: 0, error: 1, running: 0, result: 0 });
  });

  it('marks a finished session only while it is unread', () => {
    const done = session({ id: 'a', status: 'done' });
    expect(attentionByProject([done], allUnseen).get('p1')?.result).toBe(1);
    expect(attentionByProject([done], noneUnseen).has('p1')).toBe(false);
  });

  it('leaves stopped, chats, archived, merged and backlog rows unmarked', () => {
    const map = attentionByProject(
      [
        session({ id: 'a', status: 'stopped' }),
        session({ id: 'b', status: 'waiting_input', kind: 'chat' }),
        session({ id: 'c', status: 'error', archived: true }),
        session({ id: 'd', status: 'merged' }),
        session({ id: 'e', status: 'backlog', kind: 'task' }),
      ],
      allUnseen,
    );
    expect(map.has('p1')).toBe(false);
  });

  // A fork follows its parent's bucket: once the parent is merged, the discussion hanging
  // off it is history, whatever its own status says.
  it('drops a fork of a completed parent but keeps a fork of a live one', () => {
    const merged = session({ id: 'p', status: 'merged' });
    const deadFork = session({ id: 'f', status: 'waiting_input', kind: 'discussion', parentSessionId: 'p' });
    expect(attentionByProject([merged, deadFork], allUnseen).has('p1')).toBe(false);

    const live = session({ id: 'q', status: 'thinking' });
    const liveFork = session({ id: 'g', status: 'waiting_input', kind: 'discussion', parentSessionId: 'q' });
    expect(attentionByProject([live, liveFork], allUnseen).get('p1')).toEqual({ input: 1, error: 0, running: 1, result: 0 });
  });
});

describe('sumAttention', () => {
  it('adds project tallies into a workspace tally', () => {
    expect(
      sumAttention([
        { input: 1, error: 0, running: 2, result: 0 },
        { input: 0, error: 1, running: 1, result: 3 },
      ]),
    ).toEqual({ input: 1, error: 1, running: 3, result: 3 });
  });
});

// The Dock icon's number (docs/specs/2026-11-01-dock-attention.md).
describe('yourTurnCount', () => {
  it('counts what waits for the operator across projects, not what is running or already read', () => {
    const map = attentionByProject(
      [
        session({ id: 'a', status: 'waiting_input' }),
        session({ id: 'b', status: 'conflict' }),
        session({ id: 'c', status: 'done' }),
        session({ id: 'd', status: 'thinking' }),
        session({ id: 'e', status: 'queued' }),
        session({ id: 'f', status: 'error', projectId: 'p2' }),
        session({ id: 'g', status: 'in_review', projectId: 'p2' }),
        session({ id: 'h', status: 'stopped', projectId: 'p2' }),
      ],
      (s) => s.id !== 'g',
    );
    expect(yourTurnCount(sumAttention(map.values()))).toBe(4);
  });
});

// The Dock icon's bounce and the pop-up.
describe('isYourTurnEvent', () => {
  const noParent = (): Session | undefined => undefined;

  it('fires when a session moves into each status that hands the turn to the operator', () => {
    for (const status of ['waiting_input', 'error', 'conflict', 'done', 'in_review'] as const) {
      expect(isYourTurnEvent('thinking', session({ id: 'a', status }), noParent)).toBe(true);
    }
    // A session that first shows up already failed (a launch that broke) is the operator's turn.
    expect(isYourTurnEvent(undefined, session({ id: 'a', status: 'error' }), noParent)).toBe(true);
  });

  it('stays quiet on a repeat and on moves that leave nothing to the operator', () => {
    expect(isYourTurnEvent('done', session({ id: 'a', status: 'done' }), noParent)).toBe(false);
    expect(isYourTurnEvent('done', session({ id: 'a', status: 'thinking' }), noParent)).toBe(false);
    expect(isYourTurnEvent('thinking', session({ id: 'a', status: 'stopped' }), noParent)).toBe(false);
    expect(isYourTurnEvent('in_review', session({ id: 'a', status: 'merged' }), noParent)).toBe(false);
  });

  it('ignores chats, archived agents and forks of a completed parent', () => {
    expect(isYourTurnEvent('thinking', session({ id: 'a', status: 'done', kind: 'chat' }), noParent)).toBe(false);
    expect(isYourTurnEvent('thinking', session({ id: 'a', status: 'error', archived: true }), noParent)).toBe(false);
    const merged = session({ id: 'p', status: 'merged' });
    const fork = session({ id: 'f', status: 'done', kind: 'discussion', parentSessionId: 'p' });
    expect(isYourTurnEvent('thinking', fork, (id) => (id === 'p' ? merged : undefined))).toBe(false);
  });
});

describe('attentionOutside', () => {
  // The switcher's mark: what waits in the projects off screen. The scope's own agents are
  // the list in front of the operator and must not light it.
  it('sums only the listed projects outside the scope', () => {
    const byProject = new Map([
      ['here', { input: 1, error: 0, running: 0, result: 0 }],
      ['fe', { input: 0, error: 1, running: 2, result: 0 }],
      ['be', { input: 1, error: 0, running: 0, result: 1 }],
      ['unlisted', { input: 5, error: 0, running: 0, result: 0 }],
    ]);
    expect(attentionOutside(byProject, ['here', 'fe', 'be', 'quiet'], new Set(['here']))).toEqual({
      input: 1,
      error: 1,
      running: 2,
      result: 1,
    });
    expect(attentionOutside(byProject, ['here'], new Set(['here']))).toEqual(NO_ATTENTION);
  });
});

describe('isUnseen', () => {
  const baseline = '2026-09-29T09:00:00.000Z';

  it('treats activity before the baseline as already read', () => {
    expect(isUnseen('2026-09-28T12:00:00.000Z', undefined, baseline)).toBe(false);
    expect(isUnseen('2026-09-29T09:30:00.000Z', undefined, baseline)).toBe(true);
  });

  it('is read until the session moves past the last view', () => {
    expect(isUnseen('2026-09-29T10:00:00.000Z', '2026-09-29T10:00:00.000Z', baseline)).toBe(false);
    expect(isUnseen('2026-09-29T10:05:00.000Z', '2026-09-29T10:00:00.000Z', baseline)).toBe(true);
  });

  it('compares instants, not strings', () => {
    expect(isUnseen('2026-09-29T12:00:00+02:00', '2026-09-29T10:30:00.000Z', baseline)).toBe(false);
  });
});
