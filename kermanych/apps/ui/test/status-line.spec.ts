import { describe, expect, it } from 'vitest';
import type { PrLoopState, Session } from '@kermanych/core';
import { pipelineOf, type StageKey, type StageState } from '../src/lib/status-line';

// docs/specs/2026-11-25-status-line-pipeline.md, decision 2: which stage a session is on.
const NOW = Date.parse('2026-11-25T12:00:00Z');
const ago = (ms: number): string => new Date(NOW - ms).toISOString();

function session(over: Partial<Session>): Session {
  return {
    id: 's', projectId: 'p', name: 'Пагінація', task: '', worktreePath: '', branch: 'feature/pagination',
    worktree: true, baseBranch: 'dev', kind: 'agent', status: 'done', createdAt: ago(3_600_000), lastActivityAt: ago(60_000),
    ...over,
  };
}

function loop(over: Partial<PrLoopState> = {}): PrLoopState {
  return {
    sessionId: 's',
    pr: { number: 41, url: 'https://github.com/acme/web/pull/41', state: 'open' },
    ci: { state: 'success', total: 4, done: 4, failed: [] },
    review: { decision: 'none', pending: 0, untrusted: [] },
    mergeable: 'clean',
    loop: { mode: 'auto', round: 0, maxRounds: 3, phase: 'idle' },
    checkedAt: ago(0),
    ...over,
  };
}

/** `stage:state` for each stage, and the current one — the shape a reader checks by eye. */
function shape(s: Session, l?: PrLoopState | null): { states: string; current: StageKey } {
  const p = pipelineOf(s, l, NOW);
  return { states: p.stages.map((x) => `${x.key}:${x.state}`).join(' '), current: p.current };
}

const states = (...xs: StageState[]): string =>
  (['task', 'agent', 'pr', 'ci', 'review', 'merge'] as const).map((k, i) => `${k}:${xs[i]}`).join(' ');

describe('pipelineOf', () => {
  it('queued waits on «Задача»', () => {
    expect(shape(session({ status: 'queued', slotWait: { position: 2, running: 2, limit: 2 } }))).toEqual({
      states: states('waiting', 'todo', 'todo', 'todo', 'todo', 'todo'),
      current: 'task',
    });
  });

  it('a working agent runs «Агент»; a silent one past the stall threshold fails it', () => {
    expect(shape(session({ status: 'tool', currentTool: 'bash', lastEventAt: NOW - 5_000 }))).toEqual({
      states: states('done', 'running', 'todo', 'todo', 'todo', 'todo'),
      current: 'agent',
    });
    expect(shape(session({ status: 'thinking', lastEventAt: NOW - 120_000 })).states).toBe(states('done', 'failed', 'todo', 'todo', 'todo', 'todo'));
  });

  it('waiting, error and stopped land on «Агент» while there is no PR', () => {
    expect(shape(session({ status: 'waiting_input' })).states).toBe(states('done', 'waiting', 'todo', 'todo', 'todo', 'todo'));
    expect(shape(session({ status: 'error', error: 'exit 1' })).states).toBe(states('done', 'failed', 'todo', 'todo', 'todo', 'todo'));
    expect(shape(session({ status: 'stopped' }))).toEqual({ states: states('done', 'todo', 'todo', 'todo', 'todo', 'todo'), current: 'agent' });
  });

  it('done without a PR waits on «ПР»', () => {
    expect(shape(session({ status: 'done' }))).toEqual({ states: states('done', 'done', 'waiting', 'todo', 'todo', 'todo'), current: 'pr' });
  });

  it('a conflict fails «Агент» before the PR and «Злиття» after it', () => {
    expect(shape(session({ status: 'conflict' }))).toEqual({ states: states('done', 'failed', 'todo', 'todo', 'todo', 'todo'), current: 'agent' });
    expect(shape(session({ status: 'conflict', prOpened: true }), loop()).current).toBe('merge');
  });

  it('on review the PR stages follow the loop, and the first open one is current', () => {
    const l = loop({ ci: { state: 'pending', total: 4, done: 3, failed: [] }, review: { decision: 'none', pending: 2, untrusted: [] } });
    expect(shape(session({ status: 'in_review', prOpened: true }), l)).toEqual({
      states: states('done', 'done', 'done', 'running', 'waiting', 'todo'),
      current: 'ci',
    });
  });

  it('a failed CI and a paused loop are failures; the failure is current', () => {
    const l = loop({ ci: { state: 'failure', total: 4, done: 4, failed: [{ name: 'e2e' }] }, loop: { mode: 'auto', round: 3, maxRounds: 3, phase: 'paused' } });
    expect(shape(session({ status: 'in_review', prOpened: true }), l)).toEqual({
      states: states('done', 'done', 'done', 'failed', 'failed', 'todo'),
      current: 'ci',
    });
  });

  it('green CI, approval and no conflict wait on «Злиття»', () => {
    const l = loop({ review: { decision: 'approved', pending: 0, untrusted: [] } });
    expect(shape(session({ status: 'in_review', prOpened: true }), l)).toEqual({
      states: states('done', 'done', 'done', 'done', 'done', 'waiting'),
      current: 'merge',
    });
  });

  it('the second review round runs «Ревʼю», never «Агент» again', () => {
    const l = loop({ ci: { state: 'failure', total: 4, done: 4, failed: [{ name: 'e2e' }] }, loop: { mode: 'auto', round: 2, maxRounds: 3, phase: 'fixing' } });
    const p = pipelineOf(session({ status: 'tool', currentTool: 'edit', lastEventAt: NOW - 1_000, prOpened: true, loopTurn: true }), l, NOW);
    expect(p.stages.find((x) => x.key === 'agent')!.state).toBe('done');
    expect(p.stages.find((x) => x.key === 'review')!).toMatchObject({ state: 'running', note: [{ key: 'statusLine.note.fixing', params: { round: 2 } }, expect.anything()] });
    expect(p.current).toBe('review');
  });

  it('without loop data CI and «Ревʼю» are unknown, with the reason as the tip', () => {
    const p = pipelineOf(session({ status: 'in_review', prOpened: true, prUrl: 'https://github.com/acme/web/pull/41' }), loop({ unavailable: 'no_token' }), NOW);
    expect(p.stages.map((x) => x.state)).toEqual(['done', 'done', 'done', 'unknown', 'unknown', 'todo']);
    expect(p.stages.find((x) => x.key === 'ci')!.tip).toEqual([{ key: 'prLoop.unavailable.no_token' }]);
    expect(p.stages.find((x) => x.key === 'pr')!.note).toEqual([{ text: '#41' }]);
    expect(p.current).toBe('pr');
  });

  it('merged is done end to end', () => {
    expect(shape(session({ status: 'merged', prOpened: true }), loop({ pr: { number: 41, url: '', state: 'merged' } }))).toEqual({
      states: states('done', 'done', 'done', 'done', 'done', 'done'),
      current: 'merge',
    });
  });

  it('a session that is not an agent shows only its work stage', () => {
    expect(shape(session({ kind: 'chat', status: 'thinking', lastEventAt: NOW - 1_000 }))).toEqual({ states: 'agent:running', current: 'agent' });
    expect(shape(session({ kind: 'discussion', status: 'done' }))).toEqual({ states: 'agent:done', current: 'agent' });
  });
});
