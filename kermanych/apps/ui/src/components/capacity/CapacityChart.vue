<template>
  <figure class="capchart" :aria-label="t('management.capacity.chartAria')">
    <svg class="capchart__svg" :viewBox="`0 0 ${width} ${HEIGHT}`" :style="{ minWidth: `${width}px` }" role="img">
      <defs>
        <!-- Planned time is a forecast; logged time happened. Same colour per person, the
             forecast hatched — so the eye reads the today rule as a change of fact, not of
             person. -->
        <pattern id="capchart-hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <line x1="0" y1="0" x2="0" y2="6" stroke="var(--k-bg)" stroke-width="2.5" stroke-opacity="0.55" />
        </pattern>
      </defs>

      <!-- Y grid: one hairline per tick, hours at the left. -->
      <g v-for="tick in ticks" :key="tick" class="capchart__grid">
        <line :x1="PAD_L" :x2="width - PAD_R" :y1="y(tick)" :y2="y(tick)" />
        <text :x="PAD_L - 6" :y="y(tick) + 3" text-anchor="end" class="capchart__axis mono">{{ tick }}</text>
      </g>

      <!-- Bars -->
      <g v-for="(bar, i) in bars" :key="report.periods[i]!.key">
        <rect
          v-for="seg in bar.segments"
          :key="seg.key"
          :x="x(i)"
          :y="seg.y"
          :width="BAR_W"
          :height="seg.h"
          :style="{ fill: seg.color }"
          class="capchart__seg"
          v-tip="seg.tip"
        />
        <rect
          v-for="seg in bar.segments.filter((s) => s.planned)"
          :key="`${seg.key}:hatch`"
          :x="x(i)"
          :y="seg.y"
          :width="BAR_W"
          :height="seg.h"
          fill="url(#capchart-hatch)"
          pointer-events="none"
        />
        <!-- Capacity tick: where the bar should stop. -->
        <line
          v-if="bar.capacity > 0"
          :x1="x(i) - 3"
          :x2="x(i) + BAR_W + 3"
          :y1="y(bar.capacity)"
          :y2="y(bar.capacity)"
          class="capchart__cap"
        />
        <rect
          v-if="bar.over"
          :x="x(i) - 1"
          :y="bar.top - 1"
          :width="BAR_W + 2"
          :height="PLOT_BOTTOM - bar.top + 1"
          class="capchart__over"
          pointer-events="none"
        />
        <text :x="x(i) + BAR_W / 2" :y="PLOT_BOTTOM + 14" text-anchor="middle" class="capchart__axis mono" :class="{ 'capchart__axis--past': report.periods[i]!.past }">
          {{ label(i) }}
        </text>
      </g>

      <!-- Today: the boundary between what was logged and what is planned. -->
      <g v-if="todayX !== undefined">
        <line :x1="todayX" :x2="todayX" :y1="PAD_T - 4" :y2="PLOT_BOTTOM" class="capchart__today" />
        <text :x="todayX + 4" :y="PAD_T + 6" class="capchart__axis capchart__axis--today mono">{{ t('management.capacity.today') }}</text>
      </g>
    </svg>

    <figcaption class="capchart__legend">
      <button
        v-for="s in series"
        :key="s.id"
        type="button"
        class="capchart__key"
        :disabled="s.id === OTHERS"
        @click="emit('pick', s.id)"
      >
        <i class="capchart__swatch" :style="{ background: s.color }" aria-hidden="true"></i>
        {{ s.name }}
      </button>
      <span class="capchart__key capchart__key--static">
        <i class="capchart__swatch capchart__swatch--hatch" aria-hidden="true"></i>{{ t('management.capacity.legendPlanned') }}
      </span>
      <span class="capchart__key capchart__key--static">
        <i class="capchart__swatch capchart__swatch--cap" aria-hidden="true"></i>{{ t('management.capacity.legendCapacity') }}
      </span>
    </figcaption>
  </figure>
</template>

<script setup lang="ts">
// The capacity chart: one stacked bar per period, one segment per person, a capacity tick
// per bar. Hand-rolled SVG like RiskMatrix — the app has no chart library and its palette
// is the token set, which a library would not read.
//
// Everything numeric arrives in the report; this file only decides pixels. Persons beyond
// the top MAX_SERIES by load are folded into «Others» so a twelve-person board stays
// legible, and the unassigned bucket keeps its own muted swatch because it is load with
// nobody's hours behind it.
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { hoursOf, sumCells, type CapacityReport } from '../../lib/capacity';
import { formatIsoDate } from '../../lib/calendar';
import { UNASSIGNED } from '../../lib/jira-view';

const props = defineProps<{ report: CapacityReport }>();
const emit = defineEmits<{ pick: [personId: string] }>();
const { t } = useI18n();

const HEIGHT = 260;
const PAD_L = 40;
const PAD_R = 12;
const PAD_T = 18;
const PAD_B = 24;
const BAR_W = 22;
const GAP = 10;
const PLOT_BOTTOM = HEIGHT - PAD_B;
const PLOT_H = PLOT_BOTTOM - PAD_T;
const MAX_SERIES = 8;
const OTHERS = '@others';

// Token-derived categorical palette: the three status hues first (they are already tuned
// for both canvases), then mixes toward text so neighbours never share a hue.
const PALETTE = [
  'var(--k-accent)',
  'var(--k-success)',
  'var(--k-warning)',
  'color-mix(in srgb, var(--k-accent) 45%, var(--k-text))',
  'color-mix(in srgb, var(--k-success) 45%, var(--k-text))',
  'color-mix(in srgb, var(--k-warning) 45%, var(--k-text))',
  'color-mix(in srgb, var(--k-accent) 50%, var(--k-success))',
  'color-mix(in srgb, var(--k-warning) 50%, var(--k-success))',
];
const OTHERS_COLOR = 'var(--k-muted)';
const UNASSIGNED_COLOR = 'var(--k-faint)';

type Series = { id: string; name: string; color: string; members: string[] };

const series = computed<Series[]>(() => {
  const named = props.report.persons.filter((p) => p.id !== UNASSIGNED);
  const top = named.slice(0, MAX_SERIES);
  const rest = named.slice(MAX_SERIES);
  const out: Series[] = top.map((p, i) => ({ id: p.id, name: p.name, color: PALETTE[i % PALETTE.length]!, members: [p.id] }));
  if (rest.length) out.push({ id: OTHERS, name: t('management.capacity.others'), color: OTHERS_COLOR, members: rest.map((p) => p.id) });
  if (props.report.persons.some((p) => p.id === UNASSIGNED))
    out.push({ id: UNASSIGNED, name: t('management.capacity.unassigned'), color: UNASSIGNED_COLOR, members: [UNASSIGNED] });
  return out;
});

const width = computed(() => PAD_L + props.report.periods.length * (BAR_W + GAP) + PAD_R);

// Y axis in hours, topped at a multiple of 8 above the tallest bar or tick.
const yMaxHours = computed(() => {
  let max = 0;
  props.report.totals.forEach((c) => {
    max = Math.max(max, hoursOf(c.loadSeconds), hoursOf(c.capacitySeconds));
  });
  return Math.max(8, Math.ceil(max / 8) * 8);
});

const ticks = computed(() => {
  const step = yMaxHours.value <= 40 ? 8 : Math.ceil(yMaxHours.value / 5 / 8) * 8;
  const out: number[] = [];
  for (let h = 0; h <= yMaxHours.value; h += step) out.push(h);
  return out;
});

function y(hoursValue: number): number {
  return PAD_T + PLOT_H * (1 - Math.min(hoursValue, yMaxHours.value) / yMaxHours.value);
}

function x(i: number): number {
  return PAD_L + i * (BAR_W + GAP) + GAP / 2;
}

function periodLabel(i: number): string {
  const p = props.report.periods[i]!;
  return props.report.granularity === 'day' ? formatIsoDate(p.key) : `${formatIsoDate(p.from)} – ${formatIsoDate(p.to)}`;
}

function label(i: number): string {
  const p = props.report.periods[i]!;
  const d = formatIsoDate(p.key); // DD.MM.YYYY
  return props.report.granularity === 'day' ? d.slice(0, 2) : d.slice(0, 5);
}

type Segment = { key: string; y: number; h: number; color: string; planned: boolean; tip: string };
type Bar = { segments: Segment[]; capacity: number; top: number; over: boolean };

const bars = computed<Bar[]>(() =>
  props.report.periods.map((p, i) => {
    const segments: Segment[] = [];
    let stack = 0;
    const name = (s: Series) => s.name;
    const period = periodLabel(i);
    for (const s of series.value) {
      const cell = sumCells(s.members.map((id) => props.report.cells[id]![i]!));
      const cap = hoursOf(cell.capacitySeconds);
      for (const planned of [false, true]) {
        const secs = planned ? cell.plannedSeconds : cell.loggedSeconds;
        if (secs <= 0) continue;
        const h = hoursOf(secs);
        const yTop = y(stack + h);
        const yBottom = y(stack);
        segments.push({
          key: `${s.id}:${planned ? 'plan' : 'log'}`,
          y: yTop,
          h: Math.max(yBottom - yTop, 1),
          color: s.color,
          planned,
          tip: t('management.capacity.tip', { name: name(s), load: h, cap, period }),
        });
        stack += h;
      }
    }
    const total = props.report.totals[i]!;
    const capacity = hoursOf(total.capacitySeconds);
    return { segments, capacity, top: y(stack), over: capacity > 0 && hoursOf(total.loadSeconds) > capacity };
  }),
);

// The rule sits at the start of the first period that is not wholly past — only when
// there is something past to separate it from.
const todayX = computed<number | undefined>(() => {
  const i = props.report.periods.findIndex((p) => !p.past);
  if (i <= 0) return undefined;
  return x(i) - GAP / 2;
});
</script>

<style scoped lang="scss">
.capchart {
  display: flex;
  flex-direction: column;
  gap: var(--k-sp-2);
  margin: 0;
  overflow-x: auto;
}

.capchart__svg {
  display: block;
  width: 100%;
  height: auto;
}

.capchart__grid line {
  stroke: var(--k-line);
  stroke-width: 1;
}

.capchart__axis {
  font-size: 9px;
  fill: var(--k-faint);
}

.capchart__axis--past {
  fill: var(--k-muted);
}

.capchart__axis--today {
  fill: var(--k-accent);
}

.capchart__seg {
  transition: opacity 0.16s ease;

  &:hover {
    opacity: 0.85;
  }
}

.capchart__cap {
  stroke: var(--k-text);
  stroke-width: 2;
}

.capchart__over {
  fill: none;
  stroke: var(--k-danger);
  stroke-width: 1.5;
}

.capchart__today {
  stroke: var(--k-accent);
  stroke-width: 1;
  stroke-dasharray: 3 3;
}

.capchart__legend {
  display: flex;
  flex-wrap: wrap;
  gap: var(--k-sp-2) var(--k-sp-3);
}

.capchart__key {
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

  &:disabled,
  &--static {
    cursor: default;
  }

  &:not(:disabled):not(&--static):hover {
    color: var(--k-text);
  }
}

.capchart__swatch {
  display: inline-block;
  width: 10px;
  height: 10px;
  border-radius: 2px;
}

.capchart__swatch--hatch {
  background: repeating-linear-gradient(45deg, var(--k-muted) 0 2px, transparent 2px 4px);
}

.capchart__swatch--cap {
  height: 2px;
  background: var(--k-text);
}

@media (prefers-reduced-motion: reduce) {
  .capchart__seg {
    transition: none;
  }
}
</style>
