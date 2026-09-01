// Geometry and keyboard search for the app's own dropdown surfaces — KSelect's listbox
// today, whatever pops next tomorrow.
//
// Split out of the component for the same reason lib/tip.ts keeps its own `place()`: the
// interesting cases are the awkward ones — no room below, no room on either side, an anchor
// hard against the right edge, a list longer than the viewport — and they are cheap to pin
// down as pure functions (test/menu.spec.ts) and expensive to chase by hand in a browser.
//
// Everything here works in VIEWPORT coordinates, because the menu is a `position: fixed`
// node under <body>: the app's panes set `overflow: auto`, and an in-flow popup would be
// cropped by the first scroll container above it (the board toolbar, the risks strip, any
// modal body).

/** The slice of `DOMRect` a placement needs — what the anchor occupies on screen. */
export type AnchorRect = { top: number; left: number; width: number; bottom: number };

/** The menu's UNCLAMPED box: what it measures when nothing constrains its height. */
export type MenuBox = { width: number; height: number };

export type Viewport = { width: number; height: number };

export type MenuPlacement = {
  left: number;
  top: number;
  /** Cap for the menu's own `max-height`; the list scrolls inside it. */
  maxHeight: number;
  /** Which way the menu ended up opening — drives the entrance offset in CSS. */
  side: 'top' | 'bottom';
};

/** Air between the anchor and the menu. Matches the tooltip's feel without touching it. */
export const MENU_GAP_PX = 6;
/** Minimum breathing room at the viewport border, once anything has to be clamped. */
export const MENU_EDGE_PX = 8;
/** Tallest a menu gets before it scrolls: ~9 rows, the point where a list stops being scannable. */
export const MENU_MAX_H_PX = 320;
/**
 * Floor for the scroll box. A menu squeezed into 20px is unusable, so below this it is
 * allowed to overlap its own anchor (clamped on screen further down) rather than shrink —
 * which is what a native popup does in the same corner.
 */
const MENU_MIN_H_PX = 96;

function clamp(v: number, lo: number, hi: number): number {
  // `lo` wins a crossed range: the low edge is the on-screen one in every case here
  // (a menu wider or taller than the viewport still has to start somewhere visible).
  return Math.max(lo, Math.min(v, hi));
}

/**
 * Where to pin a menu opened from `anchor`.
 *
 * Opens downward whenever the room below can hold the list, or when below is simply the
 * roomier side; flips up otherwise. The result is rounded to whole pixels — half-pixel
 * `left` on a fixed node blurs 12px mono text on a 1× display.
 */
export function placeMenu(anchor: AnchorRect, menu: MenuBox, viewport: Viewport): MenuPlacement {
  const below = viewport.height - anchor.bottom - MENU_GAP_PX - MENU_EDGE_PX;
  const above = anchor.top - MENU_GAP_PX - MENU_EDGE_PX;
  const wanted = Math.min(menu.height, MENU_MAX_H_PX);

  const side: 'top' | 'bottom' = below >= wanted || below >= above ? 'bottom' : 'top';
  const room = side === 'bottom' ? below : above;

  // `max(room, MIN)` before the MAX cap: a cramped side gets the floor, never a negative
  // or absurd cap. The clamps below keep that floor on screen.
  const maxHeight = Math.min(MENU_MAX_H_PX, Math.max(room, MENU_MIN_H_PX));
  const height = Math.min(menu.height, maxHeight);

  const rawTop = side === 'bottom' ? anchor.bottom + MENU_GAP_PX : anchor.top - MENU_GAP_PX - height;
  const top = clamp(rawTop, MENU_EDGE_PX, viewport.height - MENU_EDGE_PX - height);

  // Left-aligned with the anchor — the menu is at least as wide as its trigger, so the two
  // read as one object — then pulled back in when a wider menu would run off the right.
  const left = clamp(anchor.left, MENU_EDGE_PX, viewport.width - MENU_EDGE_PX - menu.width);

  return { left: Math.round(left), top: Math.round(top), maxHeight: Math.round(maxHeight), side };
}

/**
 * Type-ahead over option labels: the index of the first label starting with `prefix`,
 * searching from `from` and wrapping, or `-1`.
 *
 * Case-insensitive via `toLowerCase()` on both sides, which is what makes «О» find
 * «Oleksiyukraine»'s Cyrillic neighbours as well as Latin labels.
 */
export function matchByPrefix(labels: readonly string[], prefix: string, from: number): number {
  const needle = prefix.toLowerCase();
  if (!needle) return -1;
  const n = labels.length;
  const start = ((from % n) + n) % n || 0;
  for (let i = 0; i < n; i += 1) {
    const at = (start + i) % n;
    if (labels[at]!.toLowerCase().startsWith(needle)) return at;
  }
  return -1;
}

/** What a filterable row needs to expose: the text on screen and the value behind it. */
export type MenuOption = { value: string; label: string };

/**
 * The rows of `items` a search box query keeps, for KSelect's searchable mode.
 *
 * SUBSTRING, not prefix (unlike `matchByPrefix`, which serves closed-list type-ahead): the
 * model catalog is ~26 rows whose names all begin «Claude», so a prefix search over them
 * filters nothing — «haiku» has to find «Claude Haiku 4.5».
 *
 * Whitespace splits the query into tokens that must ALL match, in any order, so «4.5 son»
 * finds «Claude Sonnet 4.5» without the operator guessing the word order. The value is
 * searched alongside the label because for a model the value IS meaningful text — the id
 * omp resolves («claude-haiku-4-5-20251001»), which is how a pinned snapshot is told apart
 * from its moving alias.
 *
 * An empty query returns the input array itself, not a copy: this runs on every keystroke
 * and the common case is «nothing typed yet».
 */
export function filterByQuery<T extends MenuOption>(items: readonly T[], query: string): readonly T[] {
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!tokens.length) return items;
  return items.filter((it) => {
    const hay = `${it.label} ${it.value}`.toLowerCase();
    return tokens.every((t) => hay.includes(t));
  });
}
