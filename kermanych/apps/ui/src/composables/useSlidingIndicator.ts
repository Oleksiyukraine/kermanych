// apps/ui/src/composables/useSlidingIndicator.ts
import { nextTick, onBeforeUnmount, onMounted, ref, watch, type Ref } from 'vue';

// Geometry for ONE indicator element that travels between the items of a nav
// strip, instead of a border/fill applied to each item. The travel is the whole
// point: it carries the eye from the old section to the new one, which a
// per-item border cannot do, and it costs one transform rather than repainting
// every item.
//
// Items opt in with `data-nav-value="<value>"`; the caller binds `x`/`width`
// into CSS custom properties. `animate` stays false for the first frame so a
// freshly mounted strip does not slide in from the left edge, and every measure
// runs AFTER the DOM settles, so an item whose content changed is measured as it
// actually renders.
export function useSlidingIndicator(container: Ref<HTMLElement | null>, active: Ref<string>) {
  const x = ref(0);
  const width = ref(0);
  // No item matched `active` (unknown route, empty strip) — the caller hides the
  // indicator rather than parking it at 0 with zero width.
  const ready = ref(false);
  const animate = ref(false);

  function measure(): void {
    const root = container.value;
    if (!root) return;
    const el = root.querySelector<HTMLElement>(`[data-nav-value="${CSS.escape(active.value)}"]`);
    if (!el) {
      ready.value = false;
      return;
    }
    // offsetLeft is relative to the strip (position: relative), which is exactly
    // the coordinate space the indicator is absolutely positioned in.
    x.value = el.offsetLeft;
    width.value = el.offsetWidth;
    ready.value = true;
  }

  // A resized strip (sidebar collapse, window drag, theme change reflow) moves
  // the active item without any state change of ours.
  let ro: ResizeObserver | undefined;

  onMounted(() => {
    measure();
    // One frame later: the first geometry lands without a transition, everything
    // after it animates.
    requestAnimationFrame(() => {
      animate.value = true;
    });
    if (container.value && typeof ResizeObserver !== 'undefined') {
      ro = new ResizeObserver(() => measure());
      ro.observe(container.value);
    }
  });

  onBeforeUnmount(() => ro?.disconnect());

  watch(active, () => void nextTick(measure));

  return { x, width, ready, animate, measure };
}
