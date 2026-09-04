// apps/ui/src/composables/useVirtualList.ts
import { computed, onBeforeUnmount, onMounted, onUpdated, ref, watch, type Ref } from 'vue';
import { virtualWindow, type VirtualWindow } from '../lib/virtual-window';

export interface VirtualListOptions {
  /** The element that scrolls. Its `clientHeight` is the viewport. */
  root: Ref<HTMLElement | null>;
  /**
   * The rows' own container inside `root`. Its children are the two spacers plus the mounted
   * rows, each carrying `data-vkey` — that attribute is how a measurement finds its row.
   */
  list: Ref<HTMLElement | null>;
  /** Rows in the whole list, read reactively. */
  count: () => number;
  /** The key of row `index`, read reactively. Keys must be stable across renders. */
  keyAt: (index: number) => string;
  /** Rows per mounted page. */
  page?: number;
  /** Height assumed for a row that has never been on screen. */
  estimate?: number;
}

/**
 * A windowed list over an existing scroll container: only the pages around the fold are
 * mounted, two spacers stand in for the rest, and heights are measured off the real rows so
 * the scrollbar tells the truth about a list of variable-height cards.
 *
 * The host keeps its own markup and its own scrolling element — this composable adds no
 * wrapper and takes no ownership of the layout. It needs exactly two things from the
 * template: `data-vkey` on every row, and the two spacers sized from `window`.
 */
export function useVirtualList(opts: VirtualListOptions) {
  const page = opts.page ?? 20;
  const estimate = opts.estimate ?? 96;

  // Measured heights, keyed by the row's own key rather than by its index: a search query or
  // a reorder changes what index N is, and a height carried over to the wrong row shows up as
  // a scrollbar that jumps while you drag it. Deliberately NOT reactive — a Map rewritten on
  // every resize would turn each measurement into a render — with `measured` as the one signal
  // that something in it moved.
  const heights = new Map<string, number>();
  const measured = ref(0);

  const scrollTop = ref(0);
  const viewport = ref(0);
  // Where the rows start inside the scrolling content. The header, the search box and the
  // scope notices sit above them in the same scroller, so the raw `scrollTop` is not the
  // list's own offset. Measured rather than assumed: the notices come and go with the scope.
  const listTop = ref(0);

  const window_ = computed<VirtualWindow>(() => {
    // The dependency that makes a fresh measurement recompute the window; `heights` itself is
    // a plain Map and reads of it are invisible to the reactivity system.
    void measured.value;
    return virtualWindow({
      count: opts.count(),
      heightAt: (i) => heights.get(opts.keyAt(i)) ?? 0,
      scrollTop: scrollTop.value - listTop.value,
      viewport: viewport.value,
      estimate,
      page,
    });
  });

  // Geometry, read in one go. Called after every render and on every resize, never from the
  // scroll handler: `getBoundingClientRect` forces layout, and a scroll listener that did it
  // would pay for a reflow per wheel tick to learn something only a re-render can change.
  function measureFrame(): void {
    const root = opts.root.value;
    const list = opts.list.value;
    if (!root || !list) return;
    viewport.value = root.clientHeight;
    listTop.value = list.getBoundingClientRect().top - root.getBoundingClientRect().top + root.scrollTop;
    scrollTop.value = root.scrollTop;
  }

  // Every mounted row's real height, gap included (the row wrapper carries it as padding, so
  // `offsetHeight` covers it). Runs after Vue has written the DOM, so the reads share one
  // layout pass. A height that actually changed bumps `measured`, which recomputes the window
  // and lands here once more — the second pass finds nothing new and settles.
  function measureRows(): void {
    const list = opts.list.value;
    if (!list) return;
    let changed = false;
    for (const child of list.children) {
      const el = child as HTMLElement;
      const key = el.dataset.vkey;
      if (!key) continue; // the spacers
      const h = el.offsetHeight;
      if (h > 0 && heights.get(key) !== h) {
        heights.set(key, h);
        changed = true;
      }
    }
    if (changed) measured.value += 1;
  }

  function onScroll(): void {
    const root = opts.root.value;
    if (root) scrollTop.value = root.scrollTop;
  }

  // Card heights depend on the column's width, which the seam between the board and the chat
  // drags live — so a resize invalidates every measurement, not just the viewport.
  const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => {
    heights.clear();
    measured.value += 1;
    measureFrame();
    measureRows();
  });

  watch(
    opts.root,
    (root, previous) => {
      if (previous) {
        previous.removeEventListener('scroll', onScroll);
        observer?.unobserve(previous);
      }
      if (root) {
        root.addEventListener('scroll', onScroll, { passive: true });
        observer?.observe(root);
        measureFrame();
      }
    },
    { immediate: true },
  );

  onMounted(() => {
    measureFrame();
    measureRows();
  });
  onUpdated(() => {
    measureFrame();
    measureRows();
  });
  onBeforeUnmount(() => {
    opts.root.value?.removeEventListener('scroll', onScroll);
    observer?.disconnect();
  });

  return { window: window_ };
}
