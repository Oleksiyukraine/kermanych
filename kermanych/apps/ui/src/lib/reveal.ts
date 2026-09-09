import { nextTick } from 'vue';

// The growing-circle wipe shared by the two device-local screen preferences —
// the theme (lib/theme.ts) and the language (lib/locale.ts). Both are a single
// full-repaint swap of the whole shell, which is exactly the case the View
// Transitions API is worth its cost for: it holds the page as two stacked
// snapshots while a clip-path grows the incoming one from the pressed control.

// Reveal duration. Long enough to read as a wipe across a full window, short
// enough that the frozen snapshot below is not felt as lag.
const REVEAL_MS = 480;

/**
 * Run `swap` — the state mutation that repaints the app — under a circle that
 * grows from `origin` (the control that was activated) to the furthest viewport
 * corner.
 *
 * Instant fallbacks: an engine without the API, and an operator who asked for
 * less motion — a full-screen wipe is precisely what that preference covers.
 *
 * The caller's reactive write may run its effects pre-flush, so this helper
 * awaits the flush itself before the browser captures the "new" snapshot —
 * otherwise the reveal wipes in the OLD paint. The caller's `swap` therefore
 * only has to perform the write, not the tick.
 */
export function revealSwap(origin: DOMRect | null | undefined, swap: () => void): void {
  if (
    typeof document === 'undefined' ||
    !document.startViewTransition ||
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  ) {
    swap();
    return;
  }

  const transition = document.startViewTransition(async () => {
    swap();
    await nextTick();
  });

  void transition.ready
    .then(() => {
      const { innerWidth: w, innerHeight: h } = window;
      const x = origin ? origin.left + origin.width / 2 : w / 2;
      const y = origin ? origin.top + origin.height / 2 : h / 2;
      // Reach for the furthest corner: any smaller radius stops short of the
      // opposite edge and leaves a crescent of the old paint behind.
      const radius = Math.hypot(Math.max(x, w - x), Math.max(y, h - y));
      document.documentElement.animate(
        { clipPath: [`circle(0px at ${x}px ${y}px)`, `circle(${radius}px at ${x}px ${y}px)`] },
        {
          duration: REVEAL_MS,
          easing: 'ease-in-out',
          pseudoElement: '::view-transition-new(root)',
        },
      );
    })
    .catch(() => {
      // Skipped transition — a second activation mid-flight, or a hidden tab.
      // The state itself already changed; only the animation is lost.
    });
}
