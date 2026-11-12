// apps/ui/src/composables/useHeldTranscript.ts
import { onScopeDispose, watch } from 'vue';
import { useOrchestrator } from '../stores/orchestrator';

/**
 * Keeps the transcript of the session `id()` names resident for as long as the calling scope
 * lives (a page, or a store's setup): the orchestrator store evicts the least recently used
 * transcripts past its cap, and the one on screen must never be among them.
 *
 * The new id is held before the previous one is released: a release may evict, and the
 * transcript being switched to has to be safe by then. `flush: 'sync'` leaves no gap in which a
 * socket event could evict the one just selected.
 */
export function useHeldTranscript(id: () => string | null | undefined): void {
  const store = useOrchestrator();
  let release: (() => void) | undefined;
  watch(
    id,
    (next) => {
      const previous = release;
      release = next ? store.holdTranscript(next) : undefined;
      previous?.();
    },
    { immediate: true, flush: 'sync' },
  );
  onScopeDispose(() => {
    release?.();
    release = undefined;
  });
}
