// apps/ui/src/composables/useAsyncAction.ts
import { reactive, readonly, ref, type Ref } from 'vue';
import { useActivity } from '../stores/activity';
import { useOrchestrator } from '../stores/orchestrator';

export interface AsyncActionOptions {
  /**
   * Replaces the default error toast — a modal renders the error inside itself. Called with the
   * thrown value; the action still resolves to `undefined`.
   */
  onError?: (e: unknown) => void;
}

/** The one place a thrown value becomes operator-facing text. `ApiError` is already localised. */
export function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * The busy affordance for an async action, in one place instead of a hand-rolled flag per
 * handler (README «Design → Async states»).
 *
 * - `busy` is true while `fn` runs: bind it to `:loading` on the control.
 * - `run` while `busy` returns `undefined` without calling `fn` — one guard for the button,
 *   Enter and ⌘-shortcut paths.
 * - The call counts as foreground activity, so the top progress bar shows if it runs long.
 * - A failure becomes a toast (or `onError`), never an unhandled rejection.
 */
export function useAsyncAction<A extends unknown[], R>(
  fn: (...args: A) => Promise<R>,
  options: AsyncActionOptions = {},
): { run: (...args: A) => Promise<R | undefined>; busy: Readonly<Ref<boolean>> } {
  const activity = useActivity();
  const orch = useOrchestrator();
  const busy = ref(false);

  async function run(...args: A): Promise<R | undefined> {
    if (busy.value) return undefined;
    busy.value = true;
    const end = activity.start();
    try {
      return await fn(...args);
    } catch (e) {
      if (options.onError) options.onError(e);
      else orch.notify(errorText(e), 'error');
      return undefined;
    } finally {
      end();
      busy.value = false;
    }
  }

  return { run, busy: readonly(busy) };
}

/**
 * `useAsyncAction` for per-row actions: one busy flag per key (a risk row, a member, a vault
 * entry), so pressing ✕ on one row neither blocks nor spins the others.
 */
export function useKeyedAction<A extends unknown[], R>(
  fn: (key: string, ...args: A) => Promise<R>,
  options: AsyncActionOptions = {},
): { run: (key: string, ...args: A) => Promise<R | undefined>; busyFor: (key: string) => boolean; anyBusy: () => boolean } {
  const activity = useActivity();
  const orch = useOrchestrator();
  const busy = reactive(new Set<string>());

  async function run(key: string, ...args: A): Promise<R | undefined> {
    if (busy.has(key)) return undefined;
    busy.add(key);
    const end = activity.start();
    try {
      return await fn(key, ...args);
    } catch (e) {
      if (options.onError) options.onError(e);
      else orch.notify(errorText(e), 'error');
      return undefined;
    } finally {
      end();
      busy.delete(key);
    }
  }

  return { run, busyFor: (key) => busy.has(key), anyBusy: () => busy.size > 0 };
}
