// «Посіпака» as the UI words it (docs/specs/2026-10-23-minion-auto-run.md, decision 12): when a
// card or a session wears «потрібне рішення», what its reason says, and the map strip's line.
// Pure, so the wording is tested without mounting a component; every code reaches the operator
// through i18n, never raw.
import type { MinionPause, MinionResult, MinionState, Session } from '@kermanych/core';
import type { Task } from '@kermanych/cloud';

type Tr = (key: string, named?: Record<string, unknown>) => string;

// A card waits on the operator only while it sits «На ревʼю» with the minion's verdict on it:
// a relaunch or a move off the lane makes the stored report history, not a call to act.
export function cardNeedsDecision(task: Pick<Task, 'status' | 'sessionReport'>): boolean {
  return task.status === 'in_review' && task.sessionReport?.minion?.outcome === 'needs_decision';
}

// The session keeps the verdict of its last minion turn: an answer from the operator leads to a
// next turn, whose result replaces it.
export function sessionNeedsDecision(session: Pick<Session, 'minionResult'>): boolean {
  return session.minionResult?.outcome === 'needs_decision';
}

// Kermanych's own reason in words, then the free text (the agent's summary, an error message).
// Neither present still names the state, so a tooltip is never empty.
export function minionReasonText(t: Tr, result: MinionResult): string {
  const parts = [result.code ? t(`minion.reason.${result.code}`) : '', result.reason?.trim() ?? ''].filter(Boolean);
  return parts.length ? parts.join(' — ') : t('minion.needsDecision');
}

// What a card's / a session's «потрібне рішення» mark says, or undefined when it wears none —
// the one value the board, «Задачі», «Агенти» and the map pass to the mark.
export function cardDecisionReason(t: Tr, task: Pick<Task, 'status' | 'sessionReport'>): string | undefined {
  const result = task.sessionReport?.minion;
  return result && cardNeedsDecision(task) ? minionReasonText(t, result) : undefined;
}

export function sessionDecisionReason(t: Tr, session: Pick<Session, 'minionResult'>): string | undefined {
  const result = session.minionResult;
  return result && sessionNeedsDecision(session) ? minionReasonText(t, result) : undefined;
}

// Why the minion is paused, worded, with the api's detail (the provider's sign-in error, the
// last failure) after it.
export function minionPauseText(t: Tr, pause: MinionPause): string {
  const detail = pause.detail?.trim();
  const base = t(`minion.pause.${pause.code}`);
  return detail ? `${base} — ${detail}` : base;
}

// The active projects by name, in the order the api lists them. An id this machine has no row
// for (a project removed since) is left out rather than shown raw.
export function minionProjectNames(state: MinionState, nameOf: (id: string) => string | undefined): string[] {
  return state.projects.map(nameOf).filter((n): n is string => !!n);
}

// The strip above «Карта агентів»: «Посіпака · працює 1 з 1 · у черзі 3 · BE, FE», or
// «Посіпака на паузі: <причина>». Undefined while no project is active here — the strip hides.
export function minionStripText(t: Tr, state: MinionState, nameOf: (id: string) => string | undefined): string | undefined {
  if (!state.projects.length) return undefined;
  if (state.pause) return t('minion.strip.paused', { reason: minionPauseText(t, state.pause) });
  const names = minionProjectNames(state, nameOf);
  return [
    t('agents.role.minion'),
    t('minion.strip.running', { running: state.running, cap: state.cap }),
    t('minion.strip.waiting', { n: state.waiting }),
    ...(names.length ? [names.join(', ')] : []),
  ].join(' · ');
}
