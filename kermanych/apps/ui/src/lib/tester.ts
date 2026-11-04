// «Тестувальник» as the UI shows it (docs/specs/2026-11-04-qa-tester-agent.md, decisions 9, 11, 12):
// which state «Виконати тестування» is in for a session. Pure, so the FinishSheet and the QA tab
// render the same control from the same answer, and the states are testable without a DOM.
import {
  platformHasBrowser,
  qaHasVerdicts,
  qaItemsInScope,
  testerRefusal,
  type Platform,
  type QaChecklistItem,
  type Session,
  type TesterRefusal,
} from '@kermanych/core';

/** The i18n key of the hint a refused button shows, per core refusal code. */
export const TESTER_REFUSAL_KEYS: Record<TesterRefusal, string> = {
  running: 'tester.refusal.running',
  'not-agent': 'tester.refusal.not-agent',
  finished: 'tester.refusal.finished',
  'no-card': 'tester.refusal.no-card',
  busy: 'tester.refusal.busy',
  'no-browser': 'tester.refusal.no-browser',
  platform: 'tester.refusal.platform',
  'no-preview': 'tester.refusal.no-preview',
};

/** The running tester child of a doer session (at most one, decision 11). A retired one is history. */
export function runningTesterOf(sessions: readonly Session[], doerId: string): Session | undefined {
  return sessions.find((s) => s.tester === true && s.parentSessionId === doerId && s.status !== 'merged');
}

export type QaRunState =
  /** A tester of this session runs: the button reads «Тестування триває» and opens it. */
  | { kind: 'running'; testerId: string }
  /** It cannot start now: disabled, with the hint. */
  | { kind: 'refused'; hintKey: string }
  /**
   * It can start. `offerScope`: some item already has a verdict, so the operator picks
   * «Непройдені» (the default) or «Усі»; on a first run every item is checked. `allPassed`:
   * every item passed, so «Непройдені» would check nothing (the api refuses it) and «Усі» is
   * the only scope.
   */
  | { kind: 'ready'; offerScope: boolean; allPassed: boolean };

export function qaRunState(input: {
  session: Session;
  sessions: readonly Session[];
  /** The card's checklist items; empty when the card has none (the tester composes one). */
  items: readonly QaChecklistItem[];
  platform: Platform | null | undefined;
  browserHost: boolean;
  /** The doer's `.kermanych/preview.json` status; undefined until read (refuses nothing). */
  previewConfig?: 'ok' | 'missing' | 'invalid' | undefined;
}): QaRunState {
  const { session: s } = input;
  const tester = runningTesterOf(input.sessions, s.id);
  if (tester) return { kind: 'running', testerId: tester.id };
  const refusal = testerRefusal({
    kind: s.kind,
    status: s.status,
    worktree: s.worktree,
    worktreePath: s.worktreePath,
    ...(s.taskId ? { taskId: s.taskId } : {}),
    runningTester: false,
    browserHost: input.browserHost,
    platformHasBrowser: platformHasBrowser(input.platform),
    previewConfig: input.previewConfig,
  });
  if (refusal) return { kind: 'refused', hintKey: TESTER_REFUSAL_KEYS[refusal] };
  const offerScope = qaHasVerdicts(input.items);
  return { kind: 'ready', offerScope, allPassed: offerScope && qaItemsInScope(input.items, 'open').length === 0 };
}
