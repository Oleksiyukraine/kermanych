<template>
  <div
    ref="root"
    class="k-diff-rows mono"
    :class="{ 'k-diff-rows--resizing': resizing }"
    :style="{
      gridTemplateColumns: `auto minmax(0, ${ratio}fr) auto minmax(0, ${1 - ratio}fr)`,
      '--k-sx-old': `${sxOld}px`,
      '--k-sx-new': `${sxNew}px`,
    }"
    @wheel="onWheel"
  >
    <!-- The two sections. They are rows of ONE grid, not two panes: shared rows are what keep
         a removed line opposite the added line that replaced it, with one vertical scrollbar
         for both. Each side scrolls sideways on its own (see the script). -->
    <div class="k-diff-rows__col-head">{{ t('kit.diff.original') }}</div>
    <div class="k-diff-rows__col-head k-diff-rows__col-head--new">{{ t('kit.diff.changes') }}</div>
    <template v-for="(hunk, hi) in diff.hunks" :key="hi">
      <div class="k-diff-rows__hunk">{{ hunk.header }}</div>
      <template v-for="(row, ri) in hunk.rows" :key="`${hi}:${ri}`">
        <div class="k-diff-rows__no" data-side="old">{{ row.old?.no ?? '' }}</div>
        <div
          class="k-diff-rows__line"
          :class="{
            'k-diff-rows__line--del': row.kind === 'del' || row.kind === 'mod',
            'k-diff-rows__line--void': !row.old,
          }"
          data-side="old"
        ><span class="k-diff-rows__text k-diff-rows__text--old">{{ row.old?.text ?? '' }}</span></div>
        <div class="k-diff-rows__no k-diff-rows__no--new" data-side="new">{{ row.new?.no ?? '' }}</div>
        <div
          class="k-diff-rows__line"
          :class="{
            'k-diff-rows__line--add': row.kind === 'add' || row.kind === 'mod',
            'k-diff-rows__line--void': !row.new,
          }"
          data-side="new"
        ><span class="k-diff-rows__text k-diff-rows__text--new">{{ row.new?.text ?? '' }}</span></div>
      </template>
    </template>

    <!-- One sideways scrollbar per side, pinned to the bottom of the caller's scroller. -->
    <div class="k-diff-rows__bar-gap" :class="{ 'k-diff-rows__bar-gap--idle': !barsShown }"></div>
    <div
      ref="barOld"
      class="k-diff-rows__bar"
      :class="{ 'k-diff-rows__bar--idle': !barsShown }"
      data-side="old"
      @scroll="sxOld = barOld?.scrollLeft ?? 0"
    ><div :style="{ width: widthOld }"></div></div>
    <div class="k-diff-rows__bar-gap" :class="{ 'k-diff-rows__bar-gap--idle': !barsShown }"></div>
    <div
      ref="barNew"
      class="k-diff-rows__bar"
      :class="{ 'k-diff-rows__bar--idle': !barsShown }"
      data-side="new"
      @scroll="sxNew = barNew?.scrollLeft ?? 0"
    ><div :style="{ width: widthNew }"></div></div>

    <div
      class="k-diff-rows__handle"
      role="separator"
      aria-orientation="vertical"
      :aria-label="t('kit.split.resize')"
      :aria-valuenow="Math.round(ratio * 100)"
      tabindex="0"
      v-tip="t('kit.split.tip')"
      @pointerdown="startResize"
      @keydown="onKeydown"
      @dblclick="reset"
    ></div>
  </div>
</template>

<script setup lang="ts">
// The paired rows of one file's diff: original on the left, the new version on the right.
// The api hands them over already paired (apps/api/src/worktree/split-diff.ts), so this only
// paints them. Shared by KDiffView and KFileView's ± mode; the caller's body scrolls it
// vertically, which is what keeps the column heads sticky.
//
// The divider between the sides drags (useSplitRatio, remembered per device). That needs
// each side to own its width, so a long line no longer widens its column — it scrolls
// within it: the side's text is shifted by its own offset, set from a scrollbar at the
// bottom of that side or from a horizontal wheel/trackpad gesture over it. Before this, both
// columns were at least as wide as their longest line, and a narrow pane pushed the right
// side off screen.
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { useSplitRatio } from '../../composables/useSplitRatio';
import type { FileDiff } from '../../lib/api';

const props = defineProps<{ diff: FileDiff }>();

const { t } = useI18n();

const root = ref<HTMLElement | null>(null);
const barOld = ref<HTMLElement | null>(null);
const barNew = ref<HTMLElement | null>(null);
const sxOld = ref(0);
const sxNew = ref(0);
const barsShown = ref(false);

const { ratio, resizing, startResize: dragFrom, onKeydown, reset } = useSplitRatio('kermanych.diffView.columns');

// The widest line per side, in monospace columns (tab-size 2), plus the cell's side padding:
// what each scrollbar's track has to span.
function widest(texts: (string | undefined)[]): string {
  let max = 0;
  for (const s of texts) {
    if (!s) continue;
    let n = s.length;
    for (const c of s) if (c === '\t') n++;
    if (n > max) max = n;
  }
  return `calc(${max}ch + 2 * var(--k-sp-2))`;
}
const widthOld = computed(() => widest(props.diff.hunks.flatMap((h) => h.rows.map((r) => r.old?.text))));
const widthNew = computed(() => widest(props.diff.hunks.flatMap((h) => h.rows.map((r) => r.new?.text))));

// The fr columns share what the two line-number columns leave; the pointer maps onto that.
function startResize(ev: PointerEvent): void {
  const el = root.value;
  if (!el) return;
  const rect = el.getBoundingClientRect();
  const noOld = el.querySelector<HTMLElement>('.k-diff-rows__no')?.offsetWidth ?? 0;
  const noNew = el.querySelector<HTMLElement>('.k-diff-rows__no--new')?.offsetWidth ?? 0;
  const shared = Math.max(1, rect.width - noOld - noNew);
  dragFrom(ev, (x) => (x - rect.left - noOld) / shared);
}

function onWheel(e: WheelEvent): void {
  const dx = e.deltaX || (e.shiftKey ? e.deltaY : 0);
  if (!dx || Math.abs(dx) < Math.abs(e.shiftKey ? 0 : e.deltaY)) return;
  const side = (e.target as HTMLElement | null)?.closest<HTMLElement>('[data-side]')?.dataset.side;
  const bar = side === 'old' ? barOld.value : side === 'new' ? barNew.value : null;
  if (!bar) return;
  const before = bar.scrollLeft;
  bar.scrollLeft += dx;
  if (bar.scrollLeft !== before) e.preventDefault();
}

// The bars only take room while a side actually overflows. Re-read on every size change (a
// drag, the pane, full screen): a wider column clamps its bar's offset, and the text must
// follow the clamp.
function measure(): void {
  const o = barOld.value;
  const n = barNew.value;
  if (!o || !n) return;
  barsShown.value = o.scrollWidth > o.clientWidth + 1 || n.scrollWidth > n.clientWidth + 1;
  sxOld.value = o.scrollLeft;
  sxNew.value = n.scrollLeft;
}
let observer: ResizeObserver | null = null;
onMounted(() => {
  observer = new ResizeObserver(measure);
  if (root.value) observer.observe(root.value);
  measure();
});
onBeforeUnmount(() => observer?.disconnect());
watch([ratio, () => props.diff], () => requestAnimationFrame(measure));
</script>

<style scoped lang="scss">
.k-diff-rows {
  position: relative;
  display: grid;
  font-size: var(--k-fs-xs);
  tab-size: 2;
}
.k-diff-rows--resizing {
  cursor: col-resize;
  user-select: none;
}

.k-diff-rows__col-head {
  position: sticky;
  top: 0;
  z-index: 1;
  grid-column: span 2;
  min-width: 0;
  padding: 3px var(--k-sp-2);
  background: var(--k-surface2);
  box-shadow: inset 0 -1px 0 0 var(--k-line);
  color: var(--k-muted);
  font-size: var(--k-fs-xs);
}
.k-diff-rows__col-head--new { box-shadow: inset 1px 0 0 0 var(--k-line-strong), inset 0 -1px 0 0 var(--k-line); }

.k-diff-rows__hunk {
  grid-column: 1 / -1;
  min-width: 0;
  padding: 2px var(--k-sp-2);
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  background: var(--k-surface);
  color: var(--k-faint);
  border-top: 1px solid var(--k-line);
  border-bottom: 1px solid var(--k-line);
}

// A fixed row height is load-bearing: an empty line on both sides would otherwise collapse
// its row and slide the two columns out of step.
.k-diff-rows__no,
.k-diff-rows__line {
  line-height: 18px;
  min-height: 18px;
}
.k-diff-rows__no {
  padding: 0 var(--k-sp-2);
  text-align: right;
  color: var(--k-faint);
  user-select: none; // keeps line numbers out of a copied selection
}
.k-diff-rows__no--new { box-shadow: inset 1px 0 0 0 var(--k-line-strong); }

.k-diff-rows__line {
  min-width: 0;
  padding: 0 var(--k-sp-2);
  overflow: hidden;
  color: var(--k-text);
  white-space: pre;
}
.k-diff-rows__text {
  display: inline-block;
}
.k-diff-rows__text--old { transform: translateX(calc(-1 * var(--k-sx-old, 0px))); }
.k-diff-rows__text--new { transform: translateX(calc(-1 * var(--k-sx-new, 0px))); }
.k-diff-rows__line--del { background: color-mix(in srgb, var(--k-diff-del) 18%, transparent); }
.k-diff-rows__line--add { background: color-mix(in srgb, var(--k-diff-add) 18%, transparent); }
// No counterpart on this side. A faint hatch, not a tint: a flat panel reads as an empty
// line of code, while stripes read as "there is nothing here" at a glance.
.k-diff-rows__line--void {
  background: repeating-linear-gradient(135deg, transparent 0 6px, var(--k-line) 6px 7px);
}

.k-diff-rows__bar,
.k-diff-rows__bar-gap {
  position: sticky;
  bottom: 0;
  z-index: 1;
  height: 12px;
  background: var(--k-bg);
  box-shadow: inset 0 1px 0 0 var(--k-line);
}
.k-diff-rows__bar {
  min-width: 0;
  overflow-x: auto;
  overflow-y: hidden;

  > div { height: 1px; }
}
// Nothing overflows: the bar row keeps its cells (and its scroll offsets) but takes no room.
.k-diff-rows__bar--idle,
.k-diff-rows__bar-gap--idle {
  height: 0;
  box-shadow: none;
}

// The divider: an out-of-flow strip over the left edge of the right side's line-number
// column, the full height of the diff. The same look as KSplitPanes — a 7px grab area around
// a 1px rule that lights the accent on hover, focus and drag.
.k-diff-rows__handle {
  position: absolute;
  grid-column: 3;
  top: 0;
  bottom: 0;
  left: -3px;
  width: 7px;
  z-index: 2;
  cursor: col-resize;
  touch-action: none;
  user-select: none;

  &::before {
    content: '';
    position: absolute;
    top: 0;
    bottom: 0;
    left: 3px;
    width: 1px;
    background: transparent;
    transition: background 0.12s;
  }
  &:hover::before,
  &:focus-visible::before { background: var(--k-accent); }
  &:focus-visible { outline: none; }
}
.k-diff-rows--resizing .k-diff-rows__handle::before { background: var(--k-accent); }
</style>
