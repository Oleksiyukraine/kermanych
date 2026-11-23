<template>
  <!-- The operator's verdict on a scheduled run's result (docs/specs/2026-11-23-scheduled-task-run-memory.md,
       decisions 2 and 5): «Взято в роботу» / «Не цікаво», pressed again to take it back. The next
       run of the task reads it beside the result. One record behind both places it shows: the
       slip view and the task's run history. -->
  <span class="srr" role="group" :aria-label="t('cuk.schedule.reaction.label')" :aria-busy="pending || undefined">
    <button
      v-for="r in SCHEDULE_RUN_REACTIONS"
      :key="r"
      type="button"
      class="srr__btn mono"
      :class="[`srr__btn--${r}`, { 'srr__btn--on': value === r }]"
      :aria-pressed="value === r"
      :disabled="pending"
      @click="set(value === r ? null : r)"
    >
      <span aria-hidden="true">{{ r === 'taken' ? '✓' : '✕' }}</span>
      {{ t(`cuk.schedule.reaction.${r}`) }}
    </button>
    <KSpinner v-if="pending" :size="10" />
  </span>
</template>

<script setup lang="ts">
import { useI18n } from 'vue-i18n';
import { SCHEDULE_RUN_REACTIONS, type ScheduleRun, type ScheduleRunReaction } from '@kermanych/core';
import { useSchedules } from 'stores/schedules';
import { useOptimisticValue } from '../../composables/useOptimisticValue';
import KSpinner from 'components/kit/KSpinner.vue';

const props = defineProps<{ run: ScheduleRun }>();

const { t } = useI18n();
const schedules = useSchedules();

const { value, pending, set } = useOptimisticValue<ScheduleRunReaction | null>(
  () => props.run.reaction ?? null,
  (next) => schedules.react(props.run, next),
);
</script>

<style scoped lang="scss">
.srr {
  display: inline-flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--k-sp-1);
}

.srr__btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 1px 8px;
  border: var(--k-rule-thin) solid var(--k-line-strong);
  border-radius: var(--k-r-pill);
  background: transparent;
  color: var(--k-muted);
  font-size: var(--k-fs-xs);
  cursor: pointer;

  &:hover:not(:disabled),
  &:focus-visible {
    border-color: var(--k-accent);
    color: var(--k-text);
  }

  &:disabled {
    cursor: default;
  }
}

.srr__btn--taken.srr__btn--on {
  border-color: var(--k-success);
  color: var(--k-text);
  background: color-mix(in srgb, var(--k-success) 18%, transparent);
}

.srr__btn--rejected.srr__btn--on {
  border-color: var(--k-danger);
  color: var(--k-text);
  background: color-mix(in srgb, var(--k-danger) 18%, transparent);
}
</style>
