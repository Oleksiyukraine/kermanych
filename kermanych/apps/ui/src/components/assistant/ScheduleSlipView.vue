<template>
  <!-- One schedule slip over the console (docs/specs/2026-11-06-scheduled-tasks.md, decision 6),
       opened from the feed the way a «Розклад» row opens its task: what fired, when, for which
       project, how it ended and the text — a reminder's, a run's answer or the reason it did not
       run. A run with a result takes the operator's reaction
       (docs/specs/2026-11-23-scheduled-task-run-memory.md, decision 5). The footer holds the two
       things to do with a slip (docs/specs/2026-11-24-notification-panel-actions.md): delete it,
       or turn what it says into a task. -->
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

    <footer v-if="slip" class="ssv__controls">
      <KBtn variant="ghost" :loading="remove.busy.value" @click="remove.run()">{{ t('cuk.notifications.slip.delete') }}</KBtn>
      <KBtn
        variant="primary"
        :disabled="!taskProjectId || remove.busy.value"
        :title="taskProjectId ? '' : t('cuk.notifications.slip.noProject')"
        @click="createTask"
      >{{ t('cuk.notifications.slip.createTask') }}</KBtn>
    </footer>
  </section>
</template>

<script setup lang="ts">
// Rendered by AssistantLauncher over the console while `notification-center.openSlipId` is set;
// opening it marks the slip seen (stores/notification-center.ts openSlip).
import { computed, nextTick, onMounted, ref, useId } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRouter } from 'vue-router';
import { taskNameFromText } from '@kermanych/core';
import { useNotificationCenter } from 'stores/notification-center';
import { useSchedules } from 'stores/schedules';
import { useProjects } from 'stores/projects';
import { useOrchestrator } from 'stores/orchestrator';
import { useAssistantOverlay } from 'stores/assistant-overlay';
import { useNow } from '../../composables/useNow';
import { errorText, useAsyncAction } from '../../composables/useAsyncAction';
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
const router = useRouter();
const nc = useNotificationCenter();
const schedules = useSchedules();
const projects = useProjects();
const local = useOrchestrator();
const overlay = useAssistantOverlay();
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

// The task's project: the slip's own, else the one picked at the top; none leaves «Створити
// задачу» disabled (docs/specs/2026-11-24-notification-panel-actions.md, decision 3).
const taskProjectId = computed(() => slip.value?.projectId ?? local.selectedProjectId);

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

// «Видалити сповіщення»: gone for good, and the panel with it; the run stays in the task's history.
const remove = useAsyncAction(async () => {
  await schedules.removeSlip(props.id);
  emit('close');
});

// What the panel shows, headed by where it came from (decision 4): the answer, the reason a run
// did not happen, or the reminder's text. The title comes from the text, not from the header.
function taskSeed(s: NonNullable<typeof slip.value>): { title: string; text: string } {
  const content = failed.value ? reasonText(t, s.reason, s.text) : (s.body ?? s.text);
  const params = { name: s.scheduleName, when: formatFiring(s.at, zone.value, locale.value) };
  const head =
    s.kind === 'reminder'
      ? t('cuk.notifications.slip.taskHeadReminder', params)
      : t(failed.value ? 'cuk.notifications.slip.taskHeadFailed' : 'cuk.notifications.slip.taskHeadRun', params);
  return { title: taskNameFromText(content), text: `${head}\n\n${content}` };
}

// A card made from a run's result marks that run «Взято в роботу» (decision 5), so the next runs
// do not repeat it. Runs after this view is gone, so the run is looked up then.
function takeRun(scheduleId: string, runId: string): void {
  const r = schedules.runs[scheduleId]?.find((x) => x.id === runId);
  if (!r || r.reaction === 'taken') return;
  schedules.react(r, 'taken').catch((e: unknown) => local.notify(t('cuk.notifications.slip.reactFailed', { error: errorText(e) }), 'error'));
}

// «Створити задачу»: ЦТ steps aside and «Агенти» opens «Нова задача» prefilled (decision 7). A
// project outside the scope picked at the top becomes it, so the new card shows in the backlog.
function createTask(): void {
  const s = slip.value;
  const projectId = taskProjectId.value;
  if (!s || !projectId) return;
  const runId = reactable.value ? s.runId : undefined;
  const inScope =
    local.selectedProjectId === projectId ||
    (!local.selectedProjectId && !!local.selectedWorkspaceId && local.projectWorkspace[projectId] === local.selectedWorkspaceId);
  if (!inScope) local.selectProject(projectId);
  local.requestNewTask({
    projectId,
    ...taskSeed(s),
    ...(runId ? { onCreated: () => takeRun(s.scheduleId, runId) } : {}),
  });
  nc.close();
  overlay.close();
  void router.push({ name: 'agents' });
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
