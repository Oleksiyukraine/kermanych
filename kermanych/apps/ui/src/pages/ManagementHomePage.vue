<template>
  <section class="home">
    <header class="home__head">
      <p class="home__intro">{{ t('management.home.intro') }}</p>
      <KBtn variant="ghost" @click="resetLayout">{{ t('management.home.reset') }}</KBtn>
    </header>

    <!-- The dashboard. A CSS grid `columns` wide; each tile spans the columns and rows its
         layout row names. Reorder and resize are pointer gestures the tiles only START — this
         page runs them against one window listener, mutating the one `layout` array, so the
         grid is always the model rendered and never a second copy that can drift. -->
    <div ref="gridEl" class="home__grid" :style="gridStyle">
      <HomeTile
        v-for="tile in layout"
        :id="tile.id"
        :key="tile.id"
        :title="t(`management.home.${tile.id}.title`)"
        :w="tile.w"
        :h="tile.h"
        :columns="columns"
        :resize-label="t('management.home.tileResize')"
        :move-label="t('management.home.tileMove')"
        :dragging="dragId === tile.id"
        :resizing="resizeId === tile.id"
        @drag-start="(ev) => onDragStart(tile.id, ev)"
        @resize-start="(ev) => onResizeStart(ev, tile.id)"
        @move="(dir) => onMove(tile.id, dir)"
      >
        <component :is="WIDGETS[tile.id]" :workspace-id="workspaceId" />
      </HomeTile>
    </div>
  </section>
</template>

<script setup lang="ts">
// The workspace overview: the section /management lands on. A dashboard of tiles the operator
// arranges themselves — drag a tile by its header to reorder, drag its corner to resize — over
// the four widgets that snapshot the other sections (Team Capacity, today's board, the risk
// register, recent release notes). The layout model and its arithmetic live in lib/dashboard.ts;
// this component owns the DOM the gestures run against and the Jira session two of the widgets
// read from.
//
// The Jira session is opened HERE, once, not inside the capacity and tasks widgets: both read
// the one useJira() singleton, and two openers would fight over its generation guard. It is
// opened post-mount for the same reason ManagementCapacityPage does — a sibling section's
// onUnmounted close() runs after this setup, so an immediate open would be torn down moments
// later.
import { computed, markRaw, onMounted, onUnmounted, ref, watch, type Component } from 'vue';
import { useI18n } from 'vue-i18n';
import KBtn from 'components/kit/KBtn.vue';
import { useJira } from 'stores/jira';
import HomeTile from 'components/home/HomeTile.vue';
import HomeCapacityWidget from 'components/home/HomeCapacityWidget.vue';
import HomeTasksWidget from 'components/home/HomeTasksWidget.vue';
import HomeRisksWidget from 'components/home/HomeRisksWidget.vue';
import HomeReleasesWidget from 'components/home/HomeReleasesWidget.vue';
import HomeTodoWidget from 'components/home/HomeTodoWidget.vue';
import {
  DASHBOARD_COLUMNS,
  mergeLayout,
  readLayout,
  reorder,
  resizeTile,
  writeLayout,
  type TileLayout,
  type WidgetId,
} from '../lib/dashboard';

const props = defineProps<{ workspaceId: string; workspaceName: string }>();

const { t } = useI18n();
const jira = useJira();

const WIDGETS: Record<WidgetId, Component> = {
  capacity: markRaw(HomeCapacityWidget),
  tasks: markRaw(HomeTasksWidget),
  risks: markRaw(HomeRisksWidget),
  releases: markRaw(HomeReleasesWidget),
  todo: markRaw(HomeTodoWidget),
};

// ── layout ────────────────────────────────────────────────────────────────────
const layout = ref<TileLayout[]>(readLayout(props.workspaceId));
watch(
  () => props.workspaceId,
  (id) => {
    layout.value = readLayout(id);
  },
);

function persist(): void {
  writeLayout(props.workspaceId, layout.value);
}

function resetLayout(): void {
  layout.value = mergeLayout(null);
  persist();
}

// ── grid geometry ───────────────────────────────────────────────────────────────
// A pixel row height (not `1fr`) so a tile's `h` means the same amount of space whatever the
// window height, and the resize gesture can translate a pointer delta into whole row steps.
const ROW_PX = 150;
const GAP = 16;

const gridEl = ref<HTMLElement | null>(null);
const columns = ref(DASHBOARD_COLUMNS);
let observer: ResizeObserver | undefined;

function measureColumns(): void {
  const width = gridEl.value?.clientWidth ?? 0;
  columns.value = width >= 1080 ? DASHBOARD_COLUMNS : width >= 760 ? 2 : 1;
}

const gridStyle = computed(() => ({
  gridTemplateColumns: `repeat(${columns.value}, minmax(0, 1fr))`,
  gridAutoRows: `${ROW_PX}px`,
  gap: `${GAP}px`,
}));

// ── gestures ──────────────────────────────────────────────────────────────────
// One mode at a time: a header drag reorders, a corner drag resizes. Both listen on the window
// so the gesture keeps working when the pointer leaves the tile it started on. A header press
// is only a CANDIDATE drag until the pointer travels DRAG_THRESHOLD_PX — below that it is a
// click, and the tile must not flash its lifted state (ux `drag-threshold`).
const DRAG_THRESHOLD_PX = 6;
const dragId = ref<WidgetId | null>(null);
const resizeId = ref<WidgetId | null>(null);
const resizeStart = { x: 0, y: 0, w: 0, h: 0 };
const pendingDrag = { id: null as WidgetId | null, x: 0, y: 0 };

function onDragStart(id: WidgetId, ev: PointerEvent): void {
  pendingDrag.id = id;
  pendingDrag.x = ev.clientX;
  pendingDrag.y = ev.clientY;
  beginGesture();
}

// The grip's arrow keys: one place earlier or later in the reading order, persisted at once —
// there is no pointerup to ride.
function onMove(id: WidgetId, dir: -1 | 1): void {
  const i = layout.value.findIndex((tl) => tl.id === id);
  const target = layout.value[i + dir];
  if (!target) return;
  layout.value = reorder(layout.value, id, target.id);
  persist();
}

function onResizeStart(ev: PointerEvent, id: WidgetId): void {
  const tile = layout.value.find((tl) => tl.id === id);
  if (!tile) return;
  resizeId.value = id;
  resizeStart.x = ev.clientX;
  resizeStart.y = ev.clientY;
  resizeStart.w = tile.w;
  resizeStart.h = tile.h;
  beginGesture();
}

function beginGesture(): void {
  document.body.style.userSelect = 'none';
  window.addEventListener('pointermove', onPointerMove);
  window.addEventListener('pointerup', onPointerUp);
}

function onPointerMove(ev: PointerEvent): void {
  if (pendingDrag.id) {
    if (
      Math.hypot(ev.clientX - pendingDrag.x, ev.clientY - pendingDrag.y) < DRAG_THRESHOLD_PX
    )
      return;
    dragId.value = pendingDrag.id;
    pendingDrag.id = null;
  }
  if (dragId.value) {
    const el = document.elementFromPoint(ev.clientX, ev.clientY);
    const targetId = el?.closest('[data-tile]')?.getAttribute('data-tile');
    if (targetId && targetId !== dragId.value && layout.value.some((tl) => tl.id === targetId)) {
      layout.value = reorder(layout.value, dragId.value, targetId as WidgetId);
    }
    return;
  }
  if (resizeId.value) {
    // One "cell" is a column plus its trailing gap, so a pointer delta divides into whole
    // column steps; rows step by the fixed row height plus the same gap.
    const usable = (gridEl.value?.clientWidth ?? 0) - GAP * (columns.value - 1);
    const cell = usable / columns.value + GAP;
    const dw = Math.round((ev.clientX - resizeStart.x) / cell);
    const dh = Math.round((ev.clientY - resizeStart.y) / (ROW_PX + GAP));
    layout.value = resizeTile(layout.value, resizeId.value, resizeStart.w + dw, resizeStart.h + dh);
  }
}

function onPointerUp(): void {
  // A press that never crossed the threshold moved nothing — skip the localStorage write.
  const moved = dragId.value !== null || resizeId.value !== null;
  pendingDrag.id = null;
  dragId.value = null;
  resizeId.value = null;
  document.body.style.userSelect = '';
  window.removeEventListener('pointermove', onPointerMove);
  window.removeEventListener('pointerup', onPointerUp);
  if (moved) persist();
}

// ── Jira session (capacity + tasks widgets) ────────────────────────────────────
let openToken: number | undefined;

async function enter(id: string): Promise<void> {
  if (!id) return;
  openToken = await jira.open(id);
}

onMounted(() => {
  measureColumns();
  if (gridEl.value) {
    observer = new ResizeObserver(measureColumns);
    observer.observe(gridEl.value);
  }
  void enter(props.workspaceId);
});

watch(
  () => props.workspaceId,
  (id) => void enter(id),
);

onUnmounted(() => {
  observer?.disconnect();
  jira.close(openToken);
  document.body.style.userSelect = '';
  window.removeEventListener('pointermove', onPointerMove);
  window.removeEventListener('pointerup', onPointerUp);
});
</script>

<style scoped lang="scss">
.home {
  display: flex;
  flex-direction: column;
  gap: var(--k-sp-4);
}

.home__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--k-sp-3);
}

.home__intro {
  margin: 0;
  color: var(--k-muted);
  font-size: var(--k-fs-sm);
  line-height: 1.5;
}

.home__grid {
  display: grid;
  width: 100%;
  align-items: stretch;
}
</style>
