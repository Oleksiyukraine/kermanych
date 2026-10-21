// apps/ui/src/stores/pending.ts
import { defineStore } from 'pinia';
import { effectScope, reactive, watch, type EffectScope } from 'vue';

/** A pending entity whose echo never comes is released silently after this long. */
export const PENDING_TIMEOUT_MS = 15_000;

export type PendingSchedule = (fn: () => void, ms: number) => () => void;

interface Entry {
  scope: EffectScope;
  cancelTimer: () => void;
}

/**
 * Entities waiting for the server to report the result of an action — a session being stopped,
 * deleted or forked, a thread archived, a terminal killed, a Jira card moved. The HTTP call
 * often returns before the socket / realtime echo changes the entity, and that gap is what made
 * a click look ignored.
 *
 * `mark(key, until)` keeps `key` pending until `until()` turns true — a condition on store
 * state (`!sessions.has(id)`, status terminal, a child with `parentId === id` exists), never a
 * socket event type, so an unrelated `session_update` (a usage tick) cannot settle it early —
 * or until the timeout. The timeout clears silently: the HTTP call already succeeded.
 *
 * Keys: `session:<id>`, `project:<id>`, `terminal:<id>`, `issue:<key>`, `thread:<id>`.
 */
export const usePending = defineStore('pending', () => {
  const keys = reactive(new Set<string>());
  const entries = new Map<string, Entry>();
  let schedule: PendingSchedule = (fn, ms) => {
    const id = setTimeout(fn, ms);
    return () => clearTimeout(id);
  };

  function clear(key: string): void {
    const entry = entries.get(key);
    if (entry) {
      entry.cancelTimer();
      entry.scope.stop();
      entries.delete(key);
    }
    keys.delete(key);
  }

  function mark(key: string, until: () => boolean, timeoutMs = PENDING_TIMEOUT_MS): void {
    clear(key);
    if (until()) return;
    keys.add(key);
    const scope = effectScope(true);
    const cancelTimer = schedule(() => clear(key), timeoutMs);
    entries.set(key, { scope, cancelTimer });
    scope.run(() => {
      watch(until, (done) => {
        if (done) clear(key);
      }, { flush: 'sync' });
    });
  }

  /** Test seam: a fake scheduler in place of setTimeout. */
  function useSchedule(next: PendingSchedule): void {
    schedule = next;
  }

  return { isPending: (key: string) => keys.has(key), mark, clear, useSchedule };
});
