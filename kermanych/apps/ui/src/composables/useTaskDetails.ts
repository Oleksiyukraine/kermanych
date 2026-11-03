// apps/ui/src/composables/useTaskDetails.ts
import { onScopeDispose, watch } from 'vue';
import { useBoard } from '../stores/board';

// Holds the card `id()` names in the board store for as long as the calling component lives, so
// its QA checklist and «Документація» report are read and kept current: the board's list leaves
// those two blobs out (cloud TASK_LIST_COLUMNS). A changed id moves the hold; undefined holds
// nothing.
export function useTaskDetails(id: () => string | undefined): void {
  const board = useBoard();
  let release: (() => void) | undefined;
  watch(
    id,
    (next) => {
      release?.();
      release = next ? board.holdDetails(next) : undefined;
    },
    { immediate: true },
  );
  onScopeDispose(() => release?.());
}
