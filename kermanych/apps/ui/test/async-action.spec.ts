import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { effectScope, ref } from 'vue';
import { useAsyncAction, useKeyedAction } from '../src/composables/useAsyncAction';
import { useOptimisticValue } from '../src/composables/useOptimisticValue';
import { useActivity, BAR_DELAY_MS, BAR_MIN_MS } from '../src/stores/activity';
import { usePending, PENDING_TIMEOUT_MS } from '../src/stores/pending';

const notify = vi.fn();
vi.mock('../src/stores/orchestrator', () => ({
  useOrchestrator: () => ({ notify }),
}));

// A promise the test resolves or rejects by hand, so «while it runs» is a real state.
interface Deferred<T> {
  promise: Promise<T>;
  resolve: (v: T) => void;
  reject: (e: unknown) => void;
}
function deferred<T = void>(): Deferred<T> {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  setActivePinia(createPinia());
  notify.mockReset();
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('useAsyncAction', () => {
  it('runs once while busy: a second press does not call the action again', async () => {
    const d = deferred<number>();
    const fn = vi.fn(() => d.promise);
    const { run, busy } = useAsyncAction(fn);

    const first = run();
    expect(busy.value).toBe(true);
    expect(await run()).toBeUndefined();
    expect(fn).toHaveBeenCalledTimes(1);

    d.resolve(7);
    expect(await first).toBe(7);
    expect(busy.value).toBe(false);
  });

  it('turns a failure into an error toast and frees the control', async () => {
    const { run, busy } = useAsyncAction(() => Promise.reject(new Error('диск повний')));
    expect(await run()).toBeUndefined();
    expect(notify).toHaveBeenCalledWith('диск повний', 'error');
    expect(busy.value).toBe(false);
  });

  it('hands the failure to onError instead of a toast when the caller renders it itself', async () => {
    const onError = vi.fn();
    const { run } = useAsyncAction(() => Promise.reject(new Error('назва зайнята')), { onError });
    await run();
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'назва зайнята' }));
    expect(notify).not.toHaveBeenCalled();
  });
});

describe('useKeyedAction', () => {
  it('keeps one busy flag per row: a running row neither blocks nor spins another', async () => {
    const pending: Record<string, Deferred<void>> = { a: deferred(), b: deferred() };
    const fn = vi.fn((key: string) => pending[key]!.promise);
    const { run, busyFor, anyBusy } = useKeyedAction(fn);

    const a = run('a');
    expect(busyFor('a')).toBe(true);
    expect(busyFor('b')).toBe(false);
    await run('a');
    expect(fn).toHaveBeenCalledTimes(1);

    const b = run('b');
    expect(fn).toHaveBeenCalledTimes(2);
    pending.a!.resolve();
    await a;
    expect(busyFor('a')).toBe(false);
    expect(anyBusy()).toBe(true);
    pending.b!.resolve();
    await b;
    expect(anyBusy()).toBe(false);
  });
});

describe('activity → progress bar', () => {
  it('shows the bar only for work that outlives the delay, and for at least the minimum', async () => {
    const activity = useActivity();
    const d = deferred();
    const { run } = useAsyncAction(() => d.promise);

    const p = run();
    vi.advanceTimersByTime(BAR_DELAY_MS - 1);
    expect(activity.barVisible).toBe(false);
    vi.advanceTimersByTime(1);
    expect(activity.barVisible).toBe(true);

    d.resolve();
    await p;
    expect(activity.active).toBe(false);
    expect(activity.barVisible).toBe(true);
    vi.advanceTimersByTime(BAR_MIN_MS);
    expect(activity.barVisible).toBe(false);
  });

  it('never lights for work that finishes inside the delay', async () => {
    const activity = useActivity();
    const { run } = useAsyncAction(() => Promise.resolve());
    await run();
    vi.advanceTimersByTime(BAR_DELAY_MS * 3);
    expect(activity.barVisible).toBe(false);
  });

  it('counts parallel work and returns to idle only when all of it has ended', async () => {
    const activity = useActivity();
    const one = deferred();
    const two = deferred();
    const a = useAsyncAction(() => one.promise).run();
    const b = activity.trackLoad(two.promise);
    expect(activity.count).toBe(2);
    one.resolve();
    await a;
    expect(activity.active).toBe(true);
    two.resolve();
    await b;
    expect(activity.count).toBe(0);
  });

  it('counts a failed action as ended', async () => {
    const activity = useActivity();
    await useAsyncAction(() => Promise.reject(new Error('x'))).run();
    expect(activity.count).toBe(0);
  });
});

describe('pending entities', () => {
  it('settles when the watched condition turns true, not on unrelated changes', () => {
    const pending = usePending();
    const status = ref('thinking');
    const usage = ref(1);
    pending.mark('session:s1', () => status.value === 'stopped');
    expect(pending.isPending('session:s1')).toBe(true);

    usage.value = 2;
    status.value = 'thinking';
    expect(pending.isPending('session:s1')).toBe(true);

    status.value = 'stopped';
    expect(pending.isPending('session:s1')).toBe(false);
  });

  it('releases silently after the timeout when the echo never comes', () => {
    const pending = usePending();
    pending.mark('session:s1', () => false);
    vi.advanceTimersByTime(PENDING_TIMEOUT_MS - 1);
    expect(pending.isPending('session:s1')).toBe(true);
    vi.advanceTimersByTime(1);
    expect(pending.isPending('session:s1')).toBe(false);
  });

  it('does not mark an entity whose result is already there', () => {
    const pending = usePending();
    pending.mark('session:s1', () => true);
    expect(pending.isPending('session:s1')).toBe(false);
  });

  it('settles a fork on the parent when the child session appears', () => {
    const pending = usePending();
    const sessions = ref([{ id: 'p', parentId: undefined as string | undefined }]);
    pending.mark('session:p', () => sessions.value.some((s) => s.parentId === 'p'));
    sessions.value = [...sessions.value, { id: 'c', parentId: 'p' }];
    expect(pending.isPending('session:p')).toBe(false);
  });
});

describe('useOptimisticValue', () => {
  it('shows the pick while saving and adopts the source once it reports the pick', async () => {
    const server = ref('omp');
    const d = deferred();
    const scope = effectScope();
    const opt = scope.run(() => useOptimisticValue(() => server.value, () => d.promise))!;

    const p = opt.set('claude');
    expect(opt.value.value).toBe('claude');
    expect(opt.pending.value).toBe(true);

    server.value = 'claude';
    d.resolve();
    await p;
    expect(opt.pending.value).toBe(false);
    expect(opt.value.value).toBe('claude');
    scope.stop();
  });

  it('rolls back to the source and toasts when the save fails', async () => {
    const server = ref('omp');
    const scope = effectScope();
    const opt = scope.run(() =>
      useOptimisticValue(() => server.value, () => Promise.reject(new Error('немає звʼязку'))),
    )!;
    await opt.set('claude');
    expect(opt.value.value).toBe('omp');
    expect(notify).toHaveBeenCalledWith('немає звʼязку', 'error');
    scope.stop();
  });

  it('keeps the pick until a late echo reports it, then follows the source', async () => {
    const server = ref('low');
    const scope = effectScope();
    const opt = scope.run(() => useOptimisticValue(() => server.value, () => Promise.resolve()))!;
    await opt.set('high');
    // Saved, but the session_update has not arrived: the chip must not flick back.
    expect(opt.pending.value).toBe(false);
    expect(opt.value.value).toBe('high');
    server.value = 'high';
    server.value = 'medium';
    expect(opt.value.value).toBe('medium');
    scope.stop();
  });

  it('drops a pick the source never confirms after the timeout', async () => {
    const server = ref('low');
    const scope = effectScope();
    const opt = scope.run(() => useOptimisticValue(() => server.value, () => Promise.resolve()))!;
    await opt.set('high');
    vi.advanceTimersByTime(PENDING_TIMEOUT_MS);
    expect(opt.value.value).toBe('low');
    scope.stop();
  });
});
