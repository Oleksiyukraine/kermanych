// apps/ui/src/lib/virtual-window.ts
// Which slice of a long list is worth mounting, and how much empty space stands in for the
// rest. Split out of the component for the tasks-view.ts reason: it is arithmetic with edge
// cases — a row nobody has measured yet, a list shorter than the viewport, a scroll position
// past the end — and apps/ui has no component tests.
//
// The window is always a whole number of PAGES: the operator scrolls, and rows arrive twenty
// at a time. Page-quantising the window (rather than trimming it to exactly the visible rows)
// is what keeps the mounted set stable while the pointer drifts inside one screenful — a
// window recomputed row by row would mount and unmount a card per scrolled pixel.

export type VirtualWindowInput = {
  /** Rows in the whole list. */
  count: number;
  /**
   * A row's measured height in px, INCLUDING the gap below it, or 0 when it has never been
   * on screen. Unmeasured rows are worth `estimate`, which is what makes the scrollbar
   * plausible before the list has been scrolled through once.
   */
  heightAt: (index: number) => number;
  /** Viewport offset relative to the FIRST row's top edge. Clamped at 0. */
  scrollTop: number;
  /** Visible height of the scrolling element. */
  viewport: number;
  /** Height assumed for a row nobody has measured. */
  estimate: number;
  /** Rows per page. */
  page: number;
};

export type VirtualWindow = {
  /** First mounted row (inclusive). */
  start: number;
  /** Last mounted row (exclusive). */
  end: number;
  /** Height of the spacer standing in for rows `0 … start`. */
  padTop: number;
  /** Height of the spacer standing in for rows `end … count`. */
  padBottom: number;
};

export function virtualWindow(input: VirtualWindowInput): VirtualWindow {
  const { count, viewport } = input;
  if (count <= 0) return { start: 0, end: 0, padTop: 0, padBottom: 0 };
  const page = Math.max(1, Math.floor(input.page));
  const height = (i: number): number => {
    const measured = input.heightAt(i);
    return measured > 0 ? measured : input.estimate;
  };

  // Walk to the first row the viewport touches, summing as we go: the sum IS the top spacer
  // up to that row, so one pass answers both questions. A list is hundreds of rows at worst,
  // and this runs once per scroll event — a prefix-sum array would cost an allocation per
  // recompute to save microseconds.
  const top = Math.max(0, input.scrollTop);
  const bottom = top + Math.max(0, viewport);
  let first = 0;
  let y = 0;
  while (first < count - 1 && y + height(first) <= top) {
    y += height(first);
    first += 1;
  }
  let last = first;
  let consumed = y + height(first);
  while (last < count - 1 && consumed < bottom) {
    last += 1;
    consumed += height(last);
  }

  // One page of overscan past the last visible row. Without it a fast scroll can outrun the
  // next render and flash the bottom spacer; with it the row after the fold is already
  // mounted and measured, so its estimate never has to be believed.
  const start = Math.floor(first / page) * page;
  const end = Math.min(count, (Math.floor(last / page) + 2) * page);

  let padTop = 0;
  for (let i = 0; i < start; i += 1) padTop += height(i);
  let padBottom = 0;
  for (let i = end; i < count; i += 1) padBottom += height(i);
  return { start, end, padTop, padBottom };
}
