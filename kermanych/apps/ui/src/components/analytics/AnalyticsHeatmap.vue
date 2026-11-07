<template>
  <div class="anheat">
    <div class="anheat__grid" role="img" :aria-label="t('analytics.rhythm.aria')">
      <template v-for="(row, d) in rhythm" :key="`day-${d}`">
        <span class="anheat__axis anheat__axis--day mono">{{ t(`common.calendar.weekday.${WEEKDAY_KEYS[d]}`) }}</span>
        <span
          v-for="(ms, h) in row"
          :key="`${d}:${h}`"
          class="anheat__cell"
          :class="`anheat__cell--l${heatLevel(ms, max)}`"
          v-tip="cellTip(d, h, ms)"
        ></span>
      </template>

      <span class="anheat__corner"></span>
      <span v-for="h in 24" :key="`hour-${h}`" class="anheat__axis anheat__axis--hour mono">
        {{ (h - 1) % 6 === 0 ? h - 1 : '' }}
      </span>
    </div>

    <div class="anheat__legend mono">
      <span>{{ t('analytics.rhythm.less') }}</span>
      <i v-for="l in HEAT_LEVELS + 1" :key="l" class="anheat__cell anheat__swatch" :class="`anheat__cell--l${l - 1}`" aria-hidden="true"></i>
      <span>{{ t('analytics.rhythm.more') }}</span>
    </div>
  </div>
</template>

<script setup lang="ts">
// «Ритм тижня» (docs/specs/2026-11-07-developer-analytics.md, decisions 8.4 and 10): a 7 × 24
// heat map of agent working time, weekday by local hour. A CSS grid on the RiskMatrix.vue model
// — same policy (no chart library, fills mixed from the tokens so the ladder holds on both
// canvases), same «empty cell keeps a faint wash» reading: the shape of the week is the point.
//
// `rhythm` comes straight from the report: [weekday, Monday = 0][hour 0–23] → ms. The levels are
// relative to the busiest hour of THIS period (lib/analytics.ts `heatLevel`), so a quiet week
// still shows its shape instead of seven rows of nearly-empty cells.
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { HEAT_LEVELS, duration, heatLevel, rhythmMax } from '../../lib/analytics';
import { WEEKDAY_KEYS } from '../../lib/calendar';
import { renderTime } from '../../lib/time';

const props = defineProps<{ rhythm: number[][] }>();
const { t } = useI18n();

const max = computed(() => rhythmMax(props.rhythm));

function cellTip(d: number, h: number, ms: number): string {
  const day = t(`common.calendar.weekday.${WEEKDAY_KEYS[d]}`);
  const pad = (n: number) => String(n).padStart(2, '0');
  return t('analytics.rhythm.tip', { day, from: `${pad(h)}:00`, to: `${pad((h + 1) % 24)}:00`, time: renderTime(t, duration(ms)) });
}
</script>

<style scoped lang="scss">
.anheat {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
  overflow-x: auto;
}

.anheat__grid {
  display: grid;
  // One axis gutter plus the 24 hours; cells keep a floor so the grid scrolls rather than
  // shrinking below a readable square on a narrow pane.
  grid-template-columns: 22px repeat(24, minmax(14px, 1fr));
  gap: 2px;
  min-width: 400px;
}

.anheat__axis {
  display: inline-flex;
  align-items: center;
  font-size: 9px;
  color: var(--k-faint);
}

.anheat__axis--hour {
  justify-content: flex-start;
  padding-top: 2px;
}

.anheat__corner {
  display: block;
}

.anheat__cell {
  display: block;
  aspect-ratio: 1;
  min-height: 14px;
  border-radius: var(--k-r-sm);
}

// Five steps of the accent, toward transparent so the ladder holds on both canvases. Level 0
// keeps a faint wash: an empty hour is still a cell of the week.
.anheat__cell--l0 {
  background: color-mix(in srgb, var(--k-line) 60%, transparent);
}

.anheat__cell--l1 {
  background: color-mix(in srgb, var(--k-accent) 20%, transparent);
}

.anheat__cell--l2 {
  background: color-mix(in srgb, var(--k-accent) 42%, transparent);
}

.anheat__cell--l3 {
  background: color-mix(in srgb, var(--k-accent) 66%, transparent);
}

.anheat__cell--l4 {
  background: var(--k-accent);
}

.anheat__legend {
  display: flex;
  align-items: center;
  gap: 3px;
  padding-left: 24px;
  font-size: 9px;
  letter-spacing: 0.06em;
  color: var(--k-faint);

  span:first-child {
    margin-right: 3px;
  }

  span:last-child {
    margin-left: 3px;
  }
}

.anheat__swatch {
  width: 10px;
  min-height: 10px;
}
</style>
