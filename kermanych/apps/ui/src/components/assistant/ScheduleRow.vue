<template>
  <!-- One scheduled task on the «Розклад» tab (docs/specs/2026-11-06-scheduled-tasks.md,
       decision 6): its kind, name, project, the schedule in words, the next firing, and the pause
       switch. The row opens the task over the console; the switch beside it is its own control. -->
  <li class="srow" :class="{ 'srow--paused': !enabled.value.value, 'srow--open': open }">
    <button class="srow__main" type="button" :aria-current="open || undefined" @click="nc.openTask(task.id)">
      <span class="srow__top">
        <span class="srow__kind mono">
          <KIcon name="clock" aria-hidden="true" />{{ t(`cuk.schedule.kind.${task.kind}`) }}
        </span>
        <span v-if="task.running" class="srow__running mono">{{ t('cuk.schedule.running') }}</span>
      </span>
      <span class="srow__name">{{ task.name }}</span>
      <span class="srow__when">{{ when }}</span>
      <span class="srow__meta mono">{{ meta }}</span>
    </button>
    <span class="srow__switch" v-tip="t('cuk.schedule.enabledTip')">
      <KCheckbox
        :model-value="enabled.value.value"
        :loading="enabled.pending.value"
        :label="t('cuk.schedule.enabled')"
        @update:model-value="(v: boolean) => enabled.set(v)"
      />
    </span>
  </li>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { describeSchedule, type ScheduledTask } from '@kermanych/core';
import { useNotificationCenter } from 'stores/notification-center';
import { useSchedules } from 'stores/schedules';
import { useProjects } from 'stores/projects';
import { useOrchestrator } from 'stores/orchestrator';
import { useOptimisticValue } from '../../composables/useOptimisticValue';
import { formatFiring } from '../../lib/schedules';
import { locale } from '../../lib/locale';
import KCheckbox from 'components/kit/KCheckbox.vue';
import KIcon from 'components/kit/KIcon.vue';

const props = defineProps<{ task: ScheduledTask }>();

const { t } = useI18n();
const nc = useNotificationCenter();
const schedules = useSchedules();
const projects = useProjects();
const local = useOrchestrator();

const open = computed(() => nc.openTaskId === props.task.id);
const when = computed(() => describeSchedule(props.task.schedule, locale.value));

// Save-on-change: the picked state shows at once and holds until `schedules_update` echoes it.
const enabled = useOptimisticValue(
  () => props.task.enabled,
  (next: boolean) => schedules.setEnabled(props.task.id, next),
);

// «проєкт · наступне: чт, 6 лист., 19:00», or why nothing is ahead.
const meta = computed(() => {
  const task = props.task;
  const project = task.projectId
    ? (projects.byId.get(task.projectId)?.name ?? local.projects.find((p) => p.id === task.projectId)?.name ?? '')
    : task.kind === 'agent'
      ? t('cuk.card.noProject')
      : '';
  const next = !task.enabled
    ? t('cuk.schedule.paused')
    : task.nextAt
      ? t('cuk.schedule.next', { at: formatFiring(task.nextAt, task.timeZone, locale.value) })
      : t('cuk.schedule.nothingAhead');
  return [project, next].filter(Boolean).join(' · ');
});
</script>

<style scoped lang="scss">
.srow {
  display: flex;
  align-items: flex-start;
  gap: var(--k-sp-2);
  padding: var(--k-sp-2) var(--k-sp-3);
  border: var(--k-rule-thin) solid var(--k-line);
  border-radius: var(--k-r);
  background: var(--k-surface);
  box-shadow: var(--k-shadow-card);
}

.srow--open {
  border-color: var(--k-accent);
}

// Paused: listed, but quieter than what will fire.
.srow--paused .srow__main {
  opacity: 0.66;
}

.srow__main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 0;
  border: none;
  background: transparent;
  color: var(--k-text);
  font: inherit;
  text-align: left;
  cursor: pointer;

  &:hover .srow__name,
  &:focus-visible .srow__name {
    text-decoration: underline;
  }

  &:focus-visible {
    outline: none;
    box-shadow: var(--k-glow-focus);
  }
}

.srow__top {
  display: flex;
  align-items: center;
  gap: var(--k-sp-2);
}

.srow__kind {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  font-size: var(--k-fs-xs);
  color: var(--k-muted);
  --k-icon-size: var(--k-icon-xs);
}

.srow__running {
  font-size: var(--k-fs-xs);
  color: var(--k-accent);
}

.srow__name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--k-fs-sm);
  font-weight: var(--k-fw-semibold);
}

.srow__when {
  font-size: var(--k-fs-sm);
  line-height: 1.4;
}

.srow__meta {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--k-fs-xs);
  color: var(--k-faint);
}

.srow__switch {
  flex: none;
  font-size: var(--k-fs-xs);
}
</style>
