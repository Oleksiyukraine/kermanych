import { describe, it, expect, vi } from 'vitest';
import { installReconcile, type ReconcileDoc } from '../src/lib/reconcile';

// A document stand-in whose visibility we can flip, firing every registered
// 'visibilitychange' listener — no real DOM needed. Unlike socket.spec.ts's, this one
// also removes, because a reconcile is torn down with the subscription that installed it.
function fakeDoc() {
  let vs: DocumentVisibilityState = 'visible';
  const listeners = new Set<() => void>();
  return {
    get visibilityState() {
      return vs;
    },
    addEventListener(_type: 'visibilitychange', cb: () => void) {
      listeners.add(cb);
    },
    removeEventListener(_type: 'visibilitychange', cb: () => void) {
      listeners.delete(cb);
    },
    flip(v: DocumentVisibilityState) {
      vs = v;
      for (const cb of [...listeners]) cb();
    },
    listenerCount() {
      return listeners.size;
    },
  };
}

// A scheduler stand-in: `fire()` is the timer going off, `cancelled` proves teardown.
function fakeSchedule() {
  const state = { fn: undefined as (() => void) | undefined, ms: 0, cancelled: 0 };
  const schedule = (fn: () => void, ms: number) => {
    state.fn = fn;
    state.ms = ms;
    return () => {
      state.fn = undefined;
      state.cancelled += 1;
    };
  };
  return { state, schedule, fire: () => state.fn?.() };
}

describe('installReconcile', () => {
  it('refetches when the tab returns after a long hide, not after a brief flip', () => {
    const refetch = vi.fn();
    const doc = fakeDoc();
    const timer = fakeSchedule();
    let t = 1_000;
    installReconcile(refetch, {
      doc: doc as unknown as ReconcileDoc,
      staleHideMs: 10_000,
      now: () => t,
      schedule: timer.schedule,
    });

    doc.flip('hidden');
    t = 3_000; // 2s away — Alt+Tab, the timer never fell behind
    doc.flip('visible');
    expect(refetch).not.toHaveBeenCalled();

    doc.flip('hidden');
    t = 60_000; // 57s away — a DELETE the filtered binding cannot deliver may have happened
    doc.flip('visible');
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it('runs the safety timer only while visible', () => {
    const refetch = vi.fn();
    const doc = fakeDoc();
    const timer = fakeSchedule();
    let t = 1_000;
    installReconcile(refetch, {
      doc: doc as unknown as ReconcileDoc,
      intervalMs: 60_000,
      staleHideMs: 10_000,
      now: () => t,
      schedule: timer.schedule,
    });

    expect(timer.state.ms).toBe(60_000);
    timer.fire();
    expect(refetch).toHaveBeenCalledTimes(1);

    // Hidden: a board nobody is looking at does not poll.
    doc.flip('hidden');
    expect(timer.state.fn).toBeUndefined();
    expect(timer.state.cancelled).toBe(1);

    t = 90_000; // long enough away that the return itself is worth a refetch
    doc.flip('visible');
    timer.fire();
    expect(refetch).toHaveBeenCalledTimes(3); // the return refetch, then the timer
  });

  it('leaves no listener and no timer behind after stop', () => {
    const refetch = vi.fn();
    const doc = fakeDoc();
    const timer = fakeSchedule();
    const stop = installReconcile(refetch, {
      doc: doc as unknown as ReconcileDoc,
      now: () => 1_000,
      schedule: timer.schedule,
    });

    expect(doc.listenerCount()).toBe(1);
    stop();

    expect(doc.listenerCount()).toBe(0);
    expect(timer.state.fn).toBeUndefined();
    expect(timer.state.cancelled).toBe(1);
    doc.flip('hidden');
    doc.flip('visible');
    expect(refetch).not.toHaveBeenCalled();
  });

  it('falls back to the timer alone when there is no document', () => {
    const refetch = vi.fn();
    const timer = fakeSchedule();
    const stop = installReconcile(refetch, { intervalMs: 5_000, schedule: timer.schedule });

    expect(timer.state.ms).toBe(5_000);
    timer.fire();
    expect(refetch).toHaveBeenCalledTimes(1);
    stop();
    expect(timer.state.cancelled).toBe(1);
  });
});
