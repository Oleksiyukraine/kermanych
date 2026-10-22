// apps/ui/src/stores/activity.ts
import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import { useDelayedTrue } from '../composables/useDelayedTrue';

/** The top progress bar appears only for work that has run this long… */
export const BAR_DELAY_MS = 300;
/** …and, once shown, stays at least this long so it never blinks for one frame. */
export const BAR_MIN_MS = 300;

/**
 * Foreground work the operator started: clicks, submits, page / tab / scope loads. It drives
 * the global progress bar (`KProgressBar` in MainLayout).
 *
 * Opt-in by construction: only work that goes through `start()` — via `useAsyncAction` or
 * `trackLoad` — counts. Background traffic (git-status poll, reconcile, Jira/Linear tickers,
 * usage poll, realtime) never calls it, so the bar cannot twitch on its own.
 */
export const useActivity = defineStore('activity', () => {
  const count = ref(0);
  const active = computed(() => count.value > 0);
  const barVisible = useDelayedTrue(() => active.value, BAR_DELAY_MS, { minMs: BAR_MIN_MS });

  /** Registers one unit of work; the returned `end` is idempotent. */
  function start(): () => void {
    count.value += 1;
    let ended = false;
    return () => {
      if (ended) return;
      ended = true;
      count.value -= 1;
    };
  }

  /** Counts a foreground load for as long as `p` is pending, and passes its result through. */
  async function trackLoad<T>(p: Promise<T>): Promise<T> {
    const end = start();
    try {
      return await p;
    } finally {
      end();
    }
  }

  return { count, active, barVisible, start, trackLoad };
});
