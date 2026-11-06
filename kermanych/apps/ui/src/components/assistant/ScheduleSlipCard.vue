<template>
  <!-- One schedule slip on «Центр сповіщень»'s board (docs/specs/2026-11-06-scheduled-tasks.md,
       decision 6): a reminder that fired, an agent run that ended, or a run skipped or failed.
       Not a button like an improvement's slip: it carries its own actions. -->
  <article
    class="ssc"
    :class="{ 'ssc--new': !slip.seen, 'ssc--open': open, 'ssc--failed': failed }"
    :aria-label="slip.scheduleName"
  >
    <header class="ssc__top">
      <span class="ssc__kind" aria-hidden="true"><KIcon name="clock" /></span>
      <span class="ssc__name mono">{{ heading }}</span>
      <span class="ssc__when mono">{{ renderTime(t, relativeTime(slip.at, now)) }}</span>
    </header>
    <p class="ssc__text">{{ line }}</p>
    <p v-if="marker || due" class="ssc__meta mono">
      <span v-if="marker" class="ssc__mark">{{ marker }}</span>
      <span v-if="due">{{ due }}</span>
    </p>
    <div class="ssc__actions">
      <template v-if="slip.kind === 'reminder'">
        <KBtn v-if="!slip.seen" variant="ghost" :loading="done.busy.value" @click="done.run()">{{ t('cuk.notifications.slip.done') }}</KBtn>
        <KBtn variant="ghost" :loading="snooze.busyFor('10')" :disabled="snooze.anyBusy()" @click="snooze.run('10')">
          {{ t('cuk.notifications.slip.snooze10') }}
        </KBtn>
        <KBtn variant="ghost" :loading="snooze.busyFor('60')" :disabled="snooze.anyBusy()" @click="snooze.run('60')">
          {{ t('cuk.notifications.slip.snooze60') }}
        </KBtn>
      </template>
      <template v-else-if="!failed">
        <KBtn v-if="slip.sessionId" variant="ghost" :loading="openSession.busy.value" @click="openSession.run()">
          {{ t('cuk.openSession') }}
        </KBtn>
        <KBtn v-else-if="slip.body" variant="ghost" @click="nc.openSlip(slip.id)">{{ t('cuk.notifications.slip.open') }}</KBtn>
      </template>
      <KBtn v-else-if="task && !task.running" variant="ghost" :loading="runNow.busy.value" @click="runNow.run()">
        {{ t('cuk.schedule.runNow') }}
      </KBtn>
    </div>
  </article>
</template>

<script setup lang="ts">
// Rendered by CukNotifications for a `schedule-slip` row. The writes go through stores/schedules.ts
// (the local api); every action also marks the slip seen, as opening an improvement does.
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import type { ScheduleSlip } from '@kermanych/core';
import { useNotificationCenter } from 'stores/notification-center';
import { useSchedules } from 'stores/schedules';
import { useCukChat } from 'stores/cuk-chat';
import { useOrchestrator } from 'stores/orchestrator';
import { useAsyncAction, useKeyedAction } from '../../composables/useAsyncAction';
import { useNow } from '../../composables/useNow';
import { relativeTime, renderTime } from '../../lib/time';
import { formatFiring, machineTimeZone, reasonText } from '../../lib/schedules';
import { locale } from '../../lib/locale';
import KBtn from 'components/kit/KBtn.vue';
import KIcon from 'components/kit/KIcon.vue';

const props = defineProps<{ slip: ScheduleSlip }>();

const { t } = useI18n();
const nc = useNotificationCenter();
const schedules = useSchedules();
const chat = useCukChat();
const local = useOrchestrator();
const now = useNow(60_000);

const failed = computed(() => props.slip.status === 'skipped' || props.slip.status === 'failed');
const open = computed(() => nc.openSlipId === props.slip.id);
const task = computed(() => schedules.tasks?.find((x) => x.id === props.slip.scheduleId));

const heading = computed(() =>
  props.slip.kind === 'reminder' ? t('cuk.schedule.kind.reminder') : props.slip.scheduleName,
);
// A reminder's text, a run's first line, or the reason a run did not happen.
const line = computed(() => (failed.value ? reasonText(t, props.slip.reason, props.slip.text) : props.slip.text));

// Decision 8: a reminder that fired late was missed (the Mac slept, the app was closed); a run
// that did is a catch-up, «із запізненням». A skipped run says why in its line instead.
const marker = computed(() => {
  if (!props.slip.late || failed.value) return '';
  return t(props.slip.kind === 'reminder' ? 'cuk.notifications.slip.missed' : 'cuk.notifications.slip.late');
});
const due = computed(() =>
  props.slip.late && props.slip.scheduledFor
    ? t('cuk.notifications.slip.due', { at: formatFiring(props.slip.scheduledFor, task.value?.timeZone ?? machineTimeZone(), locale.value) })
    : '',
);

const seen = () => schedules.markSlipsSeen([props.slip.id]);

const done = useAsyncAction(seen);
const snooze = useKeyedAction((minutes: string) => schedules.snooze(props.slip.id, minutes === '60' ? 60 : 10));
const openSession = useAsyncAction(async () => {
  const id = props.slip.sessionId;
  if (!id) return;
  void seen().catch(() => undefined);
  nc.close();
  await chat.openSession(id);
});
const runNow = useAsyncAction(async () => {
  await schedules.runNow(props.slip.scheduleId);
  void seen().catch(() => undefined);
  local.notify(t('cuk.schedule.started', { name: props.slip.scheduleName }), 'info');
});
</script>

<style scoped lang="scss">
// The same paper slip as an improvement's (CukNotifications .nc__slip), as an article.
.ssc {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 3px;
  padding: var(--k-sp-2) var(--k-sp-3) var(--k-sp-2) calc(var(--k-sp-3) + 3px);
  border: var(--k-rule-thin) solid var(--k-line);
  border-radius: var(--k-r);
  background: var(--k-surface);
  box-shadow: var(--k-shadow-card);
  color: var(--k-text);
}

.ssc--new::before {
  content: '';
  position: absolute;
  top: 6px;
  bottom: 6px;
  left: 0;
  width: 3px;
  border-radius: 0 3px 3px 0;
  background: var(--k-accent);
}

.ssc--open {
  border-color: var(--k-accent);
}

.ssc--failed .ssc__text {
  color: var(--k-danger);
}

.ssc__top {
  display: flex;
  align-items: center;
  gap: var(--k-sp-1);
  min-width: 0;
}

.ssc__kind {
  flex: none;
  display: inline-flex;
  color: var(--k-muted);
  --k-icon-size: var(--k-icon-xs);
}

.ssc__name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--k-fs-xs);
  font-weight: var(--k-fw-semibold);
}

.ssc__when {
  flex: none;
  margin-left: auto;
  font-size: var(--k-fs-xs);
  color: var(--k-faint);
}

.ssc__text {
  margin: 0;
  font-size: var(--k-fs-sm);
  line-height: 1.4;
  overflow-wrap: anywhere;
}

.ssc__meta {
  display: flex;
  flex-wrap: wrap;
  gap: var(--k-sp-2);
  margin: 0;
  font-size: var(--k-fs-xs);
  color: var(--k-faint);
}

.ssc__mark {
  padding: 0 6px;
  border: var(--k-rule-thin) solid var(--k-warning);
  border-radius: var(--k-r-pill);
  color: var(--k-text);
}

.ssc__actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--k-sp-1);
  margin-top: 2px;

  &:empty {
    display: none;
  }
}
</style>
