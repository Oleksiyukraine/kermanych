// apps/ui/src/composables/useDelayedTrue.ts
import { onScopeDispose, ref, watch, type Ref } from 'vue';

export type DelaySchedule = (fn: () => void, ms: number) => () => void;

export interface DelayedTrueOptions {
  /** Returns its own canceller, so no platform timer handle type leaks out of here. */
  schedule?: DelaySchedule;
}

/**
 * A flag that turns TRUE only once `source` has stayed true for `delayMs`, and FALSE the
 * moment `source` stops.
 *
 * For status a user is meant to READ. A line that appears for 200 ms and vanishes is worse
 * than no line at all: it registers as «щось блимнуло», cannot be read, and cannot be acted
 * on — while the condition it announced was never worth announcing, because it resolved on
 * its own. Rendering a transient state verbatim is what this exists to prevent.
 *
 * `immediate` + `flush: 'sync'`: the source is evaluated on the caller's own tick, so a
 * condition that is already false never arms a timer, and one that clears is dropped in the
 * same tick rather than a microtask later. Works in a component setup and in a Pinia setup
 * store alike — `onScopeDispose` takes the timer with whichever scope owns it.
 */
export function useDelayedTrue(
  source: () => boolean,
  delayMs: number,
  options: DelayedTrueOptions = {},
): Ref<boolean> {
  const {
    schedule = (fn, ms) => {
      const id = setTimeout(fn, ms);
      return () => clearTimeout(id);
    },
  } = options;

  const flag = ref(false);
  let cancelTimer: (() => void) | undefined;

  function stopTimer(): void {
    cancelTimer?.();
    cancelTimer = undefined;
  }

  watch(
    source,
    (on) => {
      stopTimer();
      if (!on) {
        flag.value = false;
        return;
      }
      cancelTimer = schedule(() => {
        cancelTimer = undefined;
        flag.value = true;
      }, delayMs);
    },
    { immediate: true, flush: 'sync' },
  );

  onScopeDispose(stopTimer);

  return flag;
}
