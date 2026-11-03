// apps/ui/src/composables/useCircleGesture.ts
// The window listener around lib/circle-gesture.ts: pointer moves anywhere in the renderer are
// fed to the recogniser while `enabled` reads true, and `onCircle` runs once per circle. Moves
// over the session browser's native view never reach the renderer, so the gesture is simply
// not there — the same limit the spec states (docs/specs/2026-11-03-assistant-overlay.md).
import { onMounted, onUnmounted, type Ref } from 'vue';
import { createCircleRecognizer } from '../lib/circle-gesture';

// After a hit: a hand finishing its circle easily overshoots into the start of a second one,
// and that must not close what the first one just opened.
const COOLDOWN_MS = 1000;

export function useCircleGesture(enabled: Ref<boolean>, onCircle: () => void): void {
  const rec = createCircleRecognizer();
  let quietUntil = 0;

  function onMove(e: PointerEvent): void {
    // A finger or a pen draws on a touch screen; there a circle is a pan, not a summons.
    if (!enabled.value || e.pointerType !== 'mouse') return;
    if (!rec.move({ x: e.clientX, y: e.clientY, t: e.timeStamp }, e.buttons)) return;
    if (e.timeStamp < quietUntil) return;
    quietUntil = e.timeStamp + COOLDOWN_MS;
    onCircle();
  }
  // Leaving the window or pressing a button breaks the stroke.
  const reset = (): void => rec.reset();

  onMounted(() => {
    window.addEventListener('pointermove', onMove, { capture: true, passive: true });
    window.addEventListener('pointerdown', reset, { capture: true, passive: true });
    window.addEventListener('blur', reset);
  });
  onUnmounted(() => {
    window.removeEventListener('pointermove', onMove, { capture: true });
    window.removeEventListener('pointerdown', reset, { capture: true });
    window.removeEventListener('blur', reset);
  });
}
