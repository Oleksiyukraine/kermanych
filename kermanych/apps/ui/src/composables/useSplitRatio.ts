// apps/ui/src/composables/useSplitRatio.ts
import { ref } from 'vue';

const MIN = 0.15;
const STEP = 0.02;

/**
 * A two-way split as a share of the width (KSplitPanes, KDiffRows' columns), driven by a
 * pointer-drag handle and the arrow keys. A ratio rather than px because the same split sits
 * in a list block and in a full-screen overlay: a share carries over between the two where a
 * px width would not. Each side keeps at least `MIN` of the width.
 *
 * With `storageKey` the ratio is remembered on this device (localStorage, every access
 * guarded) and shared by every split using that key; without one it lives with the component.
 *
 * The drag captures the pointer on the handle, so a pass over an iframe (a PDF or HTML
 * preview) keeps reporting moves instead of feeding them to the frame. The caller maps a
 * pointer x to a ratio (`toRatio`), since only it knows which part of its box is shared out.
 */
export function useSplitRatio(storageKey?: string) {
  const clamp = (r: number): number => Math.min(1 - MIN, Math.max(MIN, r));

  function readStored(): number {
    if (!storageKey) return 0.5;
    try {
      const n = Number(localStorage.getItem(storageKey));
      return Number.isFinite(n) && n > 0 ? clamp(n) : 0.5;
    } catch {
      return 0.5;
    }
  }

  const ratio = ref(readStored());
  const resizing = ref(false);

  function setRatio(r: number, persist: boolean): void {
    ratio.value = clamp(r);
    if (!persist || !storageKey) return;
    try {
      localStorage.setItem(storageKey, ratio.value.toFixed(3));
    } catch {
      // storage refused: the split still works for this session
    }
  }

  function startResize(ev: PointerEvent, toRatio: (clientX: number) => number): void {
    if (ev.button !== 0) return;
    ev.preventDefault();
    const handle = ev.currentTarget as HTMLElement;
    handle.setPointerCapture(ev.pointerId);
    resizing.value = true;
    const move = (e: PointerEvent): void => setRatio(toRatio(e.clientX), false);
    const end = (): void => {
      resizing.value = false;
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', end);
      handle.removeEventListener('pointercancel', end);
      setRatio(ratio.value, true);
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', end);
    handle.addEventListener('pointercancel', end);
  }

  function onKeydown(e: KeyboardEvent): void {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    const step = (e.shiftKey ? 3 : 1) * STEP;
    setRatio(ratio.value + (e.key === 'ArrowRight' ? step : -step), true);
  }

  function reset(): void {
    setRatio(0.5, true);
  }

  return { ratio, resizing, min: MIN, startResize, onKeydown, reset };
}
