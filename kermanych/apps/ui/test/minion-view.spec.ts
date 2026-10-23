import { describe, expect, it } from 'vitest';
import { MINION_PAUSE_CODES, MINION_REASON_CODES, type MinionResult, type MinionState, type SessionReport, type Session } from '@kermanych/core';
import type { Task } from '@kermanych/cloud';
import { uk } from '../src/i18n/uk';
import { en } from '../src/i18n/en';
import {
  cardDecisionReason,
  cardNeedsDecision,
  minionPauseText,
  minionProjectNames,
  minionReasonText,
  minionStripText,
  sessionDecisionReason,
  sessionNeedsDecision,
} from '../src/lib/minion';
import { findingTaskInsert } from '../src/lib/findings';

// «Посіпака» as the UI words it (docs/specs/2026-10-23-minion-auto-run.md, decision 12). The
// translator resolves against the real catalogue, so a code without a message shows up here as
// its raw key rather than passing silently.
function translator(catalog: unknown) {
  return (key: string, named: Record<string, unknown> = {}): string => {
    const msg = key.split('.').reduce<unknown>((o, k) => (o as Record<string, unknown> | undefined)?.[k], catalog);
    if (typeof msg !== 'string') return key;
    return msg.replace(/\{(\w+)\}/g, (_, name: string) => String(named[name] ?? `{${name}}`));
  };
}
const t = translator(uk);

function card(over: Partial<Task>): Pick<Task, 'status' | 'sessionReport'> {
  return { status: 'in_review', ...over };
}

// The card's «Сесія» report with the minion's result on it.
function report(minion: MinionResult): SessionReport {
  return {
    sessionId: 's1',
    generatedAt: '2026-10-23T10:00:00.000Z',
    runtime: 'omp',
    native: false,
    branch: 'feature/x',
    worktree: true,
    skills: [],
    minion,
  };
}

const state = (over: Partial<MinionState> = {}): MinionState => ({
  cap: 1,
  failures: 0,
  running: 1,
  waiting: 3,
  projects: ['p-be', 'p-fe'],
  ...over,
});
const names: Record<string, string> = { 'p-be': 'BE', 'p-fe': 'FE' };
const nameOf = (id: string) => names[id];

describe('the «потрібне рішення» predicates', () => {
  it('marks a card only «На ревʼю» with the minion’s needs_decision on it', () => {
    const asked = report({ outcome: 'needs_decision', reason: 'which API?' });
    expect(cardNeedsDecision(card({ sessionReport: asked }))).toBe(true);
    expect(cardNeedsDecision(card({ status: 'backlog', sessionReport: asked }))).toBe(false);
    expect(cardNeedsDecision(card({ sessionReport: report({ outcome: 'pr' }) }))).toBe(false);
    expect(cardNeedsDecision(card({}))).toBe(false);
  });

  it('marks a session by its last minion result', () => {
    expect(sessionNeedsDecision({ minionResult: { outcome: 'needs_decision' } } as Pick<Session, 'minionResult'>)).toBe(true);
    expect(sessionNeedsDecision({ minionResult: { outcome: 'failed', code: 'no_pr' } } as Pick<Session, 'minionResult'>)).toBe(false);
    expect(sessionNeedsDecision({} as Pick<Session, 'minionResult'>)).toBe(false);
  });

  it('gives the mark its worded reason, or nothing', () => {
    expect(cardDecisionReason(t, card({ sessionReport: report({ outcome: 'needs_decision', code: 'no_pr' }) }))).toBe('PR не відкрито');
    expect(cardDecisionReason(t, card({ status: 'done', sessionReport: report({ outcome: 'needs_decision' }) }))).toBeUndefined();
    expect(sessionDecisionReason(t, { minionResult: { outcome: 'needs_decision', reason: 'спитати про UTC' } })).toBe('спитати про UTC');
    expect(sessionDecisionReason(t, {})).toBeUndefined();
  });
});

describe('minionReasonText', () => {
  it('words Kermanych’s code, then the free text', () => {
    expect(minionReasonText(t, { outcome: 'needs_decision', code: 'docs_gate', reason: 'README не оновлено' })).toBe(
      'документація не пройшла перевірку — README не оновлено',
    );
    expect(minionReasonText(t, { outcome: 'needs_decision', reason: '  картка суперечить коду  ' })).toBe('картка суперечить коду');
  });

  it('never leaves the tooltip empty', () => {
    expect(minionReasonText(t, { outcome: 'needs_decision' })).toBe('Потрібне рішення');
  });

  it.each([
    ['uk', uk],
    ['en', en],
  ] as const)('has a %s message for every reason and pause code', (_name, catalog) => {
    const tr = translator(catalog);
    for (const code of MINION_REASON_CODES) expect(minionReasonText(tr, { outcome: 'failed', code })).not.toContain('minion.');
    for (const code of MINION_PAUSE_CODES) expect(minionPauseText(tr, { code, at: '2026-10-23T10:00:00Z' })).not.toContain('minion.');
  });
});

describe('minionPauseText', () => {
  it('adds the api’s detail after the reason', () => {
    expect(minionPauseText(t, { code: 'signed_out', at: 'x', detail: 'claude_not_authenticated' })).toBe(
      'потрібен вхід в AI — claude_not_authenticated',
    );
    expect(minionPauseText(t, { code: 'failures', at: 'x' })).toBe('два невдалі запуски поспіль');
  });
});

describe('minionStripText', () => {
  it('says how many run of the cap, the queue and the projects', () => {
    expect(minionStripText(t, state(), nameOf)).toBe('Посіпака · працює 1 з 1 · у черзі 3 · BE, FE');
  });

  it('says why it is paused instead', () => {
    expect(minionStripText(t, state({ pause: { code: 'operator', at: 'x' } }), nameOf)).toBe('Посіпака на паузі: призупинено вручну');
  });

  it('hides while no project is active here', () => {
    expect(minionStripText(t, state({ projects: [] }), nameOf)).toBeUndefined();
  });

  it('leaves out a project this machine cannot name, never its raw id', () => {
    expect(minionProjectNames(state({ projects: ['p-be', 'p-gone'] }), nameOf)).toEqual(['BE']);
    expect(minionStripText(t, state({ projects: ['p-gone'] }), nameOf)).toBe('Посіпака · працює 1 з 1 · у черзі 3');
  });
});

describe('findingTaskInsert', () => {
  const dest = { id: 'p1', defaultModel: 'opus-5' };

  it('always records the finding’s kind, and the switch as the operator left it', () => {
    expect(findingTaskInsert({ kind: 'security' }, dest, { title: ' Leak ', description: 'd', assigneeId: '', autoRun: false })).toEqual({
      projectId: 'p1',
      title: 'Leak',
      description: 'd',
      prefix: 'fix',
      worktree: true,
      model: 'opus-5',
      autoRun: false,
      findingKind: 'security',
    });
    const allowed = findingTaskInsert({ kind: 'docs' }, { id: 'p1' }, { title: 'T', description: '', assigneeId: 'u1', autoRun: true });
    expect(allowed).toMatchObject({ prefix: 'feature', assigneeId: 'u1', autoRun: true, findingKind: 'docs' });
  });
});
