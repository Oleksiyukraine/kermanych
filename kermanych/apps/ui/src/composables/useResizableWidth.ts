// apps/ui/src/composables/useResizableWidth.ts
import { onBeforeUnmount, onMounted, ref } from 'vue';

export interface ResizableWidthOptions {
  /** localStorage key used to persist the width across reloads. */
  storageKey: string;
  /** Width in px used when nothing is persisted yet. */
  defaultWidth: number;
  /** Smallest allowed width in px. */
  min: number;
  /**
   * Largest allowed width. A number for a fixed cap, or a getter evaluated on
   * every drag/clamp so it can track a live container size. Return
   * `Number.POSITIVE_INFINITY` while the container is not yet measurable.
   */
  max: number | (() => number);
  /**
   * Which edge carries the drag handle. 'left' (default) grows the panel when
   * the pointer moves left; 'right' mirrors it.
   */
  edge?: 'left' | 'right';
  /** Keyboard step in px for Arrow keys (Shift = 3× for coarse moves). */
  step?: number;
}

// A shrinking viewport can drive max below min — never let the hi bound cross it.
function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max));
}

// A persistent, clamped panel width driven by a pointer-drag handle. Direction,
// bounds, and the storage key are supplied by the host; the composable owns the
// pointer capture, keyboard nudging, persistence, and viewport-resize clamping.
export function useResizableWidth(opts: ResizableWidthOptions) {
  const step = opts.step ?? 16;
  // Sign of a rightward pointer delta that should widen the panel.
  const grow = opts.edge === 'right' ? 1 : -1;

  function readStored(): number | null {
    try {
      const raw = localStorage.getItem(opts.storageKey);
      const n = raw == null ? NaN : Number(raw);
      return Number.isFinite(n) ? n : null;
    } catch {
      return null;
    }
  }

  const width = ref(
    clamp(
      readStored() ?? opts.defaultWidth,
      opts.min,
      typeof opts.max === 'function' ? opts.max() : opts.max,
    ),
  );
  const resizing = ref(false);

  function persist(): void {
    try {
      localStorage.setItem(opts.storageKey, String(Math.round(width.value)));
    } catch {
      /* storage unavailable (private mode / SSR) — width still works in-memory */
    }
  }

  function set(px: number): void {
    const max = typeof opts.max === 'function' ? opts.max() : opts.max;
    width.value = clamp(px, opts.min, max);
  }

  function startResize(ev: PointerEvent): void {
    // Only the primary button drags; ignore right/middle clicks.
    if (ev.button !== 0) return;
    ev.preventDefault();
    const handle = ev.currentTarget as HTMLElement;
    const startX = ev.clientX;
    const startWidth = width.value;
    resizing.value = true;

    const onMove = (e: PointerEvent): void => {
      set(startWidth + (e.clientX - startX) * grow);
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

  // ArrowLeft/ArrowRight move the separator itself; growth follows `edge`.
  function onKeydown(e: KeyboardEvent): void {
    const delta = e.shiftKey ? step * 3 : step;
    if (e.key === 'ArrowLeft') set(width.value + -delta * grow);
    else if (e.key === 'ArrowRight') set(width.value + delta * grow);
    else return;
    e.preventDefault();
    persist();
  }

  // Re-clamp against the live max — the host calls this when the container
  // becomes measurable; the viewport-resize listener keeps it honest after.
  function refresh(): void {
    set(width.value);
  }

  onMounted(() => window.addEventListener('resize', refresh));
  onBeforeUnmount(() => window.removeEventListener('resize', refresh));

  return { width, resizing, startResize, onKeydown, refresh };
}
