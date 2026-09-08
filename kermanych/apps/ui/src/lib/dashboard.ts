// apps/ui/src/lib/dashboard.ts
// The management home dashboard's layout model, pure. The screen
// (apps/ui/src/pages/ManagementHomePage.vue) renders and mutates a layout through these
// functions and persists the result per workspace; the reorder / resize / merge arithmetic
// lives here — the tasks-view.ts rule — so a .vue file holds no decision worth a test.
//
// A layout is an ORDERED list of tiles, one per widget. Order is the reading order across the
// grid (auto-flow), and each tile carries the columns and rows it spans. localStorage, not the
// cloud: how one operator arranges their own overview is their view of it, the same scope as
// Team Capacity's remembered range (lib/capacity-prefs.ts).

// Every widget the dashboard can show. Adding one here plus a row in DEFAULT_LAYOUT is enough
// for mergeLayout to heal every saved layout into carrying it.
export type WidgetId = 'capacity' | 'tasks' | 'risks' | 'releases';

export type TileLayout = {
  id: WidgetId;
  // Column span and row span on the DASHBOARD_COLUMNS-wide grid.
  w: number;
  h: number;
};

// The widest the grid ever is; the screen renders fewer columns on a narrow pane and clamps
// each span to what fits, but the model is always stated at full width so a layout does not
// change meaning when the window does.
export const DASHBOARD_COLUMNS = 4;
export const TILE_MIN_W = 1;
export const TILE_MIN_H = 1;
export const TILE_MAX_H = 4;

// The order and starting size a workspace opens on. Every WidgetId appears exactly once —
// mergeLayout leans on that to append a widget a saved layout predates and to drop one the app
// has since removed.
export const DEFAULT_LAYOUT: readonly TileLayout[] = [
  { id: 'capacity', w: 2, h: 2 },
  { id: 'tasks', w: 2, h: 2 },
  { id: 'risks', w: 2, h: 2 },
  { id: 'releases', w: 2, h: 2 },
];

const WIDGET_IDS: readonly WidgetId[] = DEFAULT_LAYOUT.map((t) => t.id);

// Type guard, not a rename: it narrows a persisted string to WidgetId so mergeLayout can drop
// an unknown tile without an unchecked cast.
function isWidgetId(value: string): value is WidgetId {
  return (WIDGET_IDS as readonly string[]).includes(value);
}

export function clampWidth(w: number): number {
  return Math.min(DASHBOARD_COLUMNS, Math.max(TILE_MIN_W, Math.round(w)));
}

export function clampHeight(h: number): number {
  return Math.min(TILE_MAX_H, Math.max(TILE_MIN_H, Math.round(h)));
}

// Move `dragId` to sit where `targetId` is, shifting the rest. A no-op copy when either id is
// missing or the two are the same — the screen calls this on every pointermove, and the common
// move hovers the tile already under the cursor.
export function reorder(
  list: readonly TileLayout[],
  dragId: WidgetId,
  targetId: WidgetId,
): TileLayout[] {
  if (dragId === targetId) return [...list];
  const from = list.findIndex((t) => t.id === dragId);
  const to = list.findIndex((t) => t.id === targetId);
  if (from < 0 || to < 0) return [...list];
  const next = [...list];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved!);
  return next;
}

// A tile resized, clamped to the grid's limits. Returns a copy so a caller can assign it
// straight back to a ref without mutating the previous value.
export function resizeTile(
  list: readonly TileLayout[],
  id: WidgetId,
  w: number,
  h: number,
): TileLayout[] {
  return list.map((t) => (t.id === id ? { ...t, w: clampWidth(w), h: clampHeight(h) } : t));
}

// A saved blob, healed against the current widget set: a known id keeps its saved order and
// (clamped) size, an id the save never heard of is appended in default order, and an id the
// save still carries but the app has dropped is discarded. So adding or removing a widget never
// strands a workspace on a broken layout, and a hand-edited blob cannot inject an unknown tile.
export function mergeLayout(saved: unknown): TileLayout[] {
  const rows: readonly unknown[] = Array.isArray(saved) ? saved : [];
  const seen = new Set<WidgetId>();
  const kept: TileLayout[] = [];
  for (const r of rows) {
    if (!r || typeof r !== 'object' || !('id' in r)) continue;
    const id = r.id;
    if (typeof id !== 'string' || !isWidgetId(id) || seen.has(id)) continue;
    seen.add(id);
    const def = DEFAULT_LAYOUT.find((d) => d.id === id)!;
    const w = 'w' in r && typeof r.w === 'number' ? clampWidth(r.w) : def.w;
    const h = 'h' in r && typeof r.h === 'number' ? clampHeight(r.h) : def.h;
    kept.push({ id, w, h });
  }
  for (const def of DEFAULT_LAYOUT) if (!seen.has(def.id)) kept.push({ ...def });
  return kept;
}

export function dashboardStorageKey(workspaceId: string): string {
  return `mgmt-home:${workspaceId}`;
}

export function readLayout(workspaceId: string): TileLayout[] {
  try {
    const raw = localStorage.getItem(dashboardStorageKey(workspaceId));
    return mergeLayout(raw ? (JSON.parse(raw) as unknown) : null);
  } catch {
    return mergeLayout(null);
  }
}

export function writeLayout(workspaceId: string, layout: readonly TileLayout[]): void {
  try {
    localStorage.setItem(dashboardStorageKey(workspaceId), JSON.stringify(layout));
  } catch {
    /* private mode: the layout just does not stick */
  }
}
