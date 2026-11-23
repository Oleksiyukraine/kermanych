// apps/ui/src/lib/status-line.ts
// What the session status line (components/kit/KStatusLine.vue,
// docs/specs/2026-11-23-pr-feedback-loop.md, decisions 12–15) shares with the surfaces it sits
// beside: the stall threshold KPanel's banner uses, and the line's own device-local preference.
import type { Ref } from 'vue';
import type { Session } from '@kermanych/core';
import { persisted } from './persisted';

/**
 * A running turn silent this long is stalled: KPanel's stall banner and the status line's
 * «Перезапустити» both key on it. `lastEventAt` is bumped on every agent event but NOT on the
 * operator's sends, so it isolates real agent progress from nudges.
 */
export const STALL_MS = 60_000;

/** Milliseconds a working (`thinking` / `tool`) session has been silent; 0 otherwise. */
export function silentMs(s: Pick<Session, 'status' | 'lastEventAt'>, now: number): number {
  const running = s.status === 'thinking' || s.status === 'tool';
  return running && s.lastEventAt ? Math.max(0, now - s.lastEventAt) : 0;
}

/** The merge-box of a session on review is folded to its summary line. One switch for every
 *  session: it is how the operator likes the pane, not a fact about one PR. */
export const statusLineCollapsed: Ref<boolean> = persisted(
  'kermanych.statusLine.collapsed',
  false,
  (raw) => raw === '1',
  (on) => (on ? '1' : '0'),
);

/** The PR number from its URL (`…/pull/41`), for a session whose loop state has not arrived. */
export function prNumberFromUrl(url: string | undefined): number | undefined {
  const m = url ? /\/pull\/(\d+)/.exec(url) : null;
  return m ? Number(m[1]) : undefined;
}

/** What the full line's buttons are busy with: bound to each button's `loading`. `pass` lists
 *  the untrusted comments being handed over one by one. */
export type StatusLineLoading = {
  runNow?: boolean;
  restart?: boolean;
  resume?: boolean;
  resolve?: boolean;
  loopResume?: boolean;
  loopSend?: boolean;
  pass?: readonly string[];
};
