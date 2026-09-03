<template>
  <div class="rmx">
    <div class="rmx__grid" role="group" :aria-label="ariaLabel ?? t('risk.matrix.aria')">
      <template v-for="p in ROWS" :key="`row-${p}`">
        <span class="rmx__axis rmx__axis--p mono">{{ p }}</span>
        <button
          v-for="i in SCALE"
          :key="`${p}:${i}`"
          type="button"
          class="rmx__cell"
          :class="[
            `rmx__cell--${bandOf(p * i)}`,
            {
              'rmx__cell--picked': probability === p && impact === i,
              'rmx__cell--filtered': selectedCell === `${p}:${i}`,
              'rmx__cell--empty': counts !== undefined && !counts[`${p}:${i}`],
            },
          ]"
          :disabled="!interactive"
          :aria-pressed="probability === p && impact === i"
          v-tip="t('risk.matrix.cellTip', { p, i, exposure: p * i })"
          @click="emit('pick', p, i)"
        >
          <span class="rmx__value mono">{{ cellText(p, i) }}</span>
        </button>
      </template>

      <span class="rmx__corner"></span>
      <span v-for="i in SCALE" :key="`col-${i}`" class="rmx__axis rmx__axis--i mono">{{ i }}</span>
    </div>

    <div class="rmx__legend mono">
      <span class="rmx__legend-p">{{ t('risk.matrix.legendP') }}</span>
      <span class="rmx__legend-i">{{ t('risk.matrix.legendI') }}</span>
    </div>
  </div>
</template>

<script setup lang="ts">
// The 5×5 grid, in both of the jobs a register needs one for: the HEAT MAP over the whole
// register (pass `counts`) and the SCORE PICKER inside the editor (pass `probability` /
// `impact`). One component, because the two must agree cell for cell — a picker whose amber
// band sat somewhere else than the heat map's would quietly teach two different scales.
//
// Probability climbs upward and impact runs rightward, the orientation every risk-management
// text prints, so a register imported into a steering deck does not have to be re-read.
import { useI18n } from 'vue-i18n';
import { bandOf, SCALE } from '../../lib/risk';

const { t } = useI18n();

const props = withDefaults(
  defineProps<{
    // Heat-map mode: how many live risks sit in each `p:i` cell. Absent = picker mode.
    counts?: Record<string, number> | undefined;
    probability?: number | undefined;
    impact?: number | undefined;
    // The cell the table is currently filtered to, outlined rather than filled: it is a view
    // state, not a score.
    selectedCell?: string | undefined;
    interactive?: boolean;
    ariaLabel?: string;
  }>(),
  { interactive: false },
);

const emit = defineEmits<{ pick: [probability: number, impact: number] }>();

// Top row is the highest probability, so the grid reads like the printed matrix.
const ROWS = [...SCALE].reverse();

function cellText(p: number, i: number): string {
  if (props.counts === undefined) return String(p * i);
  const n = props.counts[`${p}:${i}`];
  return n ? String(n) : '';
}
</script>

<style scoped lang="scss">
.rmx {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.rmx__grid {
  display: grid;
  // One axis gutter plus the five score columns.
  grid-template-columns: 16px repeat(5, minmax(0, 1fr));
  gap: 3px;
}

.rmx__axis {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 9px;
  color: var(--k-faint);
}

.rmx__axis--i {
  padding-top: 2px;
}

.rmx__corner {
  display: block;
}

.rmx__cell {
  appearance: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  aspect-ratio: 1;
  min-height: 22px;
  padding: 0;
  border: var(--k-rule-thin) solid transparent;
  border-radius: var(--k-r-sm);
  font-family: var(--k-font-mono);
  color: var(--k-text);
  transition:
    transform 0.16s ease,
    border-color 0.16s ease;

  &:disabled {
    cursor: default;
  }

  &:not(:disabled) {
    cursor: pointer;
  }

  &:not(:disabled):hover {
    transform: translateY(-1px);
    border-color: var(--k-line-strong);
  }

  &:focus-visible {
    outline: var(--k-rule-thin) solid var(--k-accent);
    outline-offset: 1px;
  }
}

// The four bands of lib/risk.ts, walked green → amber → brand → red. Every fill is a
// color-mix toward transparent so the ladder holds on both canvases.
.rmx__cell--low {
  background: color-mix(in srgb, var(--k-success) 18%, transparent);
}

.rmx__cell--medium {
  background: color-mix(in srgb, var(--k-warning) 22%, transparent);
}

.rmx__cell--high {
  background: color-mix(in srgb, var(--k-accent) 24%, transparent);
}

.rmx__cell--extreme {
  background: color-mix(in srgb, var(--k-danger) 38%, transparent);
}

// A heat-map cell with nothing in it keeps its band as a faint wash: the shape of the grid
// is the information, and an empty extreme cell is worth seeing as empty.
.rmx__cell--empty {
  opacity: 0.32;
}

// The picked score: a solid frame, because the fill is already carrying the band.
.rmx__cell--picked {
  border-color: var(--k-text);
  box-shadow: inset 0 0 0 1px var(--k-text);
}

// The cell the table is filtered to — the accent frame the rest of the app uses for «this is
// the selection», deliberately different from the picked-score frame above.
.rmx__cell--filtered {
  border-color: var(--k-accent);
  box-shadow: inset 0 0 0 1px var(--k-accent);
}

.rmx__value {
  font-size: 10px;
  line-height: 1;
}

.rmx__legend {
  display: flex;
  justify-content: space-between;
  padding-left: 19px;
  font-size: 9px;
  letter-spacing: 0.06em;
  color: var(--k-faint);
}

@media (prefers-reduced-motion: reduce) {
  .rmx__cell:not(:disabled):hover {
    transform: none;
  }
}
</style>
