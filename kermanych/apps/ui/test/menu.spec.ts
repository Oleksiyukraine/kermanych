import { describe, expect, it } from 'vitest';
import {
  MENU_EDGE_PX,
  MENU_GAP_PX,
  MENU_MAX_H_PX,
  filterByQuery,
  isAnchorOffscreen,
  matchByPrefix,
  placeMenu,
} from '../src/lib/menu';

// KSelect's list is a `position: fixed` node under <body>, so every case an OS popup used to
// handle for free is now this function's job: a filter at the bottom of the board, a picker
// in the last row of a modal, a control against the right edge of a narrow window.
const VIEWPORT = { width: 1280, height: 800 };

// A trigger 200px wide at (x, y), the shape KSelect measures with getBoundingClientRect.
function anchorAt(x: number, y: number, width = 200, height = 36) {
  return { left: x, top: y, width, bottom: y + height };
}

describe('placeMenu', () => {
  it('opens below the trigger, left edges aligned', () => {
    const at = placeMenu(anchorAt(100, 200), { width: 200, height: 180 }, VIEWPORT);

    expect(at.side).toBe('bottom');
    expect(at.top).toBe(236 + MENU_GAP_PX);
    expect(at.left).toBe(100);
    // Room below (550px) exceeds the cap, so the cap is what the list gets.
    expect(at.maxHeight).toBe(MENU_MAX_H_PX);
  });

  it('flips above when the list does not fit below but does fit above', () => {
    // 60px of room under the trigger, 700 over it, and a 300px list.
    const at = placeMenu(anchorAt(100, 704), { width: 200, height: 300 }, VIEWPORT);

    expect(at.side).toBe('top');
    // Sits its own height above the trigger, gap included.
    expect(at.top).toBe(704 - MENU_GAP_PX - 300);
  });

  it('stays below when below is merely the roomier side, and caps the scroll box there', () => {
    // A short window (a half-height Electron frame): 300px under the trigger, 136 over it,
    // and a list that fits neither. Flipping would only make it shorter.
    const at = placeMenu(anchorAt(100, 150), { width: 200, height: 500 }, { width: 1280, height: 500 });

    expect(at.side).toBe('bottom');
    expect(at.maxHeight).toBe(500 - 186 - MENU_GAP_PX - MENU_EDGE_PX);
  });

  it('never exceeds the scannable cap, however much room there is', () => {
    const at = placeMenu(anchorAt(100, 40), { width: 200, height: 2000 }, VIEWPORT);

    expect(at.maxHeight).toBe(MENU_MAX_H_PX);
  });

  it('keeps a list on screen when its own side has almost no room', () => {
    // Trigger flush against the bottom: the menu takes the floor height and is pulled back
    // over its own trigger rather than being pushed off the viewport.
    const at = placeMenu(anchorAt(100, 770), { width: 200, height: 300 }, VIEWPORT);

    expect(at.top).toBeGreaterThanOrEqual(MENU_EDGE_PX);
    expect(at.top + Math.min(300, at.maxHeight)).toBeLessThanOrEqual(800 - MENU_EDGE_PX);
  });

  it('pulls a menu wider than its trigger back from the right edge', () => {
    const at = placeMenu(anchorAt(1150, 200), { width: 420, height: 180 }, VIEWPORT);

    expect(at.left).toBe(1280 - MENU_EDGE_PX - 420);
  });

  it('starts at the left edge when the menu is wider than the viewport', () => {
    const at = placeMenu(anchorAt(10, 200), { width: 1400, height: 180 }, VIEWPORT);

    expect(at.left).toBe(MENU_EDGE_PX);
  });

  it('returns whole pixels — a fixed node on a half pixel blurs 13px mono', () => {
    const at = placeMenu(anchorAt(100.4, 200.6), { width: 200.5, height: 180.5 }, VIEWPORT);

    expect(at.left).toBe(Math.round(at.left));
    expect(at.top).toBe(Math.round(at.top));
    expect(at.maxHeight).toBe(Math.round(at.maxHeight));
  });

  // KChipSelect's first home is the composer's control row at the very bottom of the screen,
  // where a menu that merely «fits below» still opens into the last 40px of the window. That
  // chip asks for a side; the flip is what happens when the ask cannot be honoured.
  it('honours a preferred side even when the other one also fits', () => {
    const anchor = anchorAt(100, 400);
    const menu = { width: 200, height: 180 };

    // Identical geometry, opposite answers — room on both sides, so only the preference
    // decides.
    expect(placeMenu(anchor, menu, VIEWPORT).side).toBe('bottom');
    expect(placeMenu(anchor, menu, VIEWPORT, 'top').side).toBe('top');
  });

  it('flips a preferred-up menu down when there is no room above', () => {
    // A chip in a toolbar at the top of the view: 6px over it, 730 under it.
    const at = placeMenu(anchorAt(100, 20), { width: 200, height: 300 }, VIEWPORT, 'top');

    expect(at.side).toBe('bottom');
    expect(at.top).toBe(56 + MENU_GAP_PX);
  });

  it('gives a preferred-up menu the roomier side when it fits neither', () => {
    // 136px over the trigger, 300 under it, and a list that fits neither: opening up would
    // only make it shorter than it has to be.
    const at = placeMenu(anchorAt(100, 150), { width: 200, height: 500 }, { width: 1280, height: 500 }, 'top');

    expect(at.side).toBe('bottom');
  });
});

// Extracted from KSelect.place(), which has always closed on a trigger that scrolled out of
// its pane — otherwise the menu is clamped to the viewport edge, floating beside nothing,
// and a pick writes to a control the operator can no longer see. KChipSelect needs the same
// rule, and the awkward cases are cheaper to pin down here than in a browser.
describe('isAnchorOffscreen', () => {
  it('accepts a trigger anywhere in view, including flush against an edge', () => {
    expect(isAnchorOffscreen(anchorAt(100, 200), VIEWPORT)).toBe(false);
    expect(isAnchorOffscreen(anchorAt(0, 0), VIEWPORT)).toBe(false);
    expect(isAnchorOffscreen(anchorAt(1080, 764), VIEWPORT)).toBe(false);
  });

  it('reports a trigger scrolled off the top or bottom', () => {
    // Scrolled up until its bottom edge crosses y=0 — one pixel of it left is still in view.
    expect(isAnchorOffscreen(anchorAt(100, -36), VIEWPORT)).toBe(true);
    expect(isAnchorOffscreen(anchorAt(100, -35), VIEWPORT)).toBe(false);
    expect(isAnchorOffscreen(anchorAt(100, 800), VIEWPORT)).toBe(true);
  });

  it('reports a trigger scrolled off the left or right of a horizontal pane', () => {
    // The Jira board's columns scroll sideways, so this is not a hypothetical axis.
    expect(isAnchorOffscreen(anchorAt(-200, 200), VIEWPORT)).toBe(true);
    expect(isAnchorOffscreen(anchorAt(-199, 200), VIEWPORT)).toBe(false);
    expect(isAnchorOffscreen(anchorAt(1280, 200), VIEWPORT)).toBe(true);
  });
});

// Type-ahead is the one thing a native <select> did that users notice missing. The labels
// here are the board's assignee filter, Cyrillic row included.
const LABELS = ['Усі виконавці', 'Не призначено', 'Oleksiyukraine', 'Rlr0052', 'pmindev'];

describe('matchByPrefix', () => {
  it('finds the first label starting with the prefix, case-insensitively', () => {
    expect(matchByPrefix(LABELS, 'r', 0)).toBe(3);
    expect(matchByPrefix(LABELS, 'PM', 0)).toBe(4);
    expect(matchByPrefix(LABELS, 'не', 0)).toBe(1);
  });

  it('searches from `from` and wraps, so repeated keys cycle', () => {
    // «Усі виконавці» is index 0; searching from the row after it wraps back to it.
    expect(matchByPrefix(LABELS, 'у', 1)).toBe(0);
    expect(matchByPrefix(LABELS, 'o', 3)).toBe(2);
  });

  it('accepts an out-of-range `from` — the caller passes active + 1 at the last row', () => {
    expect(matchByPrefix(LABELS, 'o', LABELS.length)).toBe(2);
  });

  it('reports no match rather than moving the selection', () => {
    expect(matchByPrefix(LABELS, 'zz', 0)).toBe(-1);
    expect(matchByPrefix(LABELS, '', 0)).toBe(-1);
    expect(matchByPrefix([], 'o', 0)).toBe(-1);
  });
});

// The searchable form's rows: the model catalog as modelOptions() shapes it — every label
// starts «Claude», which is exactly why prefix type-ahead cannot serve this picker — plus the
// «за замовчуванням» placeholder row, which is a real option with an empty value.
const MODELS = [
  { value: '', label: 'за замовчуванням' },
  { value: 'claude-opus-4-1', label: 'Claude Opus 4.1' },
  { value: 'claude-sonnet-4-5', label: 'Claude Sonnet 4.5' },
  { value: 'claude-haiku-4-5', label: 'Claude Haiku 4.5' },
  { value: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5 · claude-haiku-4-5-20251001' },
];

const labelsOf = (rows: readonly { label: string }[]): string[] => rows.map((r) => r.label);

describe('filterByQuery', () => {
  it('matches a substring anywhere in the label, not just its start', () => {
    expect(labelsOf(filterByQuery(MODELS, 'haiku'))).toEqual([
      'Claude Haiku 4.5',
      'Claude Haiku 4.5 · claude-haiku-4-5-20251001',
    ]);
    expect(labelsOf(filterByQuery(MODELS, 'SONNET'))).toEqual(['Claude Sonnet 4.5']);
  });

  it('requires every whitespace-separated token, in any order', () => {
    expect(labelsOf(filterByQuery(MODELS, '4.5 son'))).toEqual(['Claude Sonnet 4.5']);
    expect(labelsOf(filterByQuery(MODELS, 'opus sonnet'))).toEqual([]);
  });

  it('searches the value too — a pinned snapshot is found by its date', () => {
    expect(labelsOf(filterByQuery(MODELS, '20251001'))).toEqual([
      'Claude Haiku 4.5 · claude-haiku-4-5-20251001',
    ]);
  });

  it('keeps the placeholder row reachable by its own text', () => {
    expect(labelsOf(filterByQuery(MODELS, 'замов'))).toEqual(['за замовчуванням']);
  });

  it('returns the input array itself when nothing is typed — this runs per keystroke', () => {
    expect(filterByQuery(MODELS, '')).toBe(MODELS);
    expect(filterByQuery(MODELS, '   ')).toBe(MODELS);
  });

  it('reports an empty result rather than falling back to everything', () => {
    expect(filterByQuery(MODELS, 'gpt')).toEqual([]);
  });
});
