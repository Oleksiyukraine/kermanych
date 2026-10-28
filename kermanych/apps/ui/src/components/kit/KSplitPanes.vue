<template>
  <div
    ref="root"
    class="k-split"
    :class="[`k-split--${show}`, { 'k-split--resizing': resizing }]"
    :style="show === 'both' ? { '--k-split-start': `${ratio * 100}%` } : undefined"
  >
    <div v-if="show !== 'end'" class="k-split__pane"><slot name="start" /></div>
    <div
      v-if="show === 'both'"
      class="k-split__handle"
      role="separator"
      aria-orientation="vertical"
      :aria-label="t('kit.split.resize')"
      :aria-valuenow="Math.round(ratio * 100)"
      :aria-valuemin="Math.round(MIN * 100)"
      :aria-valuemax="Math.round((1 - MIN) * 100)"
      tabindex="0"
      v-tip="t('kit.split.tip')"
      @pointerdown="startResize"
      @keydown="onKeydown"
      @dblclick="reset"
    ></div>
    <div v-if="show !== 'start'" class="k-split__pane"><slot name="end" /></div>
  </div>
</template>

<script setup lang="ts">
// Two panes side by side with a draggable divider — the source and the preview of a file
// viewer. `show` picks one pane alone or both; the slots stay mounted only while shown. The
// ratio, its persistence under `storageKey` and the drag live in useSplitRatio.
import { ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { useSplitRatio } from '../../composables/useSplitRatio';

const props = withDefaults(
  defineProps<{
    show?: 'start' | 'end' | 'both';
    storageKey?: string;
  }>(),
  { show: 'both' },
);

const { t } = useI18n();

const root = ref<HTMLElement | null>(null);
const { ratio, resizing, min: MIN, startResize: dragFrom, onKeydown, reset } = useSplitRatio(props.storageKey);

function startResize(ev: PointerEvent): void {
  const el = root.value;
  if (!el) return;
  const rect = el.getBoundingClientRect();
  dragFrom(ev, (x) => (x - rect.left) / rect.width);
}
</script>

<style scoped lang="scss">
.k-split {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  grid-template-rows: minmax(0, 1fr);
  min-width: 0;
  min-height: 0;
}
.k-split--both {
  grid-template-columns: minmax(0, calc(var(--k-split-start) - 3.5px)) 7px minmax(0, 1fr);
}
// While dragging, nothing under the pointer may react or get selected — the iframes least.
.k-split--resizing {
  cursor: col-resize;
  user-select: none;

  .k-split__pane { pointer-events: none; }
}

.k-split__pane {
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;

  > :slotted(*) {
    flex: 1;
    min-width: 0;
    min-height: 0;
  }
}

// The same handle as the Агенти board's resizer: a 7px grab area around a 1px rule that
// lights the accent on hover, focus and drag.
.k-split__handle {
  position: relative;
  cursor: col-resize;
  touch-action: none;
  user-select: none;

  &::before {
    content: '';
    position: absolute;
    top: 0;
    bottom: 0;
    left: 50%;
    width: 1px;
    transform: translateX(-50%);
    background: var(--k-line-strong);
    transition: background 0.12s;
  }
  &:hover::before,
  &:focus-visible::before { background: var(--k-accent); }
  &:focus-visible { outline: none; }
}
.k-split--resizing .k-split__handle::before { background: var(--k-accent); }
</style>
