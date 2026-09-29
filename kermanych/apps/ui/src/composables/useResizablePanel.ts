// apps/ui/src/composables/useResizablePanel.ts
import { onBeforeUnmount, onMounted, ref } from 'vue';

export interface ResizablePanelOptions {
  /** localStorage key used to persist the size across reloads. */
  storageKey: string;
  /** Size in px used when nothing is persisted yet. */
  defaultSize: number;
  /** Smallest allowed size in px. */
  min: number;
  /**
   * Largest allowed size. A number for a fixed cap, or a getter evaluated on
   * every drag/clamp so it can track a live container size. Return
   * `Number.POSITIVE_INFINITY` while the container is not yet measurable.
   */
  max: number | (() => number);
  /**
   * Which edge carries the drag handle. 'left' (default) grows the panel's width
   * when the pointer moves left, 'right' mirrors it; 'top' grows its height when
   * the pointer moves up, 'bottom' mirrors that.
   */
  edge?: 'left' | 'right' | 'top' | 'bottom';
  /** Keyboard step in px for Arrow keys (Shift = 3× for coarse moves). */
  step?: number;
}

// A shrinking viewport can drive max below min — never let the hi bound cross it.
function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max));
}

// A persistent, clamped panel size (a width for a side edge, a height for top/bottom)
// driven by a pointer-drag handle. Direction, bounds, and the storage key are supplied by
// the host; the composable owns the pointer capture, keyboard nudging, persistence, and
// viewport-resize clamping.
export function useResizablePanel(opts: ResizablePanelOptions) {
  const step = opts.step ?? 16;
  const vertical = opts.edge === 'top' || opts.edge === 'bottom';
  // Sign of a rightward (downward, for a vertical panel) pointer delta that grows the panel.
  const grow = opts.edge === 'right' || opts.edge === 'bottom' ? 1 : -1;

  function readStored(): number | null {
    try {
      const raw = localStorage.getItem(opts.storageKey);
      const n = raw == null ? NaN : Number(raw);
      return Number.isFinite(n) ? n : null;
    } catch {
      return null;
    }
  }

  const size = ref(
    clamp(
      readStored() ?? opts.defaultSize,
      opts.min,
      typeof opts.max === 'function' ? opts.max() : opts.max,
    ),
  );
  const resizing = ref(false);

  function persist(): void {
    try {
      localStorage.setItem(opts.storageKey, String(Math.round(size.value)));
    } catch {
      /* storage unavailable (private mode / SSR) — size still works in-memory */
    }
  }

  function set(px: number): void {
    const max = typeof opts.max === 'function' ? opts.max() : opts.max;
    size.value = clamp(px, opts.min, max);
  }

  function startResize(ev: PointerEvent): void {
    // Only the primary button drags; ignore right/middle clicks.
    if (ev.button !== 0) return;
    ev.preventDefault();
    const handle = ev.currentTarget as HTMLElement;
    const start = vertical ? ev.clientY : ev.clientX;
    const startSize = size.value;
    resizing.value = true;

    const onMove = (e: PointerEvent): void => {
      set(startSize + ((vertical ? e.clientY : e.clientX) - start) * grow);
    };
    const onUp = (): void => {
      resizing.value = false;
      handle.removeEventListener('pointermove', onMove);
      handle.removeEventListener('pointerup', onUp);
      handle.removeEventListener('pointercancel', onUp);
      try {
        handle.releasePointerCapture(ev.pointerId);
      } catch {
        /* pointer already released */
      }
      persist();
    };

    // Listeners live on the handle; pointer capture retargets every move to it,
    // so a fast drag that leaves the 7px strip keeps resizing. Capture can throw
    // if the pointer is already gone — the drag still works without it.
    handle.addEventListener('pointermove', onMove);
    handle.addEventListener('pointerup', onUp);
    handle.addEventListener('pointercancel', onUp);
    try {
      handle.setPointerCapture(ev.pointerId);
    } catch {
      /* no active pointer to capture */
    }
  }

  // The arrow keys along the panel's axis move the separator itself; growth follows `edge`.
  function onKeydown(e: KeyboardEvent): void {
    const delta = e.shiftKey ? step * 3 : step;
    const [back, forward] = vertical ? ['ArrowUp', 'ArrowDown'] : ['ArrowLeft', 'ArrowRight'];
    if (e.key === back) set(size.value + -delta * grow);
    else if (e.key === forward) set(size.value + delta * grow);
    else return;
    e.preventDefault();
    persist();
  }

  // Re-clamp against the live max — the host calls this when the container
  // becomes measurable; the viewport-resize listener keeps it honest after.
  function refresh(): void {
    set(size.value);
  }

  onMounted(() => window.addEventListener('resize', refresh));
  onBeforeUnmount(() => window.removeEventListener('resize', refresh));

  return { size, resizing, startResize, onKeydown, refresh };
}
