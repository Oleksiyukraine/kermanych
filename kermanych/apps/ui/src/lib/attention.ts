// apps/ui/src/lib/attention.ts
// What a sidebar row tells the operator about a project: does it need them, and how badly.
// One rule for the project rows and the workspace rows above them, so a folded workspace
// and the projects it hides can never disagree. The Dock icon's number and bounce
// (docs/specs/2026-11-01-dock-attention.md) read the same rule.
import type { Session, SessionStatus } from '@kermanych/core';
// Import from core's status module directly (not the barrel): @kermanych/core is a CJS
// workspace dep whose named exports vite/rollup only sees once its dist is commonjs-
// transformed (see quasar.config commonjsOptions.include); status.js has a direct export.
import { shouldNotify } from '@kermanych/core/status';
import { bucketOf } from './buckets';

// How many of the project's sessions sit in each state that deserves a mark.
//   input   — blocked on an interactive question to the operator (`waiting_input`)
//   error   — crashed or conflicted; a human has to untangle it
//   running — queued or working
//   result  — finished (`done` / `in_review`) and not opened since it last moved
export type Attention = { input: number; error: number; running: number; result: number };

// The mark a row wears: the highest-priority state with a non-zero count, or nothing.
export type AttentionLevel = keyof Attention | 'idle';

// Priority order, highest first. «Needs an answer» outranks «running»: next to a working
// agent the blocked one is what needs the operator, and a green count must not hide it.
// Live agents (the two pills) outrank the error dot: an old crash nobody archived must not
// hide that a project has agents at work right now. The error is not lost under a pill —
// `flagsError` puts the dot on the pill's corner — and it outranks the unread ring, because
// nothing will fix it on its own.
export const ATTENTION_ORDER: readonly (keyof Attention)[] = ['input', 'running', 'error', 'result'];

export const NO_ATTENTION: Readonly<Attention> = Object.freeze({ input: 0, error: 0, running: 0, result: 0 });

export function levelOf(a: Attention): AttentionLevel {
  return ATTENTION_ORDER.find((k) => a[k] > 0) ?? 'idle';
}

// A pill (input / running) is the mark, yet something also failed: the pill carries the
// error dot on its corner, so neither live agents nor a crash disappear behind the other.
export function flagsError(a: Attention): boolean {
  const level = levelOf(a);
  return (level === 'input' || level === 'running') && a.error > 0;
}

export function sumAttention(list: Iterable<Attention>): Attention {
  const total = { ...NO_ATTENTION };
  for (const a of list) for (const k of ATTENTION_ORDER) total[k] += a[k];
  return total;
}

// The row's tooltip and accessible name: every non-zero state, highest first, because the
// mark itself only carries the top one. Count-agnostic phrasing («працює: 3») — Ukrainian
// would otherwise need three plural forms per state. `t` is vue-i18n's, passed in so this
// stays a plain module the tests can load.
export function describeAttention(a: Attention, t: (key: string, params?: Record<string, unknown>) => string): string {
  const parts = ATTENTION_ORDER.filter((k) => a[k] > 0).map((k) => t(`kit.attention.${k}`, { count: a[k] }));
  return ` · ${parts.length ? parts.join(' · ') : t('kit.attention.none')}`;
}

// A result is unread when the session moved after the operator last looked at it. The
// baseline stands in for «looked at» on every session the operator never opened on this
// machine since the mark existed — without it, every historic `done` would light up.
// Compared as instants rather than strings: the api writes toISOString(), but a string
// comparison would silently break on the first timestamp that arrives in another offset.
export function isUnseen(lastActivityAt: string, seenAt: string | undefined, baseline: string): boolean {
  const moved = Date.parse(lastActivityAt);
  const seen = Math.max(Date.parse(baseline), seenAt ? Date.parse(seenAt) : -Infinity);
  return moved > seen;
}

// Whether a session is work the operator tracks. Chats are the operator's own conversations,
// not work to track, and anything `bucketOf` files as completed or as a backlog card is out:
// archived and merged work (with the forks that hang off it) needs nothing.
export function isTracked(s: Session, parent: (id: string) => Session | undefined): boolean {
  if (s.kind === 'chat') return false;
  const bucket = bucketOf(s, parent);
  return bucket !== 'completed' && bucket !== 'tasks';
}

// Per project, in one pass, over the tracked sessions. `stopped` gets no mark — the operator
// stopped it, so there is nothing new to read.
export function attentionByProject(
  sessions: readonly Session[],
  unseen: (s: Session) => boolean,
): Map<string, Attention> {
  const byId = new Map(sessions.map((s) => [s.id, s]));
  const parent = (id: string): Session | undefined => byId.get(id);
  const out = new Map<string, Attention>();
  for (const s of sessions) {
    if (!isTracked(s, parent)) continue;
    const key = stateOf(s, unseen);
    if (!key) continue;
    let a = out.get(s.projectId);
    if (!a) out.set(s.projectId, (a = { ...NO_ATTENTION }));
    a[key]++;
  }
  return out;
}

// «Ваш хід»: how many sessions wait for the operator — a question, a failure, a result nobody
// has read. The Dock icon's number: the sidebar's marks without «працює».
export function yourTurnCount(a: Attention): number {
  return a.input + a.error + a.result;
}

// The moment a tracked session's turn passes to the operator: it moves INTO `waiting_input`,
// `error`, `conflict`, `done` or `in_review` from another status. The Dock bounces on it, and the
// pop-up fires on it. Not tied to «unread»: a result that lands in the agent open on screen is
// read at once, yet the operator may be in another app — and macOS bounces only then anyway.
export function isYourTurnEvent(
  prev: SessionStatus | undefined,
  s: Session,
  parent: (id: string) => Session | undefined,
): boolean {
  return shouldNotify(prev, s.status) && isTracked(s, parent);
}

// The header switcher's mark: everything that needs the operator in the projects they are
// NOT looking at. In focus mode the sidebar's per-project marks are off screen, and this is
// the one place a question asked in another project can still be seen without opening the
// list. The projects in scope are left out — their agents are already the list on screen.
export function attentionOutside(
  byProject: ReadonlyMap<string, Attention>,
  projectIds: Iterable<string>,
  inScope: ReadonlySet<string>,
): Attention {
  const others: Attention[] = [];
  for (const id of projectIds) {
    const a = byProject.get(id);
    if (a && !inScope.has(id)) others.push(a);
  }
  return sumAttention(others);
}

/** `queued` / `thinking` / `tool`: the agent is working (or about to). Shared with the
 *  selected session card, whose frame runs exactly while this holds. */
export function isRunningStatus(status: SessionStatus): boolean {
  return status === 'queued' || status === 'thinking' || status === 'tool';
}

function stateOf(s: Session, unseen: (s: Session) => boolean): keyof Attention | undefined {
  if (isRunningStatus(s.status)) return 'running';
  switch (s.status) {
    case 'waiting_input':
      return 'input';
    case 'error':
    case 'conflict':
      return 'error';
    case 'done':
    case 'in_review':
      return unseen(s) ? 'result' : undefined;
    default:
      return undefined;
  }
}
