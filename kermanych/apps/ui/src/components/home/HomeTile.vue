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
      <!-- The grip is the keyboard alternative to the header drag: focus it and the arrow
           keys move the tile one place through the reading order. Drawn, not typed — the
           braille glyph this replaces rendered as a smudge (the KIcon rationale). -->
      <button
        class="tile__grip"
        type="button"
        v-tip="moveLabel"
        :aria-label="moveLabel"
        @keydown="onGripKey"
      >
        <svg class="tile__grip-mark" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
          <circle cx="9" cy="5" r="1" /><circle cx="9" cy="12" r="1" /><circle cx="9" cy="19" r="1" />
          <circle cx="15" cy="5" r="1" /><circle cx="15" cy="12" r="1" /><circle cx="15" cy="19" r="1" />
        </svg>
      </button>
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
      <svg class="tile__resize-mark" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
        <path d="M10 20 20 10" /><path d="M15 20 20 15" />
      </svg>
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
  moveLabel: string;
  dragging?: boolean;
  resizing?: boolean;
}>();

const emit = defineEmits<{
  dragStart: [ev: PointerEvent];
  resizeStart: [ev: PointerEvent];
  // Keyboard reorder from the grip: -1 moves the tile one place earlier in the reading
  // order, +1 one place later. The page owns the layout, so it owns the arithmetic.
  move: [dir: -1 | 1];
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

function onGripKey(ev: KeyboardEvent): void {
  if (ev.key === 'ArrowLeft' || ev.key === 'ArrowUp') {
    ev.preventDefault();
    emit('move', -1);
  } else if (ev.key === 'ArrowRight' || ev.key === 'ArrowDown') {
    ev.preventDefault();
    emit('move', 1);
  }
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
  display: flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  margin-left: calc(-1 * var(--k-sp-1));
  padding: 0;
  border: none;
  background: transparent;
  color: var(--k-faint);
  cursor: grab;
  border-radius: var(--k-r-sm);
  transition: color 0.12s;
}

.tile:hover .tile__grip,
.tile__grip:focus-visible {
  color: var(--k-muted);
}

.tile__grip:focus-visible {
  outline: 1px solid var(--k-accent);
  outline-offset: 1px;
}

.tile--dragging .tile__grip {
  cursor: grabbing;
}

.tile__grip-mark {
  display: block;
  width: var(--k-icon-sm);
  height: var(--k-icon-sm);
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

// A generous corner: the visual mark is small, the hit target is not — 24px plus the corner
// itself, so the gesture does not demand a pixel-perfect press.
.tile__resize {
  position: absolute;
  right: 0;
  bottom: 0;
  width: 24px;
  height: 24px;
  display: flex;
  align-items: flex-end;
  justify-content: flex-end;
  padding: 3px;
  border: none;
  background: transparent;
  color: var(--k-faint);
  cursor: nwse-resize;
  touch-action: none;
  transition: color 0.12s;
}

.tile__resize-mark {
  display: block;
  width: var(--k-icon-xs);
  height: var(--k-icon-xs);
}

.tile__resize:hover,
.tile--resizing .tile__resize {
  color: var(--k-accent);
}

.tile__resize:focus-visible {
  outline: 1px solid var(--k-accent);
  outline-offset: -2px;
}

@media (prefers-reduced-motion: reduce) {
  .tile,
  .tile__grip,
  .tile__resize {
    transition: none;
  }

  .tile--dragging {
    transform: none;
  }
}
</style>
