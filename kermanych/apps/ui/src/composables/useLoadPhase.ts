// apps/ui/src/composables/useLoadPhase.ts
import { computed, type ComputedRef } from 'vue';
import { useDelayedTrue } from './useDelayedTrue';

/** A skeleton appears only for a load that has run this long… */
export const SKELETON_DELAY_MS = 150;
/** …and, once shown, stays at least this long, so it never flashes for a frame. */
export const SKELETON_MIN_MS = 300;

export type LoadPhase = 'blank' | 'skeleton' | 'ready';

/**
 * What a data area renders while its data is not loaded (README «Design → Async states»):
 *
 * - `blank` — loading, under `SKELETON_DELAY_MS`: render nothing. Never the empty state.
 * - `skeleton` — loading longer (or the skeleton's minimum time is not up): `KSkeleton`.
 * - `ready` — loaded: the content, or the empty state if the data really is empty.
 *
 * `notLoaded` is «the data for the CURRENT scope has not arrived» — typically
 * `store.byWorkspace[id] === undefined`, a `loadedFor !== scope` check, or a store `loading`
 * flag combined with «nothing to show yet». A refresh of data already on screen is not
 * «not loaded»: it keeps the content and at most drives the top progress bar.
 */
export function useLoadPhase(notLoaded: () => boolean): ComputedRef<LoadPhase> {
  const skeleton = useDelayedTrue(notLoaded, SKELETON_DELAY_MS, { minMs: SKELETON_MIN_MS });
  return computed(() => (skeleton.value ? 'skeleton' : notLoaded() ? 'blank' : 'ready'));
}
