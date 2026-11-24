// The phone's copies of the desktop's async-state primitives (README → Design → Async states;
// apps/ui/src/composables/useAsyncAction.ts, useDelayedTrue.ts, useLoadPhase.ts, stores/pending.ts).
// apps/ui's own ones depend on its Pinia stores and toasts, so the phone keeps the same rules in a
// few lines of its own:
// - an action's `busy` drives the button's loading state, a second press while it runs is ignored,
//   and a failure becomes `error` text shown next to the control;
// - a load shows nothing for 150 ms, then a skeleton for at least 300 ms, never an empty state
//   before the data arrived;
// - a result that arrives as a socket echo (stop, answer) keeps the control pending until the
//   echo shows it, for at most 15 s.

import { computed, onScopeDispose, reactive, readonly, ref, watch, type ComputedRef, type Ref } from "vue";
import { errorText } from "./api";

export function useAction<A extends unknown[], R>(
  fn: (...args: A) => Promise<R>,
): { run: (...args: A) => Promise<R | undefined>; busy: Readonly<Ref<boolean>>; error: Ref<string | null> } {
  const busy = ref(false);
  const error = ref<string | null>(null);
  async function run(...args: A): Promise<R | undefined> {
    if (busy.value) return undefined;
    busy.value = true;
    error.value = null;
    try {
      return await fn(...args);
    } catch (e) {
      error.value = errorText(e);
      return undefined;
    } finally {
      busy.value = false;
    }
  }
  return { run, busy: readonly(busy), error };
}

/**
 * TRUE once `source` has stayed true for `delayMs`; FALSE when it stops, but not before it was
 * visible `minMs`. A status that would flash for a frame is never shown at all.
 */
export function useDelayedTrue(source: () => boolean, delayMs: number, minMs = 0): Readonly<Ref<boolean>> {
  const flag = ref(false);
  let timer: number | undefined;
  let shownAt = 0;
  const stop = () => {
    clearTimeout(timer);
    timer = undefined;
  };
  watch(
    source,
    (on) => {
      stop();
      if (on) {
        if (flag.value) return;
        timer = window.setTimeout(() => {
          timer = undefined;
          shownAt = Date.now();
          flag.value = true;
        }, delayMs);
        return;
      }
      const left = flag.value ? minMs - (Date.now() - shownAt) : 0;
      if (left <= 0) {
        flag.value = false;
        return;
      }
      timer = window.setTimeout(() => {
        timer = undefined;
        flag.value = false;
      }, left);
    },
    { immediate: true, flush: "sync" },
  );
  onScopeDispose(stop);
  return readonly(flag);
}

export const SKELETON_DELAY_MS = 150;
export const SKELETON_MIN_MS = 300;

export type LoadPhase = "blank" | "skeleton" | "ready";

/** `notLoaded` = the data for what is on screen has not arrived (keep `undefined` apart from `[]`). */
export function useLoadPhase(notLoaded: () => boolean): ComputedRef<LoadPhase> {
  const skeleton = useDelayedTrue(notLoaded, SKELETON_DELAY_MS, SKELETON_MIN_MS);
  return computed(() => (skeleton.value ? "skeleton" : notLoaded() ? "blank" : "ready"));
}

export const PENDING_MAX_MS = 15_000;

/** Marks per id that clear when the socket echo arrives (`settle`) or after `PENDING_MAX_MS`. */
export function usePending(): { mark: (id: string) => void; settle: (id: string) => void; has: (id: string) => boolean } {
  const marks = reactive(new Map<string, number>());
  const settle = (id: string) => {
    clearTimeout(marks.get(id));
    marks.delete(id);
  };
  const mark = (id: string) => {
    settle(id);
    marks.set(
      id,
      window.setTimeout(() => marks.delete(id), PENDING_MAX_MS),
    );
  };
  onScopeDispose(() => {
    for (const timer of marks.values()) clearTimeout(timer);
  });
  return { mark, settle, has: (id) => marks.has(id) };
}

/** A clock for relative times, ticking twice a minute. */
export function useNow(periodMs = 30_000): Readonly<Ref<number>> {
  const now = ref(Date.now());
  const id = window.setInterval(() => (now.value = Date.now()), periodMs);
  onScopeDispose(() => clearInterval(id));
  return readonly(now);
}
