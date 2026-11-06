<template>
  <!-- One scheduled task over the console (docs/specs/2026-11-06-scheduled-tasks.md, decision 6),
       opened from a «Розклад» row the way an improvement opens: what it does, when, its run
       history, «Запустити зараз» and «Видалити». -->
  <section class="stv" :aria-labelledby="headingId">
    <header class="stv__head">
      <button
        ref="backEl"
        class="stv__back mono"
        type="button"
        :aria-label="t('cuk.notifications.entry.close')"
        v-tip="t('cuk.notifications.entry.close')"
        @click="emit('close')"
      >←</button>
      <h2 :id="headingId" class="stv__title mono">{{ task?.name ?? '' }}</h2>
      <span v-if="task && !task.enabled" class="stv__state mono">{{ t('cuk.schedule.paused') }}</span>
      <span v-else-if="task?.running" class="stv__state mono">{{ t('cuk.schedule.running') }}</span>
    </header>

    <div class="stv__body">
      <p v-if="!task" class="stv__note" role="note">{{ t('cuk.schedule.detail.gone') }}</p>
      <template v-else>
        <dl class="stv__facts">
          <dt>{{ t('cuk.card.type') }}</dt>
          <dd>{{ t(`cuk.schedule.kind.${task.kind}`) }}</dd>
          <template v-if="task.kind === 'agent'">
            <dt>{{ t('cuk.card.project') }}</dt>
            <dd>{{ project || t('cuk.card.noProject') }}</dd>
            <dt>{{ t('cuk.card.skills') }}</dt>
            <dd>{{ task.skills.length ? task.skills.join(', ') : t('cuk.card.noSkills') }}</dd>
            <dt>{{ t('cuk.card.model') }}</dt>
            <dd>{{ task.model ?? t(task.projectId ? 'cuk.schedule.detail.defaultModel' : 'cuk.schedule.detail.backendModel') }}</dd>
          </template>
          <dt>{{ t('cuk.card.when') }}</dt>
          <dd>{{ when }}</dd>
          <dt>{{ t('cuk.schedule.detail.nextLabel') }}</dt>
          <dd>{{ next }}</dd>
          <dt>{{ t('cuk.schedule.detail.timeZone') }}</dt>
          <dd class="mono">{{ task.timeZone }}</dd>
        </dl>

        <div class="stv__prompt">
          <span class="stv__label mono">{{ t(task.kind === 'reminder' ? 'cuk.card.reminderText' : 'cuk.card.prompt') }}</span>
          <p>{{ task.prompt }}</p>
        </div>

        <div class="stv__history">
          <span class="stv__label mono">{{ t('cuk.schedule.detail.history') }}</span>
          <KSkeleton v-if="phase === 'skeleton'" variant="rows" :rows="3" />
          <div v-else-if="runsError" class="stv__error" role="alert">
            <p>{{ t('cuk.schedule.detail.historyFailed', { error: runsError }) }}</p>
            <KBtn variant="ghost" :loading="loadRuns.busy.value" @click="loadRuns.run()">{{ t('cuk.notifications.retry') }}</KBtn>
          </div>
          <p v-else-if="runs && !runs.length" class="stv__empty">{{ t('cuk.schedule.detail.noRuns') }}</p>
          <ul v-else-if="runs" class="stv__runs">
            <li v-for="r in runs" :key="r.id" class="stv__run" :class="`stv__run--${r.status}`">
              <span class="stv__run-top mono">
                <span>{{ formatFiring(r.scheduledFor ?? r.startedAt, zone, locale) }}</span>
                <span class="stv__run-status">{{ t(`cuk.schedule.status.${r.status}`) }}</span>
                <span v-if="r.trigger === 'catch-up'" class="stv__run-mark">{{ t('cuk.notifications.slip.late') }}</span>
                <span v-else-if="r.trigger === 'manual'" class="stv__run-mark">{{ t('cuk.schedule.detail.manual') }}</span>
              </span>
              <span v-if="r.status === 'skipped' || r.status === 'failed'" class="stv__run-text">
                {{ reasonText(t, r.reason, r.detail ?? '') }}
              </span>
              <span v-else-if="r.summary" class="stv__run-text">{{ r.summary }}</span>
              <button v-if="r.sessionId && hasSession(r.sessionId)" class="stv__link" type="button" @click="openSession(r.sessionId)">
                {{ t('cuk.openSession') }}
              </button>
            </li>
          </ul>
        </div>
      </template>
    </div>

    <footer v-if="task" class="stv__controls">
      <KBtn variant="ghost" :loading="remove.busy.value" :disabled="runNow.busy.value" @click="remove.run()">
        {{ t('cuk.schedule.detail.delete') }}
      </KBtn>
      <KBtn
        variant="primary"
        :loading="runNow.busy.value"
        :disabled="remove.busy.value || task.running"
        @click="runNow.run()"
      >{{ t('cuk.schedule.runNow') }}</KBtn>
    </footer>
  </section>
</template>

<script setup lang="ts">
// Rendered by AssistantLauncher over the console while `notification-center.openTaskId` is set.
// The task comes from stores/schedules.ts and follows `schedules_update`; its history is read when
// the view opens and kept current by `schedule_run_update`.
import { computed, nextTick, onMounted, ref, useId } from 'vue';
import { useI18n } from 'vue-i18n';
import { describeSchedule } from '@kermanych/core';
import { useSchedules } from 'stores/schedules';
import { useProjects } from 'stores/projects';
import { useOrchestrator } from 'stores/orchestrator';
import { useCukChat } from 'stores/cuk-chat';
import { useAsyncAction } from '../../composables/useAsyncAction';
import { useLoadPhase } from '../../composables/useLoadPhase';
import { confirmAction } from '../../lib/confirm';
import { formatFiring, machineTimeZone, reasonText } from '../../lib/schedules';
import { locale as localeRef } from '../../lib/locale';
import KBtn from 'components/kit/KBtn.vue';
import KSkeleton from 'components/kit/KSkeleton.vue';

const props = defineProps<{ id: string }>();
const emit = defineEmits<{ close: [] }>();

const { t } = useI18n();
const schedules = useSchedules();
const projects = useProjects();
const local = useOrchestrator();
const chat = useCukChat();
const headingId = useId();
const backEl = ref<HTMLButtonElement | null>(null);

const locale = computed(() => localeRef.value);
const zone = computed(() => task.value?.timeZone ?? machineTimeZone());
const task = computed(() => schedules.tasks?.find((x) => x.id === props.id));
const runs = computed(() => schedules.runs[props.id]);
const runsError = ref('');
const phase = useLoadPhase(() => !runs.value && !runsError.value);

const project = computed(() => {
  const id = task.value?.projectId;
  return id ? (projects.byId.get(id)?.name ?? local.projects.find((p) => p.id === id)?.name ?? '') : '';
});
const when = computed(() => (task.value ? describeSchedule(task.value.schedule, locale.value) : ''));
const next = computed(() => {
  const x = task.value;
  if (!x) return '';
  if (!x.enabled) return t('cuk.schedule.paused');
  return x.nextAt ? formatFiring(x.nextAt, x.timeZone, locale.value) : t('cuk.schedule.nothingAhead');
});

const loadRuns = useAsyncAction(async () => {
  runsError.value = '';
  try {
    await schedules.loadRuns(props.id);
  } catch (e) {
    runsError.value = e instanceof Error ? e.message : String(e);
  }
});

onMounted(() => {
  void loadRuns.run();
  void nextTick(() => backEl.value?.focus());
});

// A run's session is linked only while this machine still has it (the operator may delete it).
function hasSession(id: string): boolean {
  return local.sessions.some((s) => s.id === id);
}

function openSession(id: string): void {
  emit('close');
  void chat.openSession(id);
}

const runNow = useAsyncAction(async () => {
  const x = task.value;
  if (!x) return;
  await schedules.runNow(x.id);
  local.notify(t('cuk.schedule.started', { name: x.name }), 'info');
});

// Delete asks first: the history goes with the task (spec decision 7, «a card always»).
const remove = useAsyncAction(async () => {
  const x = task.value;
  if (!x) return;
  const ok = await confirmAction({
    title: t('confirmations.deleteSchedule.title'),
    message: t('confirmations.deleteSchedule.message', { name: x.name }),
    confirmLabel: t('confirmations.label.delete'),
  });
  if (!ok) return;
  await schedules.remove(x.id);
  local.notify(t('cuk.schedule.deleted', { name: x.name }), 'info');
  emit('close');
});
</script>

<style scoped lang="scss">
// The improvement view's frame (SkillImprovementView .siv): opaque, over the console.
.stv {
  display: flex;
  flex-direction: column;
  min-height: 0;
  border: var(--k-rule-thin) solid var(--k-line-strong);
  border-radius: var(--k-r-lg);
  background: var(--k-surface);
  box-shadow: var(--k-shadow-pop);
  overflow: hidden;
}

.stv__head {
  flex: none;
  display: flex;
  align-items: center;
  gap: var(--k-sp-2);
  padding: var(--k-sp-2) var(--k-sp-3);
  border-bottom: var(--k-rule-thin) solid var(--k-line);
}

.stv__back {
  flex: none;
  width: 28px;
  height: 28px;
  padding: 0;
  border: var(--k-rule-thin) solid var(--k-line);
  border-radius: var(--k-r-pill);
  background: transparent;
  color: var(--k-text);
  cursor: pointer;

  &:hover,
  &:focus-visible {
    border-color: var(--k-accent);
  }
}

.stv__title {
  min-width: 0;
  margin: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--k-fs-sm);
  font-weight: var(--k-fw-semibold);
}

.stv__state {
  flex: none;
  margin-left: auto;
  padding: 0 6px;
  border: var(--k-rule-thin) solid var(--k-line-strong);
  border-radius: var(--k-r-pill);
  font-size: var(--k-fs-xs);
  color: var(--k-muted);
}

.stv__body {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: var(--k-sp-3);
  padding: var(--k-sp-3);
  overflow: auto;
}

.stv__facts {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 2px var(--k-sp-3);
  margin: 0;
  font-size: var(--k-fs-sm);

  dt {
    color: var(--k-muted);
  }

  dd {
    margin: 0;
    overflow-wrap: anywhere;
  }
}

.stv__label {
  display: block;
  margin-bottom: 2px;
  font-size: var(--k-fs-xs);
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: var(--k-muted);
}

.stv__prompt p {
  margin: 0;
  font-size: var(--k-fs-sm);
  line-height: 1.5;
  white-space: pre-line;
}

.stv__note,
.stv__empty {
  margin: 0;
  font-size: var(--k-fs-sm);
  color: var(--k-muted);
}

.stv__error p {
  margin: 0 0 var(--k-sp-2);
  font-size: var(--k-fs-sm);
  color: var(--k-danger);
}

.stv__runs {
  display: flex;
  flex-direction: column;
  gap: var(--k-sp-2);
  margin: 0;
  padding: 0;
  list-style: none;
}

.stv__run {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: var(--k-sp-2) var(--k-sp-3);
  border-left: 2px solid var(--k-line-strong);
  font-size: var(--k-fs-sm);
}

.stv__run--failed,
.stv__run--skipped {
  border-left-color: var(--k-danger);
}

.stv__run--running {
  border-left-color: var(--k-accent);
}

.stv__run-top {
  display: flex;
  flex-wrap: wrap;
  gap: var(--k-sp-2);
  font-size: var(--k-fs-xs);
  color: var(--k-faint);
}

.stv__run-status {
  color: var(--k-text);
}

.stv__run-mark {
  padding: 0 6px;
  border: var(--k-rule-thin) solid var(--k-warning);
  border-radius: var(--k-r-pill);
  color: var(--k-text);
}

.stv__run-text {
  line-height: 1.4;
  overflow-wrap: anywhere;
}

.stv__link {
  align-self: flex-start;
  padding: 0;
  border: none;
  background: transparent;
  color: var(--k-accent);
  font: inherit;
  font-size: var(--k-fs-xs);
  cursor: pointer;

  &:hover {
    text-decoration: underline;
  }
}

.stv__controls {
  flex: none;
  display: flex;
  justify-content: flex-end;
  gap: var(--k-sp-2);
  padding: var(--k-sp-2) var(--k-sp-3);
  border-top: var(--k-rule-thin) solid var(--k-line);
}
</style>
