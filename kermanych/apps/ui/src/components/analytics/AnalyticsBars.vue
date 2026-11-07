<template>
  <figure class="anbars">
    <div ref="scroll" class="anbars__scroll">
      <svg
        class="anbars__svg"
        :viewBox="`0 0 ${width} ${HEIGHT}`"
        :width="displayWidth"
        :height="DISPLAY_HEIGHT"
        role="img"
        :aria-label="t('analytics.dynamics.aria')"
      >
        <!-- Y grid: zero, half and the top, the scale in the metric's own words at the left. -->
        <g v-for="tick in ticks" :key="tick" class="anbars__grid">
          <line :x1="PAD_L" :x2="width - PAD_R" :y1="y(tick)" :y2="y(tick)" />
          <text :x="PAD_L - 6" :y="y(tick) + 3" text-anchor="end" class="anbars__axis mono">{{ format(tick) }}</text>
        </g>

        <g v-for="(bar, i) in bars" :key="buckets[i]">
          <rect
            v-for="seg in bar"
            :key="seg.key"
            :x="x(i)"
            :y="seg.y"
            :width="barW"
            :height="seg.h"
            :style="{ fill: seg.color }"
            class="anbars__seg"
            v-tip="seg.tip"
          />
          <text
            v-if="i % labelStep === 0"
            :x="x(i) + barW / 2"
            :y="PLOT_BOTTOM + 14"
            text-anchor="middle"
            class="anbars__axis mono"
          >
            {{ bucketLabel(buckets[i]!, timeZone, granularity) }}
          </text>
        </g>
      </svg>
    </div>

    <figcaption class="anbars__legend">
      <button
        v-for="s in series"
        :key="s.key"
        type="button"
        class="anbars__key"
        :class="{ 'anbars__key--off': s.off }"
        :aria-pressed="!s.off"
        v-tip="t(s.off ? 'analytics.legendShow' : 'analytics.legendHide', { name: s.label })"
        @click="emit('toggle', s.key)"
      >
        <i class="anbars__swatch" :style="{ background: s.color }" aria-hidden="true"></i>
        {{ s.label }}
      </button>
    </figcaption>
  </figure>
</template>

<script setup lang="ts">
// «Динаміка» (docs/specs/2026-11-07-developer-analytics.md, decisions 8.3 and 10): one stacked
// bar per day or week, one segment per series. Hand-rolled SVG on the CapacityChart.vue model —
// the app has no chart library and its palette is the token set.
//
// Presentational: the page folds the report into at most eight series plus «інші»
// (lib/analytics.ts `foldSeries`), names and colours them; this file only decides pixels. The
// `format` prop writes a value the way its metric reads (dollars, tokens, hours), so the axis
// and the tooltips speak the same unit as the tiles above.
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { axisMax, bucketLabel, zoneDate, type AnalyticsBarSeries, type AnalyticsMetricKey } from '../../lib/analytics';

const props = defineProps<{
  /** ISO instant each bucket starts at, in order. */
  buckets: string[];
  granularity: 'day' | 'week';
  /** The zone the buckets were cut in; the labels are read back in it. */
  timeZone: string;
  series: AnalyticsBarSeries[];
  metric: AnalyticsMetricKey;
  format: (value: number) => string;
}>();
const emit = defineEmits<{ toggle: [key: string] }>();
const { t } = useI18n();

const HEIGHT = 240;
// Rendered smaller than its coordinate space, as CapacityChart: the block stays one screen
// row tall and the width follows the aspect ratio, so nothing stretches.
const DISPLAY_HEIGHT = 200;
const PAD_L = 56;
const PAD_R = 12;
const PAD_T = 14;
const PAD_B = 22;
const PLOT_BOTTOM = HEIGHT - PAD_B;
const PLOT_H = PLOT_BOTTOM - PAD_T;

// The bars share the pane's width: seven days on a 1000 px pane drawn at CapacityChart's fixed
// 22 px read as a thumbnail in an empty block. The slot per bucket follows the measured width,
// the bar takes 70% of it (at most 56 px), and below the minimum slot (a year of weeks on a
// narrow pane) the figure keeps its size and scrolls.
const MIN_SLOT = 14;
const MAX_BAR = 56;
const scroll = ref<HTMLElement>();
const paneWidth = ref(0);
let observer: ResizeObserver | undefined;
onMounted(() => {
  if (!scroll.value) return;
  observer = new ResizeObserver(([entry]) => (paneWidth.value = entry?.contentRect.width ?? 0));
  observer.observe(scroll.value);
});
onBeforeUnmount(() => observer?.disconnect());

// The coordinate space is HEIGHT tall and drawn DISPLAY_HEIGHT tall, so the pane's pixels map
// onto it scaled by HEIGHT / DISPLAY_HEIGHT.
const slot = computed(() => {
  const n = Math.max(1, props.buckets.length);
  const space = (paneWidth.value * HEIGHT) / DISPLAY_HEIGHT - PAD_L - PAD_R;
  return Math.max(MIN_SLOT, space / n);
});
const barW = computed(() => Math.min(MAX_BAR, slot.value * 0.7));
const gap = computed(() => slot.value - barW.value);
// A label under every bar would overprint at 31 or 53 of them; about fifteen read.
const labelStep = computed(() => Math.max(1, Math.ceil(props.buckets.length / 16)));

const width = computed(() => PAD_L + props.buckets.length * slot.value + PAD_R);
const displayWidth = computed(() => Math.floor((width.value * DISPLAY_HEIGHT) / HEIGHT));

const visible = computed(() => props.series.filter((s) => !s.off));

const yMax = computed(() => {
  let max = 0;
  props.buckets.forEach((_, i) => {
    let stack = 0;
    for (const s of visible.value) stack += s.values[i] ?? 0;
    max = Math.max(max, stack);
  });
  return axisMax(max, props.metric);
});

const ticks = computed(() => [0, yMax.value / 2, yMax.value]);

function y(v: number): number {
  return PAD_T + PLOT_H * (1 - Math.min(v, yMax.value) / yMax.value);
}

function x(i: number): number {
  return PAD_L + i * (barW.value + gap.value) + gap.value / 2;
}

type Segment = { key: string; y: number; h: number; color: string; tip: string };

const bars = computed<Segment[][]>(() =>
  props.buckets.map((bucket, i) => {
    const out: Segment[] = [];
    let stack = 0;
    const when = zoneDate(bucket, props.timeZone);
    const period = props.granularity === 'week' ? t('analytics.weekOf', { date: when }) : when;
    for (const s of visible.value) {
      const v = s.values[i] ?? 0;
      if (v <= 0) continue;
      const top = y(stack + v);
      const bottom = y(stack);
      out.push({
        key: s.key,
        y: top,
        h: Math.max(bottom - top, 1),
        color: s.color,
        tip: t('analytics.barTip', { name: s.label, value: props.format(v), period }),
      });
      stack += v;
    }
    return out;
  }),
);
</script>

<style scoped lang="scss">
.anbars {
  display: flex;
  flex-direction: column;
  gap: var(--k-sp-2);
  margin: 0;
  min-width: 0;
}

.anbars__scroll {
  overflow-x: auto;
}

.anbars__svg {
  // Explicit size (displayWidth × DISPLAY_HEIGHT), as CapacityChart: the flex parent must not
  // stretch the SVG to the pane and letterbox it.
  display: block;
}

.anbars__grid line {
  stroke: var(--k-line);
  stroke-width: 1;
}

.anbars__axis {
  font-size: 9px;
  fill: var(--k-faint);
}

.anbars__seg {
  transition: opacity 0.16s ease;

  &:hover {
    opacity: 0.85;
  }
}

.anbars__legend {
  display: flex;
  flex-wrap: wrap;
  gap: var(--k-sp-2) var(--k-sp-3);
}

.anbars__key {
  appearance: none;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 0;
  border: 0;
  background: none;
  font-size: var(--k-fs-xs);
  color: var(--k-muted);
  cursor: pointer;

  &:hover {
    color: var(--k-text);
  }
}

.anbars__key--off {
  // Off: the swatch drains and the name strikes through — «still here, click to bring back».
  color: var(--k-faint);
  text-decoration: line-through;

  .anbars__swatch {
    opacity: 0.3;
  }
}

.anbars__swatch {
  display: inline-block;
  width: 10px;
  height: 10px;
  border-radius: 2px;
}

@media (prefers-reduced-motion: reduce) {
  .anbars__seg {
    transition: none;
  }
}
</style>
