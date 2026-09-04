import { describe, expect, it } from 'vitest';
import { virtualWindow } from '../src/lib/virtual-window';

// The board's window math. Every case here is one the Агенти column actually reaches: a
// list that has never been scrolled (nothing measured), a list scrolled into its middle
// (mixed measured/estimated rows), and the two ends.
const PAGE = 20;
const ESTIMATE = 100;

function fixed(count: number, height = 0) {
  return { count, heightAt: () => height };
}

describe('virtualWindow', () => {
  it('mounts nothing for an empty list', () => {
    expect(
      virtualWindow({ ...fixed(0), scrollTop: 0, viewport: 700, estimate: ESTIMATE, page: PAGE }),
    ).toEqual({ start: 0, end: 0, padTop: 0, padBottom: 0 });
  });

  // The first paint: no row has ever been on screen, so every height is the estimate. The
  // bottom spacer is what gives the column a scrollbar at all before anything is measured.
  it('stands the estimate in for unmeasured rows', () => {
    const w = virtualWindow({
      ...fixed(100),
      scrollTop: 0,
      viewport: 700,
      estimate: ESTIMATE,
      page: PAGE,
    });
    expect(w).toEqual({ start: 0, end: 40, padTop: 0, padBottom: 6000 });
  });

  // Scrolled into the middle: the window is whole PAGES around the fold, and the spacers
  // account for every row outside it — the total height the two spacers plus the mounted
  // rows add up to must not move, or the scrollbar jumps under the pointer.
  it('quantises the window to pages and pads the rest', () => {
    const w = virtualWindow({
      ...fixed(100, ESTIMATE),
      scrollTop: 2500,
      viewport: 700,
      estimate: ESTIMATE,
      page: PAGE,
    });
    expect(w).toEqual({ start: 20, end: 60, padTop: 2000, padBottom: 4000 });
    expect(w.padTop + (w.end - w.start) * ESTIMATE + w.padBottom).toBe(100 * ESTIMATE);
  });

  // Real cards differ in height (the accounting line is absent until an agent has spent
  // something), so the pads are sums of what was measured, never count × estimate.
  it('sums measured heights, falling back to the estimate row by row', () => {
    const heights = [200, 0, 50, 0, 300];
    const w = virtualWindow({
      count: heights.length,
      heightAt: (i) => heights[i]!,
      scrollTop: 0,
      viewport: 120,
      estimate: ESTIMATE,
      page: 2,
    });
    // Rows 0–1 cover the 120px viewport, so the last visible row is on page 0; one page of
    // overscan mounts page 1 as well, leaving row 4 to the bottom spacer.
    expect(w).toEqual({ start: 0, end: 4, padTop: 0, padBottom: 300 });
  });

  // A shrinking list (a search query, a bucket switch) can leave the scroller parked past
  // the new end for one frame. The window must stay a valid slice rather than run off it.
  it('clamps a scroll position past the end onto the last row', () => {
    const w = virtualWindow({
      ...fixed(25, ESTIMATE),
      scrollTop: 999_999,
      viewport: 700,
      estimate: ESTIMATE,
      page: PAGE,
    });
    expect(w.start).toBe(20);
    expect(w.end).toBe(25);
    expect(w.padTop).toBe(2000);
    expect(w.padBottom).toBe(0);
  });

  // The list sits below a header and the notices in the same scroller, so its own offset is
  // negative until the operator scrolls down to it. That is «page one», not a fault.
  it('treats a list still below the fold as unscrolled', () => {
    const w = virtualWindow({
      ...fixed(50, ESTIMATE),
      scrollTop: -180,
      viewport: 700,
      estimate: ESTIMATE,
      page: PAGE,
    });
    expect(w.start).toBe(0);
    expect(w.padTop).toBe(0);
  });

  // Before the first measurement the viewport is 0 (the element is not laid out yet). A
  // window of nothing would render a blank column that never recovers, because with no rows
  // mounted there is nothing to measure and nothing to trigger the next pass.
  it('still mounts the first page with no viewport measured yet', () => {
    const w = virtualWindow({
      ...fixed(100),
      scrollTop: 0,
      viewport: 0,
      estimate: ESTIMATE,
      page: PAGE,
    });
    expect(w.start).toBe(0);
    expect(w.end).toBe(40);
  });

  it('mounts a list shorter than one page whole', () => {
    const w = virtualWindow({
      ...fixed(7, ESTIMATE),
      scrollTop: 0,
      viewport: 700,
      estimate: ESTIMATE,
      page: PAGE,
    });
    expect(w).toEqual({ start: 0, end: 7, padTop: 0, padBottom: 0 });
  });
});
