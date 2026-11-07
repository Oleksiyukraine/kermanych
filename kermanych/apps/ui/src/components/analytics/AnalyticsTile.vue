<template>
  <article class="antile">
    <span class="antile__label mono">{{ label }}</span>
    <strong class="antile__value">{{ value }}</strong>
    <span class="antile__foot">
      <span
        v-if="delta"
        class="antile__delta mono"
        :class="`antile__delta--${delta.direction}`"
        v-tip="t('analytics.deltaTip', { previous: previousText })"
      >{{ delta.direction === 'up' ? '▲' : delta.direction === 'down' ? '▼' : '=' }} {{ delta.percent }}%</span>
      <span v-if="note" class="antile__note">{{ note }}</span>
    </span>
  </article>
</template>

<script setup lang="ts">
// One headline figure of «Аналітика» (docs/specs/2026-11-07-developer-analytics.md, decision
// 8.2) with its change against the previous period of the same length. The ▲/▼ carries no
// colour of good or bad: more spend is not a failure and more agent time is not a success, so
// the tile states the direction and leaves the judgement to the reader. No previous data — no
// arrow at all (lib/analytics.ts `metricDelta`).
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import type { AnalyticsMetric } from '@kermanych/core';
import { metricDelta } from '../../lib/analytics';

const props = defineProps<{
  label: string;
  value: string;
  note?: string | undefined;
  /** The figure the delta is computed from; absent for a tile without a comparison. */
  metric?: AnalyticsMetric | undefined;
  /** Writes `metric.previous` the way `value` is written, for the delta's tooltip. */
  format?: ((v: number) => string) | undefined;
}>();
const { t } = useI18n();

const delta = computed(() => (props.metric ? metricDelta(props.metric) : null));
const previousText = computed(() => {
  const p = props.metric?.previous;
  if (p === null || p === undefined) return '';
  return props.format ? props.format(p) : String(p);
});
</script>

<style scoped lang="scss">
// The stat card of ManagementCapacityPage (`.cap__stat`), so the two report screens read alike.
.antile {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
  padding: var(--k-sp-3);
  background: color-mix(in srgb, var(--k-surface2) 40%, transparent);
  border: var(--k-rule-thin) solid var(--k-line);
  border-radius: var(--k-r-lg);
}

.antile__label {
  font-size: 10px;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: var(--k-faint);
}

.antile__value {
  font-family: var(--k-font-ui);
  font-size: 24px;
  font-weight: 800;
  letter-spacing: -0.02em;
  line-height: 1.15;
  color: var(--k-text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.antile__foot {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 2px var(--k-sp-2);
  min-height: 1.4em;
}

.antile__delta {
  font-size: var(--k-fs-xs);
  color: var(--k-muted);
}

.antile__delta--up,
.antile__delta--down {
  color: var(--k-text);
}

.antile__note {
  font-size: var(--k-fs-xs);
  color: var(--k-muted);
}
</style>
