// apps/ui/src/composables/useOptimisticValue.ts
import { computed, onScopeDispose, ref, watch, type ComputedRef, type Ref } from 'vue';
import { PENDING_TIMEOUT_MS } from '../stores/pending';
import { useAsyncAction, type AsyncActionOptions } from './useAsyncAction';

/**
 * A save-on-change control (select, checkbox, chip) whose value comes from the server.
 *
 * Without this the control shows the OLD value until the write answers — the pick looks ignored.
 * Here `value` is the picked value while the save runs, `pending` is true (bind it to the
 * control's `loading`, which also disables it, so writes cannot race), and on failure the
 * picked value is dropped: the control returns to `source()` and the error is a toast.
 *
 * A source fed by a later echo (`session.model` after `session_update`) may still hold the old
 * value when the save resolves; the picked value is kept until the source reports it (or
 * `PENDING_TIMEOUT_MS`), so the control does not flick back and forth.
 */
export function useOptimisticValue<T>(
  source: () => T,
  save: (next: T) => Promise<unknown>,
  options: AsyncActionOptions = {},
): { value: ComputedRef<T>; pending: Readonly<Ref<boolean>>; set: (next: T) => Promise<void> } {
  const picked = ref<{ v: T }>();
  let cancelHold: (() => void) | undefined;

  function drop(): void {
    cancelHold?.();
    cancelHold = undefined;
    picked.value = undefined;
  }

  const action = useAsyncAction(
    async (next: T) => {
      drop();
      picked.value = { v: next };
      try {
        await save(next);
      } catch (e) {
        drop();
        throw e;
      }
      if (Object.is(source(), next)) {
        drop();
        return;
      }
      const stop = watch(source, (v) => {
        if (Object.is(v, next)) drop();
      }, { flush: 'sync' });
      const timer = setTimeout(drop, PENDING_TIMEOUT_MS);
      cancelHold = () => {
        stop();
        clearTimeout(timer);
      };
    },
    options,
  );

  onScopeDispose(drop);

  return {
    value: computed(() => (picked.value ? (picked.value.v as T) : source())),
    pending: action.busy,
    set: async (next: T) => {
      await action.run(next);
    },
  };
}
