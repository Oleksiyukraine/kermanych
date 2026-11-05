// apps/ui/src/composables/useRememberedChoice.ts
import { ref, watch, type Ref } from 'vue';

/**
 * A filter pick remembered on this device, per scope — the Jira / Linear boards' assignee
 * chip, per board. `storageKey()` names the scope ('' while there is none: nothing is read or
 * written); switching scope loads that scope's pick. '' is the resting value («anyone»).
 *
 * A remembered pick can outlive its option (the person no longer holds a card): once the
 * scope's data has loaded (`ready`), a pick missing from `options` falls back to '' — so the
 * board is never left empty by a filter for someone who is gone. Not before: while the data
 * is still loading the options are incomplete, and the check would throw a good pick away.
 * Every storage access is guarded; refused storage only means the pick lasts for the session.
 */
export function useRememberedChoice(
  storageKey: () => string,
  options: () => readonly { value: string }[],
  ready: () => boolean,
): Ref<string> {
  function read(key: string): string {
    if (!key) return '';
    try {
      return localStorage.getItem(key) ?? '';
    } catch {
      return '';
    }
  }

  const value = ref(read(storageKey()));

  watch(storageKey, (key) => {
    value.value = read(key);
  });

  watch(value, (v) => {
    const key = storageKey();
    if (!key) return;
    try {
      if (v) localStorage.setItem(key, v);
      else localStorage.removeItem(key);
    } catch {
      // storage refused: the pick still holds for this session
    }
  });

  watch(
    [options, ready],
    ([opts, isReady]) => {
      if (isReady && value.value && !opts.some((o) => o.value === value.value)) value.value = '';
    },
  );

  return value;
}
