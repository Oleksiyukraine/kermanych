<template>
  <!-- One dashboard tile: the grid cell it occupies AND its chrome. It is the direct grid
       child (so its span lands on the grid), carries `data-tile` for the page's pointer hit
       test, and owns only the frame — a widget's content is the default slot, its controls the
       `actions` slot. The header is the drag handle and the corner is the resize handle; both
       just report the pointerdown, the page runs the gesture (one window listener, not one per
       tile), because reordering and resizing are decisions about the whole layout. -->
  <article
    class="tile"
    :class="{ 'tile--dragging': dragging, 'tile--resizing': resizing }"
    :style="style"
    :data-tile="id"
  >
    <header class="tile__head" @pointerdown="onHeadDown">
      <span class="tile__grip" aria-hidden="true">⠿</span>
      <h3 class="tile__title">{{ title }}</h3>
      <div class="tile__actions" @pointerdown.stop>
        <slot name="actions" />
      </div>
    </header>
    <div class="tile__body">
      <slot />
    </div>
    <button
      class="tile__resize"
      type="button"
      :aria-label="resizeLabel"
      @pointerdown="onResizeDown"
    >
      <span aria-hidden="true">⌟</span>
    </button>
  </article>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import type { WidgetId } from '../../lib/dashboard';

const props = defineProps<{
  id: WidgetId;
  title: string;
  w: number;
  h: number;
  // The grid's current column count — the pane is narrower than four columns on small windows,
  // so a four-wide tile must not span past the edge and spill into an implicit column.
  columns: number;
  resizeLabel: string;
  dragging?: boolean;
  resizing?: boolean;
}>();

const emit = defineEmits<{
  dragStart: [ev: PointerEvent];
  resizeStart: [ev: PointerEvent];
}>();

const style = computed(() => ({
  gridColumn: `span ${Math.min(props.w, props.columns)}`,
  gridRow: `span ${props.h}`,
}));

function onHeadDown(ev: PointerEvent): void {
  // Left button only, and never when the press started on a control in the actions slot — the
  // period selector lives there and must open, not start a drag. `.stop` on the actions wrapper
  // already blocks most of it; this guards the gap around the controls.
  if (ev.button !== 0) return;
  ev.preventDefault();
  emit('dragStart', ev);
}

function onResizeDown(ev: PointerEvent): void {
  if (ev.button !== 0) return;
  ev.preventDefault();
  ev.stopPropagation();
  emit('resizeStart', ev);
}
</script>

<style scoped lang="scss">
.tile {
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  position: relative;
  background: var(--k-surface);
  border: 1px solid var(--k-line);
  border-radius: var(--k-r);
  overflow: hidden;
  transition: border-color 0.12s, box-shadow 0.12s, transform 0.12s, opacity 0.12s;
}

.tile:hover {
  border-color: var(--k-line-strong);
}

// The tile being dragged: lifted and dimmed so the live reorder underneath it reads as the
// preview it is.
.tile--dragging {
  opacity: 0.6;
  border-color: var(--k-accent);
  box-shadow: var(--k-shadow-pop);
  transform: scale(0.99);
}

.tile--resizing {
  border-color: var(--k-accent);
  box-shadow: var(--k-shadow-pop);
}

.tile__head {
  display: flex;
  align-items: center;
  gap: var(--k-sp-2);
  padding: var(--k-sp-2) var(--k-sp-3);
  border-bottom: 1px solid var(--k-line);
  cursor: grab;
  user-select: none;
  flex: none;
}

.tile--dragging .tile__head {
  cursor: grabbing;
}

.tile__grip {
  color: var(--k-faint);
  font-size: 13px;
  line-height: 1;
  letter-spacing: -1px;
}

.tile__title {
  flex: 1;
  min-width: 0;
  margin: 0;
  font-family: var(--k-font-ui);
  font-size: var(--k-fs-sm);
  font-weight: var(--k-fw-semibold);
  color: var(--k-text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.tile__actions {
  display: flex;
  align-items: center;
  gap: var(--k-sp-2);
  cursor: default;
}

.tile__body {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: var(--k-sp-3);
}

.tile__resize {
  position: absolute;
  right: 0;
  bottom: 0;
  width: 20px;
  height: 20px;
  display: flex;
  align-items: flex-end;
  justify-content: flex-end;
  padding: 2px;
  border: none;
  background: transparent;
  color: var(--k-faint);
  cursor: nwse-resize;
  font-size: 12px;
  line-height: 1;
  touch-action: none;
}

.tile__resize:hover,
.tile--resizing .tile__resize {
  color: var(--k-accent);
}

.tile__resize:focus-visible {
  outline: 1px solid var(--k-accent);
  outline-offset: -2px;
}
</style>
