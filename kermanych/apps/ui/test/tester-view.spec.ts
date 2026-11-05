import { describe, expect, it } from 'vitest';
import type { QaChecklistItem, Session, TesterRefusal } from '@kermanych/core';
import { uk } from '../src/i18n/uk';
import { en } from '../src/i18n/en';
import { TESTER_REFUSAL_KEYS, qaRunState, runningTesterOf } from '../src/lib/tester';

// «Виконати тестування» as the FinishSheet and the QA tab render it (docs/specs/2026-11-04-qa-tester-agent.md,
// decisions 9, 11, 12): disabled with a hint, a scope choice once verdicts exist, and «Тестування
// триває» leading to the running tester.

function session(over: Partial<Session> = {}): Session {
  return {
    id: 's1',
    projectId: 'p1',
    name: 'doer',
    status: 'waiting_input',
    kind: 'agent',
    worktree: true,
    worktreePath: '/wt/s1',
    branch: 'feature/x',
    taskId: 't1',
    ...over,
  } as Session;
}

function noCard(over: Partial<Session> = {}): Session {
  const s = session(over);
  delete s.taskId;
  return s;
}

const item = (id: string, agent?: QaChecklistItem['agent']): QaChecklistItem => ({ id, text: id, checked: false, ...(agent ? { agent } : {}) });
const verdict = { status: 'passed' as const, note: 'ok', sessionId: 'x', at: '2026-11-04T10:00:00Z' };

const state = (
  s: Session,
  opts: { sessions?: Session[]; items?: QaChecklistItem[]; platform?: 'web' | 'backend'; browserHost?: boolean; previewConfig?: 'ok' | 'missing' | 'invalid' } = {},
) =>
  qaRunState({
    session: s,
    sessions: opts.sessions ?? [s],
    items: opts.items ?? [],
    platform: opts.platform ?? 'web',
    browserHost: opts.browserHost ?? true,
    previewConfig: opts.previewConfig ?? 'ok',
  });

function lookup(catalog: unknown, key: string): unknown {
  return key.split('.').reduce<unknown>((o, k) => (o as Record<string, unknown> | undefined)?.[k], catalog);
}

describe('«Виконати тестування» state', () => {
  it('is ready on a first run with no scope choice, even on a card without a checklist', () => {
    expect(state(session())).toEqual({ kind: 'ready', offerScope: false, allPassed: false });
    expect(state(session(), { items: [item('q1'), item('q2')] })).toEqual({ kind: 'ready', offerScope: false, allPassed: false });
  });

  it('offers «Непройдені» / «Усі» once any item has a verdict', () => {
    expect(state(session(), { items: [item('q1', verdict), item('q2')] })).toEqual({ kind: 'ready', offerScope: true, allPassed: false });
    const failed = { ...verdict, status: 'failed' as const };
    expect(state(session(), { items: [item('q1', verdict), item('q2', failed)] })).toEqual({ kind: 'ready', offerScope: true, allPassed: false });
  });

  it('leaves only «Усі» when every item passed — «Непройдені» would check nothing', () => {
    expect(state(session(), { items: [item('q1', verdict), item('q2', verdict)] })).toEqual({ kind: 'ready', offerScope: true, allPassed: true });
    expect(typeof lookup(uk, 'tester.run.allPassed')).toBe('string');
    expect(typeof lookup(en, 'tester.run.allPassed')).toBe('string');
  });

  it('refuses with a hint for every guard of decision 12', () => {
    const hint = (s: Session, o: Parameters<typeof state>[1] = {}) => {
      const st = state(s, o);
      return st.kind === 'refused' ? st.hintKey : st.kind;
    };
    expect(hint(noCard())).toBe('tester.refusal.no-card');
    expect(hint(session({ kind: 'review' }))).toBe('tester.refusal.not-agent');
    expect(hint(session({ status: 'merged' }))).toBe('tester.refusal.finished');
    expect(hint(session({ worktreePath: '' }))).toBe('tester.refusal.finished');
    expect(hint(session({ status: 'thinking' }))).toBe('tester.refusal.busy');
    expect(hint(session({ status: 'tool' }))).toBe('tester.refusal.busy');
    expect(hint(session(), { browserHost: false })).toBe('tester.refusal.no-browser');
    expect(hint(session(), { platform: 'backend' })).toBe('tester.refusal.platform');
    expect(hint(session(), { previewConfig: 'missing' })).toBe('tester.refusal.no-preview');
    expect(hint(session(), { previewConfig: 'invalid' })).toBe('tester.refusal.no-preview');
  });

  it('reads «Тестування триває» and points at the running tester, whatever else holds', () => {
    const doer = session({ status: 'thinking' });
    const tester = noCard({ id: 's2', kind: 'review', tester: true, parentSessionId: 's1' });
    expect(state(doer, { sessions: [doer, tester] })).toEqual({ kind: 'running', testerId: 's2' });
  });

  it('ignores a retired tester and other children', () => {
    const doer = session();
    const retired = session({ id: 's2', kind: 'review', tester: true, parentSessionId: 's1', status: 'merged' });
    const review = session({ id: 's3', kind: 'review', parentSessionId: 's1' });
    expect(runningTesterOf([doer, retired, review], 's1')).toBeUndefined();
    expect(state(doer, { sessions: [doer, retired, review] }).kind).toBe('ready');
  });

  it.each([
    ['uk', uk],
    ['en', en],
  ] as const)('every refusal hint has a %s message', (_name, catalog) => {
    for (const code of Object.keys(TESTER_REFUSAL_KEYS) as TesterRefusal[]) {
      expect(typeof lookup(catalog, TESTER_REFUSAL_KEYS[code])).toBe('string');
    }
  });
});
