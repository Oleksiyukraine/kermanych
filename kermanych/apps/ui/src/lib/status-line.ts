// apps/ui/src/lib/status-line.ts
// The session status line as a stage pipeline (components/kit/KStatusLine.vue,
// docs/specs/2026-11-25-status-line-pipeline.md): which stage a session is on and in what state.
// Pure, like lib/time.ts: every note is a catalog key and its params, rendered by the component,
// so the mapping is testable without vue-i18n. Also the stall threshold KPanel's banner uses on
// the surfaces that have no status line, and the device's choice to fold the line to bars.
import type { Ref } from 'vue';
import { isReadyToMerge, type PrLoopState, type Session } from '@kermanych/core';
import { dur, relativeTime } from './time';
import { needsSignIn } from './session-auth';
import { persisted } from './persisted';

/**
 * The full line folded to a strip of thin bars, one per stage (KStatusLine). One choice for the
 * whole device, not per session: it is how the operator wants the pane to look, and a per-session
 * fold would spring back open on every switch to another agent.
 */
export const statusLineMinimized: Ref<boolean> = persisted('kermanych.statusLine.minimized', false, (raw) => raw === '1', (on) => (on ? '1' : '0'));

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

/** The PR number from its URL (`…/pull/41`), for a session whose loop state has not arrived. */
export function prNumberFromUrl(url: string | undefined): number | undefined {
  const m = url ? /\/pull\/(\d+)/.exec(url) : null;
  return m ? Number(m[1]) : undefined;
}

/** What the line's buttons are busy with: bound to each button's `loading`. `pass` lists the
 *  untrusted comments being handed over one by one. */
export type StatusLineLoading = {
  runNow?: boolean;
  restart?: boolean;
  resume?: boolean;
  resolve?: boolean;
  loopResume?: boolean;
  loopSend?: boolean;
  pass?: readonly string[];
};

// ── The pipeline ───────────────────────────────────────────────────────────

export const STAGES = ['task', 'agent', 'pr', 'ci', 'review', 'merge'] as const;
export type StageKey = (typeof STAGES)[number];

/** ✓ / spinner / ● / ✗ / ○, and grey «no data» for the PR stages the loop cannot read. */
export type StageState = 'done' | 'running' | 'waiting' | 'failed' | 'todo' | 'unknown';

/** One piece of a note: a catalog key with its params (`n` picks the plural), or raw text
 *  (a tool name, an error message). A note's parts are joined with ` · `. */
export type NotePart = { key: string; params?: Record<string, unknown>; n?: number } | { text: string };

export type Stage = { key: StageKey; state: StageState; note: NotePart[]; tip?: NotePart[] };

export type Pipeline = {
  stages: Stage[];
  /** The stage the card names and the narrow line keeps spelled out. */
  current: StageKey;
};

const k = (key: string, params?: Record<string, unknown>, n?: number): NotePart =>
  n === undefined ? (params ? { key, params } : { key }) : { key, params: params ?? {}, n };

/**
 * Where the session is (decision 2). The work stage is «Агент» until the session has a PR and
 * «Ревʼю» after: an agent fixing review feedback never sends the pipeline back. The PR stages
 * after «ПР» come from «Петля після ПР»; without its state they are `unknown`. A session that is
 * not an agent (chat, discussion, review) has no branch and no PR: only its work stage.
 */
export function pipelineOf(s: Session, loop: PrLoopState | null | undefined, now: number): Pipeline {
  const hasPr = !!s.prOpened || s.status === 'in_review' || s.status === 'merged';
  const work: StageKey = hasPr ? 'review' : 'agent';
  const st = new Map<StageKey, Stage>(STAGES.map((key) => [key, { key, state: 'todo', note: [] }]));
  const set = (key: StageKey, state: StageState, note: NotePart[] = [], tip?: NotePart[]): void => {
    st.set(key, tip ? { key, state, note, tip } : { key, state, note });
  };

  set('task', 'done');
  if (hasPr) {
    set('agent', 'done');
    const number = loop?.pr?.number ?? prNumberFromUrl(s.prUrl);
    set('pr', 'done', number === undefined ? [] : [{ text: `#${number}` }]);
    prStages(set, s, loop);
  }

  // What the session itself is doing lands on the work stage, and is the current fact.
  let current: StageKey | undefined = work;
  const silence = silentMs(s, now);
  const since = dur(Math.max(0, now - Date.parse(s.lastActivityAt)));
  switch (s.status) {
    case 'queued': {
      const w = s.slotWait;
      const note = w
        ? [k('statusLine.note.queued'), k('statusLine.note.slots', { running: w.running, limit: w.limit })]
        : [k('statusLine.note.starting')];
      if (w && w.position > 1) note.push(k('statusLine.note.position', { position: w.position }));
      note.push(since);
      set(hasPr ? work : 'task', 'waiting', note);
      current = hasPr ? work : 'task';
      break;
    }
    case 'thinking':
    case 'tool': {
      const what = s.status === 'tool' ? (s.currentTool ? { text: s.currentTool } : k('statusLine.note.tool')) : k('statusLine.note.thinking');
      const fixing = hasPr && (s.loopTurn || loop?.loop.phase === 'fixing');
      const note = fixing ? [k('statusLine.note.fixing', { round: loop?.loop.round ?? 1 })] : [what];
      if (s.lastEventAt) note.push(k('statusLine.note.silence', { value: dur(silence) }));
      set(work, silence >= STALL_MS ? 'failed' : 'running', note, fixing ? [what] : undefined);
      break;
    }
    case 'waiting_input':
      set(work, 'waiting', [k('statusLine.note.waiting'), since]);
      break;
    case 'error':
      set(work, 'failed', [k(needsSignIn(s.errorCode) ? 'statusLine.note.signIn' : 'statusLine.note.error')], s.error ? [{ text: s.error }] : undefined);
      break;
    case 'stopped':
      set(work, 'todo', [k('statusLine.note.stopped'), relativeTime(s.lastActivityAt, now)]);
      break;
    case 'conflict': {
      const note = [s.baseBranch ? k('statusLine.note.conflict', { base: s.baseBranch }) : k('statusLine.note.conflictPlain')];
      current = hasPr ? 'merge' : 'agent';
      set(current, 'failed', note);
      break;
    }
    case 'done':
      // A turn with a PR settles at `in_review`; a stray `done` there reads like review.
      if (hasPr) {
        current = undefined;
        break;
      }
      set('agent', 'done', [relativeTime(s.lastActivityAt, now)]);
      set('pr', 'waiting', [k('statusLine.note.prReady')]);
      current = 'pr';
      break;
    case 'merged':
      for (const key of STAGES) if (key !== 'pr') set(key, 'done');
      if (s.branch) set('merge', 'done', [{ text: s.branch }]);
      current = 'merge';
      break;
    case 'backlog':
      set('task', 'todo');
      current = 'task';
      break;
    default:
      // `in_review`: nothing runs; the PR stages say where it is.
      current = undefined;
  }

  const all = STAGES.map((key) => st.get(key)!);
  if (s.kind !== 'agent') return { stages: [st.get(work)!], current: work };
  return { stages: all, current: current ?? settledCurrent(all) };
}

/** On review with nothing running: the first failure, else the first stage that waits or runs,
 *  else the last one done. */
function settledCurrent(stages: Stage[]): StageKey {
  const pick =
    stages.find((x) => x.state === 'failed') ??
    stages.find((x) => x.state === 'running' || x.state === 'waiting') ??
    [...stages].reverse().find((x) => x.state === 'done') ??
    stages[0]!;
  return pick.key;
}

/** CI, Ревʼю and Злиття from the loop state; `unknown` with the reason when there is none. */
function prStages(
  set: (key: StageKey, state: StageState, note?: NotePart[], tip?: NotePart[]) => void,
  s: Session,
  loop: PrLoopState | null | undefined,
): void {
  if (!loop || loop.unavailable) {
    const tip = [k(loop?.unavailable ? `prLoop.unavailable.${loop.unavailable}` : 'statusLine.note.notPolled')];
    set('ci', 'unknown', [k('statusLine.note.noData')], tip);
    set('review', 'unknown', [k('statusLine.note.noData')], tip);
    return;
  }

  const ci = loop.ci;
  // Check runs the token may not read: what is shown is only the commit statuses, and the tip says why.
  const ciTip = ci.checksDenied ? [k('prLoop.ci.checksDenied')] : undefined;
  if (ci.state === 'failure') set('ci', 'failed', [k('statusLine.note.ciFailed', { n: ci.failed.length, total: ci.total }, ci.failed.length)], ciTip);
  else if (ci.stuckMin !== undefined) set('ci', 'waiting', [k('statusLine.note.ciStuck', { min: ci.stuckMin })], ciTip);
  else if (ci.state === 'pending') set('ci', 'running', [{ text: `${ci.done}/${ci.total}` }], ciTip);
  else if (ci.state === 'success') set('ci', 'done', [{ text: `${ci.total}/${ci.total}` }], ciTip);
  else if (ci.checksDenied) set('ci', 'unknown', [k('statusLine.note.noData')], ciTip);
  else set('ci', 'done', [k('statusLine.note.ciNone')]);

  const r = loop.review;
  const comments = r.pending + r.untrusted.length;
  if (loop.loop.phase === 'paused') set('review', 'failed', [k('statusLine.note.paused')]);
  else if (comments) set('review', 'waiting', [k('statusLine.note.comments', { n: comments }, comments)]);
  else if (r.decision === 'approved') set('review', 'done', [k('statusLine.note.approved')]);
  else if (r.decision === 'changes_requested') set('review', 'waiting', [k('statusLine.note.changesRequested')]);
  else set('review', 'waiting', [k('statusLine.note.awaitingReview')]);

  // A merged PR is past review whatever the last poll said about it.
  if (loop.pr?.state === 'merged') {
    set('review', 'done');
    set('merge', 'done');
  } else if (loop.pr?.state === 'closed') set('merge', 'failed', [k('statusLine.note.prClosed')]);
  else if (loop.mergeable === 'conflict') {
    set('merge', 'failed', [s.baseBranch ? k('statusLine.note.conflict', { base: s.baseBranch }) : k('statusLine.note.conflictPlain')]);
  } else if (isReadyToMerge(loop)) set('merge', 'waiting', [k('statusLine.note.mergeReady')]);
}
