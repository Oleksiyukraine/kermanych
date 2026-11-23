<template>
  <!-- One schedule slip over the console (docs/specs/2026-11-06-scheduled-tasks.md, decision 6),
       opened from the feed the way a «Розклад» row opens its task: what fired, when, for which
       project, how it ended and the text — a reminder's, a run's answer or the reason it did not
       run. A run without a project keeps its whole answer here (decision 9), and «Обговорити в
       ЦУК» carries it into the ЦУК composer. A run with a result takes the operator's reaction
       (docs/specs/2026-11-23-scheduled-task-run-memory.md, decision 5). The run's session and the
       task are links, not the slip's click: a finished run's session is history, the slip is what
       the operator came for. -->
  <section class="ssv" :aria-labelledby="headingId">
    <header class="ssv__head">
      <button
        ref="backEl"
        class="ssv__back mono"
        type="button"
        :aria-label="t('cuk.notifications.entry.close')"
        v-tip="t('cuk.notifications.entry.close')"
        @click="emit('close')"
      >←</button>
      <h2 :id="headingId" class="ssv__title mono">{{ slip?.scheduleName ?? '' }}</h2>
      <span v-if="badge" class="ssv__state mono">{{ badge }}</span>
    </header>

    <div class="ssv__body">
      <p v-if="!slip" class="ssv__note" role="note">{{ t('cuk.notifications.gone') }}</p>
      <template v-else>
        <p class="ssv__meta mono">{{ renderTime(t, relativeTime(slip.at, now)) }}</p>
        <dl class="ssv__facts">
          <dt>{{ t('cuk.card.type') }}</dt>
          <dd>{{ t(slip.kind === 'reminder' ? 'cuk.schedule.kind.reminder' : 'cuk.schedule.kind.agent') }}</dd>
          <template v-if="slip.kind === 'run'">
            <dt>{{ t('cuk.card.project') }}</dt>
            <dd>{{ project || t('cuk.card.noProject') }}</dd>
            <template v-if="slip.status">
              <dt>{{ t('cuk.notifications.slip.status') }}</dt>
              <dd>{{ t(`cuk.schedule.status.${slip.status}`) }}</dd>
            </template>
          </template>
          <dt>{{ t('cuk.card.when') }}</dt>
          <dd>{{ formatFiring(slip.at, zone, locale) }}</dd>
          <template v-if="slip.scheduledFor">
            <dt>{{ t('cuk.notifications.slip.scheduledFor') }}</dt>
            <dd>{{ formatFiring(slip.scheduledFor, zone, locale) }}</dd>
          </template>
          <template v-if="reactable && (run || runPhase !== 'ready')">
            <dt>{{ t('cuk.schedule.reaction.label') }}</dt>
            <dd>
              <ScheduleRunReaction v-if="run" :run="run" />
              <KSkeleton v-else-if="runPhase === 'skeleton'" width="220px" />
            </dd>
          </template>
        </dl>
        <p v-if="failed" class="ssv__reason">{{ reasonText(t, slip.reason, slip.text) }}</p>
        <div v-else class="k-log__markdown ssv__text" v-html="renderMarkdown(slip.body ?? slip.text)"></div>
      </template>
    </div>

    <footer v-if="slip && (task || session || slip.body)" class="ssv__controls">
      <KBtn v-if="task" variant="ghost" @click="nc.openTask(task.id)">{{ t('cuk.notifications.slip.openTask') }}</KBtn>
      <KBtn v-if="session" variant="ghost" @click="openSession(session)">{{ t('cuk.openSession') }}</KBtn>
      <KBtn v-if="slip.body" variant="primary" @click="discuss">{{ t('cuk.notifications.slip.discuss') }}</KBtn>
    </footer>
  </section>
</template>

<script setup lang="ts">
// Rendered by AssistantLauncher over the console while `notification-center.openSlipId` is set;
// opening it marks the slip seen (stores/notification-center.ts openSlip).
import { computed, nextTick, onMounted, ref, useId } from 'vue';
import { useI18n } from 'vue-i18n';
import { useNotificationCenter } from 'stores/notification-center';
import { useSchedules } from 'stores/schedules';
import { useCukChat } from 'stores/cuk-chat';
import { useProjects } from 'stores/projects';
import { useOrchestrator } from 'stores/orchestrator';
import { useNow } from '../../composables/useNow';
import { useAsyncAction } from '../../composables/useAsyncAction';
import { useLoadPhase } from '../../composables/useLoadPhase';
import { relativeTime, renderTime } from '../../lib/time';
import { renderMarkdown } from '../../lib/markdown';
import { formatFiring, machineTimeZone, reasonText } from '../../lib/schedules';
import { locale } from '../../lib/locale';
import KBtn from 'components/kit/KBtn.vue';
import KSkeleton from 'components/kit/KSkeleton.vue';
import ScheduleRunReaction from './ScheduleRunReaction.vue';

const props = defineProps<{ id: string }>();
const emit = defineEmits<{ close: [] }>();

const { t } = useI18n();
const nc = useNotificationCenter();
const schedules = useSchedules();
const chat = useCukChat();
const projects = useProjects();
const local = useOrchestrator();
const now = useNow(60_000);
const headingId = useId();
const backEl = ref<HTMLButtonElement | null>(null);

const slip = computed(() => schedules.slips?.find((s) => s.id === props.id));
// The task the slip came from, while it is still in the schedule.
const task = computed(() => schedules.tasks?.find((x) => x.id === slip.value?.scheduleId));
const zone = computed(() => task.value?.timeZone ?? machineTimeZone());
const failed = computed(() => slip.value?.status === 'skipped' || slip.value?.status === 'failed');

// How it ended when that is news: a run that did not happen, a missed reminder, a late catch-up.
const badge = computed(() => {
  const s = slip.value;
  if (!s) return '';
  if (failed.value && s.status) return t(`cuk.schedule.status.${s.status}`);
  if (!s.late) return '';
  return t(s.kind === 'reminder' ? 'cuk.notifications.slip.missed' : 'cuk.notifications.slip.late');
});

// Named from the cloud list first, then this machine's registry, as the feed names an improvement's.
const project = computed(() => {
  const id = slip.value?.projectId;
  return id ? (projects.byId.get(id)?.name ?? local.projects.find((p) => p.id === id)?.name ?? '') : '';
});

// A run's session is linked only while this machine still has it (the operator may delete it),
// as in the task's run history (ScheduleTaskView).
const session = computed(() => {
  const id = slip.value?.sessionId;
  return id && local.sessions.some((s) => s.id === id) ? id : undefined;
});

// The run behind a slip with a result, from the task's history (read here when no view has yet):
// the reaction is the run's, so the slip and the history show one record. A task that is gone,
// or a run the history no longer keeps, takes no reaction.
const reactable = computed(() => slip.value?.kind === 'run' && slip.value.status === 'done' && !!slip.value.runId && !!task.value);
const taskRuns = computed(() => (slip.value ? schedules.runs[slip.value.scheduleId] : undefined));
const run = computed(() => taskRuns.value?.find((r) => r.id === slip.value?.runId));
const loadRuns = useAsyncAction(async () => {
  if (slip.value) await schedules.loadRuns(slip.value.scheduleId);
});
const runPhase = useLoadPhase(() => reactable.value && !taskRuns.value && loadRuns.busy.value);

onMounted(() => {
  if (reactable.value && !taskRuns.value) void loadRuns.run();
  void nextTick(() => backEl.value?.focus());
});

function openSession(id: string): void {
  emit('close');
  void chat.openSession(id);
}

// The answer, headed by the task's name, lands in the draft; the operator writes the question.
function discuss(): void {
  const s = slip.value;
  if (!s) return;
  nc.close();
  chat.discuss(t('cuk.notifications.slip.discussDraft', { name: s.scheduleName, body: s.body ?? s.text }));
}
</script>

<style scoped lang="scss">
// The improvement view's frame (SkillImprovementView .siv): opaque, over the console.
.ssv {
  display: flex;
  flex-direction: column;
  min-height: 0;
  border: var(--k-rule-thin) solid var(--k-line-strong);
  border-radius: var(--k-r-lg);
  background: var(--k-surface);
  box-shadow: var(--k-shadow-pop);
  overflow: hidden;
}

.ssv__head {
  flex: none;
  display: flex;
  align-items: center;
  gap: var(--k-sp-2);
  padding: var(--k-sp-2) var(--k-sp-3);
  border-bottom: var(--k-rule-thin) solid var(--k-line);
}

.ssv__back {
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

.ssv__title {
  min-width: 0;
  margin: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--k-fs-sm);
  font-weight: var(--k-fw-semibold);
}

.ssv__state {
  flex: none;
  margin-left: auto;
  padding: 0 6px;
  border: var(--k-rule-thin) solid var(--k-warning);
  border-radius: var(--k-r-pill);
  font-size: var(--k-fs-xs);
}

.ssv__body {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: var(--k-sp-2);
  padding: var(--k-sp-3);
  overflow: auto;
}

.ssv__meta {
  margin: 0;
  font-size: var(--k-fs-xs);
  color: var(--k-faint);
}

.ssv__note {
  margin: 0;
  font-size: var(--k-fs-sm);
  color: var(--k-muted);
}

.ssv__text {
  font-size: var(--k-fs-sm);
  line-height: 1.5;
}

// The task view's facts (ScheduleTaskView .stv__facts).
.ssv__facts {
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

// A run that did not happen says why, in the colour its slip does (ScheduleSlipCard .ssc--failed).
.ssv__reason {
  margin: 0;
  font-size: var(--k-fs-sm);
  line-height: 1.5;
  color: var(--k-danger);
}

.ssv__controls {
  flex: none;
  display: flex;
  justify-content: flex-end;
  gap: var(--k-sp-2);
  padding: var(--k-sp-2) var(--k-sp-3);
  border-top: var(--k-rule-thin) solid var(--k-line);
}
</style>
