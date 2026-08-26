import { describe, it, expect } from 'vitest';
import { effectScope, ref } from 'vue';
import { useDelayedTrue } from '../src/composables/useDelayedTrue';

// A scheduler stand-in, same shape as reconcile.spec.ts's: `fire()` is the delay elapsing,
// `cancelled` proves the pending wait was dropped. Cancelling forgets the callback, the way
// clearTimeout does — a cancelled wait can never fire.
function fakeSchedule() {
  const state = { fn: undefined as (() => void) | undefined, ms: 0, armed: 0, cancelled: 0 };
  const schedule = (fn: () => void, ms: number) => {
    state.fn = fn;
    state.ms = ms;
    state.armed += 1;
    return () => {
      state.fn = undefined;
      state.cancelled += 1;
    };
  };
  return { state, schedule, fire: () => state.fn?.() };
}

describe('useDelayedTrue', () => {
  it('stays false when the condition clears before the delay elapses', () => {
    const timer = fakeSchedule();
    const down = ref(false);
    const scope = effectScope();
    const late = scope.run(() => useDelayedTrue(() => down.value, 5_000, { schedule: timer.schedule }))!;

    // The board's own sequence: a channel opens CLOSED and answers SUBSCRIBED ~200 ms later.
    down.value = true;
    expect(timer.state.armed).toBe(1);
    expect(late.value).toBe(false);
    down.value = false;

    expect(timer.state.cancelled).toBe(1);
    expect(late.value).toBe(false);
    // Nothing is left to fire: the delay that was counting down is gone, not merely ignored.
    timer.fire();
    expect(timer.state.fn).toBeUndefined();
    expect(late.value).toBe(false);
    scope.stop();
  });

  it('turns true only once the condition has held for the whole delay', () => {
    const timer = fakeSchedule();
    const down = ref(true);
    const scope = effectScope();
    const late = scope.run(() => useDelayedTrue(() => down.value, 5_000, { schedule: timer.schedule }))!;

    // Already true on the caller's tick: armed immediately, and still silent.
    expect(timer.state.armed).toBe(1);
    expect(timer.state.ms).toBe(5_000);
    expect(late.value).toBe(false);

    timer.fire();
    expect(late.value).toBe(true);
    scope.stop();
  });

  it('clears the moment the condition ends, with no second delay', () => {
    const timer = fakeSchedule();
    const down = ref(true);
    const scope = effectScope();
    const late = scope.run(() => useDelayedTrue(() => down.value, 5_000, { schedule: timer.schedule }))!;
    timer.fire();
    expect(late.value).toBe(true);

    down.value = false;
    expect(late.value).toBe(false);
    scope.stop();
  });

  it('never arms a wait for a condition that is already false', () => {
    const timer = fakeSchedule();
    const scope = effectScope();
    const late = scope.run(() => useDelayedTrue(() => false, 5_000, { schedule: timer.schedule }))!;

    expect(timer.state.armed).toBe(0);
    expect(late.value).toBe(false);
    scope.stop();
  });

  it('leaves no pending wait behind when its scope goes away', () => {
    const timer = fakeSchedule();
    const down = ref(true);
    const scope = effectScope();
    scope.run(() => useDelayedTrue(() => down.value, 5_000, { schedule: timer.schedule }));

    scope.stop();
    expect(timer.state.cancelled).toBe(1);
  });
});
