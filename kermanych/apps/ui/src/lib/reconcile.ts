// apps/ui/src/lib/reconcile.ts
// Periodic "re-read the snapshot" trigger for a stream that cannot deliver every change.
//
// WHY THIS EXISTS — do not delete it as redundant with Realtime:
// the board's postgres_changes binding is filtered by `project_id=in.(…)`, and a filtered
// binding NEVER delivers DELETE. Under the default replica identity a DELETE payload's
// `old` image is `{ id }` and nothing else, so the filter has no `project_id` to match and
// the Realtime server drops the event before any subscriber sees it (verified live: the
// same DELETE reached an unfiltered binding and not the filtered one). `replica identity
// full` would fix that and was REJECTED: RLS is not applied to DELETE events, so a full
// old-image hands the whole deleted row — title and description included — to anyone
// subscribed without a filter. So a card someone else deleted lingers until the board
// re-reads, and this is what makes it re-read.
//
// Shaped after installVisibilityResync in ./socket: the same "a long hide means the live
// stream lied to us" idea, with every dependency injectable so it is testable without a
// DOM or a real clock.
import type { VisibilityDoc } from './socket';

/**
 * VisibilityDoc plus removal. installVisibilityResync installs once for the app's whole
 * life and never detaches; a reconcile is installed per subscription and torn down with
 * it, so it MUST be able to take its listener back off — otherwise every resubscribe
 * (a project added, a membership revoked) would leave another live listener behind.
 */
export interface ReconcileDoc extends VisibilityDoc {
  removeEventListener(type: 'visibilitychange', listener: () => void): void;
}

export type ReconcileOptions = {
  /** Defaults to the real `document` when one exists (never in tests, never in the api). */
  doc?: ReconcileDoc;
  /** Safety refetch cadence while visible. */
  intervalMs?: number;
  /** How long hidden counts as "long enough that a DELETE may have been missed". */
  staleHideMs?: number;
  now?: () => number;
  /** Returns its own canceller, so no platform timer handle type leaks out of here. */
  schedule?: (fn: () => void, ms: number) => () => void;
};

/**
 * Call `refetch` when the tab returns to the foreground after a long hide, and every
 * `intervalMs` while it is in the foreground. Returns a stop function that detaches the
 * listener and cancels the timer — after it runs, nothing of this install survives.
 *
 * Hidden tabs do not poll: the return-to-visible refetch covers whatever happened while
 * away, and a background board nobody is looking at is not worth a query per minute.
 */
export function installReconcile(refetch: () => void, options: ReconcileOptions = {}): () => void {
  const {
    doc = typeof document !== 'undefined' ? document : undefined,
    intervalMs = 60_000,
    staleHideMs = 10_000,
    now = Date.now,
    schedule = (fn, ms) => {
      const id = setInterval(fn, ms);
      return () => clearInterval(id);
    },
  } = options;

  let cancelTimer: (() => void) | undefined;

  function startTimer(): void {
    cancelTimer ??= schedule(refetch, intervalMs);
  }

  function stopTimer(): void {
    cancelTimer?.();
    cancelTimer = undefined;
  }

  // No document (a harness, or the electron main process): there is no visibility to
  // follow, so the timer alone carries the reconcile.
  if (!doc) {
    startTimer();
    return stopTimer;
  }

  let hiddenAt = 0;
  const onVisibilityChange = (): void => {
    if (doc.visibilityState === 'hidden') {
      hiddenAt = now();
      stopTimer();
      return;
    }
    // A brief Alt+Tab needs nothing — the timer never fell more than one cycle behind.
    if (hiddenAt && now() - hiddenAt >= staleHideMs) refetch();
    hiddenAt = 0;
    startTimer();
  };

  doc.addEventListener('visibilitychange', onVisibilityChange);
  if (doc.visibilityState === 'visible') startTimer();

  return () => {
    doc.removeEventListener('visibilitychange', onVisibilityChange);
    stopTimer();
  };
}
