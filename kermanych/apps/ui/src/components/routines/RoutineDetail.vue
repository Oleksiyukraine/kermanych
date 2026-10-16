<template>
  <KModal
    :model-value="!!routine"
    :title="routine?.name ?? ''"
    width="760px"
    :persistent="busy"
    @update:model-value="(v: boolean) => { if (!v) emit('close'); }"
  >
    <template #head-meta>
      <span v-if="routine" class="rtn-dt__tags">
        <KTag>{{ scopeLabel }}</KTag>
        <KTag>{{ kindLabel }}</KTag>
        <KTag v-if="!routine.enabled">{{ t('management.routines.paused') }}</KTag>
      </span>
    </template>

    <div v-if="routine" class="rtn-dt">
      <dl class="rtn-dt__facts">
        <dt>{{ t('management.routines.detail.what') }}</dt>
        <dd>
          <pre v-if="routine.action.kind === 'prompt'" class="rtn-dt__prompt">{{ routine.action.prompt }}</pre>
          <template v-else>
            <span class="rtn-dt__inline">
              <KTag v-for="s in routine.action.sources" :key="s.projectId">{{ projectName(s.projectId) }} · {{ s.branch }}</KTag>
            </span>
            <span class="rtn-dt__sub">
              {{ t('management.routines.detail.period', { days: routine.action.periodDays }) }}
              <template v-if="routine.action.groupBy === 'person'"> · {{ t('management.releases.byPersonTag') }}</template>
            </span>
          </template>
        </dd>

        <dt>{{ t('management.routines.detail.when') }}</dt>
        <dd>
          {{ describeSchedule(t, routine.schedule) }}
          <span class="rtn-dt__sub">
            {{ routine.timezone }}
            <template v-if="nextRun"> · {{ t('management.routines.detail.next', { when: nextRun }) }}</template>
          </span>
        </dd>

        <dt>{{ t('management.routines.detail.slack') }}</dt>
        <dd>{{ routine.slack ? `#${routine.slack.channelName}` : '—' }}</dd>

        <dt>{{ t('management.routines.detail.author') }}</dt>
        <dd>
          {{ memberName(routine.createdBy) }}
          <span class="rtn-dt__sub">{{ t('management.routines.detail.authorHint') }}</span>
        </dd>
      </dl>

      <section class="rtn-dt__history">
        <h3 class="rtn-dt__h">{{ t('management.routines.detail.history') }}</h3>
        <p v-if="!history.length" class="rtn-dt__sub">{{ t('management.routines.detail.noRuns') }}</p>
        <ol v-else class="rtn-dt__runs">
          <li v-for="run in history" :key="run.id" class="rtn-dt__run" :class="`rtn-dt__run--${run.status}`">
            <div class="rtn-dt__run-head">
              <span class="rtn-dt__status mono">{{ t(`management.routines.status.${run.status}`) }}</span>
              <span class="rtn-dt__sub">
                {{ t(`management.routines.trigger.${run.trigger}`) }} ·
                {{ renderTime(t, relativeTime(run.startedAt, now)) }}
              </span>
            </div>
            <div class="rtn-dt__run-body">
              <span v-if="run.commitCount !== undefined">{{ t('management.routines.detail.commits', { count: run.commitCount }) }}</span>
              <a v-if="run.noteId" class="rtn-dt__link" @click="emit('openSection', 'management-releases')">
                {{ t('management.routines.detail.openNote') }}
              </a>
              <a v-if="run.taskId" class="rtn-dt__link" @click="emit('openSection', 'agents')">
                {{ t('management.routines.detail.openAgent') }}
              </a>
              <span v-if="run.slackChannelName">{{ t('management.routines.detail.posted', { channel: run.slackChannelName }) }}</span>
              <a v-if="run.outputMd" class="rtn-dt__link" @click="toggle(run.id)">
                {{ expanded === run.id ? t('management.routines.detail.hideReport') : t('management.routines.detail.showReport') }}
              </a>
            </div>
            <p v-if="reason(run)" class="rtn-dt__reason">{{ reason(run) }}</p>
            <!-- renderMarkdown escapes raw HTML (markdown-it html:false): the same guarantee the
                 release-notes reader relies on for a model-written document. -->
            <div v-if="expanded === run.id && run.outputMd" class="k-log__markdown rtn-dt__report" v-html="renderMarkdown(run.outputMd)"></div>
          </li>
        </ol>
      </section>
    </div>

    <template #controls>
      <template v-if="routine">
        <KBtn v-if="rights.remove" variant="ghost" :disabled="busy" @click="removeRoutine">
          {{ confirmDelete ? t('management.routines.detail.confirmDelete') : t('management.routines.detail.delete') }}
        </KBtn>
        <KBtn v-if="rights.toggle" variant="secondary" :disabled="busy" @click="toggleEnabled">
          {{ routine.enabled ? t('management.routines.detail.pause') : t('management.routines.detail.resume') }}
        </KBtn>
        <KBtn v-if="rights.edit" variant="secondary" :disabled="busy" @click="emit('edit', routine)">
          {{ t('management.routines.detail.edit') }}
        </KBtn>
        <KBtn v-if="rights.run" variant="primary" :loading="running" :disabled="busy || isRunning" @click="runNow">
          {{ isRunning ? t('management.routines.status.running') : t('management.routines.detail.runNow') }}
        </KBtn>
      </template>
    </template>
  </KModal>
</template>

<script setup lang="ts">
// One routine: what it does, when, where its result goes, and its run history — plus the
// actions the operator's rights allow (lib/routines `routineRights`).
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { nextOccurrence } from '@kermanych/core';
import type { WorkspaceRoutine, WorkspaceRoutineRun } from '@kermanych/cloud';
import KModal from 'components/kit/KModal.vue';
import KBtn from 'components/kit/KBtn.vue';
import KTag from 'components/kit/KTag.vue';
import { useRoutines } from 'stores/routines';
import { useProjects } from 'stores/projects';
import { useAuth } from 'stores/auth';
import { useOrchestrator } from 'stores/orchestrator';
import { renderMarkdown } from '../../lib/markdown';
import { relativeTime, renderTime } from '../../lib/time';
import { describeSchedule, formatInstant, routineRights, runReason } from '../../lib/routines';
import { useNow } from '../../composables/useNow';

const props = defineProps<{ routine: WorkspaceRoutine | undefined; workspaceId: string }>();
const emit = defineEmits<{ close: []; edit: [routine: WorkspaceRoutine]; openSection: [name: string] }>();

const { t, te, locale } = useI18n();
const store = useRoutines();
const projects = useProjects();
const auth = useAuth();
const local = useOrchestrator();
const now = useNow(30_000);

const busy = ref(false);
const running = ref(false);
const confirmDelete = ref(false);
const expanded = ref<string | undefined>(undefined);

watch(
  () => props.routine?.id,
  () => {
    confirmDelete.value = false;
    expanded.value = undefined;
  },
);

const rights = computed(() =>
  props.routine
    ? routineRights(props.routine, auth.user?.id, projects.isWorkspaceOwner(props.workspaceId))
    : { edit: false, run: false, toggle: false, remove: false },
);

const history = computed<WorkspaceRoutineRun[]>(() =>
  (store.runs[props.workspaceId] ?? []).filter((r) => r.routineId === props.routine?.id),
);
const isRunning = computed(() => history.value.some((r) => r.status === 'running'));

function projectName(id: string): string {
  return projects.projects.find((p) => p.id === id)?.name ?? id;
}

const scopeLabel = computed(() =>
  props.routine?.projectId ? projectName(props.routine.projectId) : t('management.routines.scopeWorkspace'),
);
const kindLabel = computed(() => {
  const r = props.routine;
  if (!r) return '';
  if (r.action.kind === 'release_notes') return t('management.routines.kind.release_notes');
  return r.projectId ? t('management.routines.kind.promptProject') : t('management.routines.kind.promptWorkspace');
});

const nextRun = computed(() => {
  const r = props.routine;
  if (!r?.enabled) return '';
  const at = nextOccurrence(r.schedule, r.timezone, now.value);
  return at === undefined ? '' : formatInstant(at, r.timezone, locale.value);
});

function memberName(id: string | undefined): string {
  if (!id) return '—';
  const m = (projects.members[props.workspaceId] ?? []).find((x) => x.userId === id);
  return m?.profile?.displayName ?? m?.profile?.githubUsername ?? id;
}

const reason = (run: WorkspaceRoutineRun) => runReason({ t, te }, run);

function toggle(id: string): void {
  expanded.value = expanded.value === id ? undefined : id;
}

async function act(work: () => Promise<unknown>): Promise<void> {
  busy.value = true;
  try {
    await work();
  } catch (e) {
    local.notify(e instanceof Error ? e.message : String(e), 'error');
  } finally {
    busy.value = false;
  }
}

async function runNow(): Promise<void> {
  const r = props.routine;
  if (!r) return;
  running.value = true;
  await act(() => store.runNow(r));
  running.value = false;
}

function toggleEnabled(): Promise<void> {
  const r = props.routine;
  return r ? act(() => store.update(r, { enabled: !r.enabled })) : Promise.resolve();
}

// Two presses, the second labelled as the one that deletes: the history goes with it.
async function removeRoutine(): Promise<void> {
  const r = props.routine;
  if (!r) return;
  if (!confirmDelete.value) {
    confirmDelete.value = true;
    return;
  }
  await act(async () => {
    await store.remove(r);
    emit('close');
  });
}
</script>

<style scoped lang="scss">
.rtn-dt {
  display: flex;
  flex-direction: column;
  gap: var(--k-sp-4);
}

.rtn-dt__tags,
.rtn-dt__inline {
  display: inline-flex;
  flex-wrap: wrap;
  gap: var(--k-sp-1);
}

.rtn-dt__facts {
  display: grid;
  grid-template-columns: max-content 1fr;
  gap: var(--k-sp-2) var(--k-sp-4);
  margin: 0;

  dt {
    font-size: var(--k-fs-xs);
    color: var(--k-faint);
    padding-top: 2px;
  }

  dd {
    display: flex;
    flex-direction: column;
    gap: var(--k-sp-1);
    margin: 0;
    font-size: var(--k-fs-sm);
    color: var(--k-text);
  }
}

.rtn-dt__prompt {
  margin: 0;
  max-height: 180px;
  overflow: auto;
  padding: var(--k-sp-2);
  font-family: var(--k-font-mono);
  font-size: var(--k-fs-xs);
  white-space: pre-wrap;
  background: color-mix(in srgb, var(--k-surface2) 50%, transparent);
  border: var(--k-rule-thin) solid var(--k-line);
  border-radius: var(--k-r);
}

.rtn-dt__sub {
  font-size: var(--k-fs-xs);
  color: var(--k-faint);
}

.rtn-dt__h {
  margin: 0 0 var(--k-sp-2);
  font-size: var(--k-fs-sm);
  font-weight: 650;
  color: var(--k-text);
}

.rtn-dt__runs {
  display: flex;
  flex-direction: column;
  gap: var(--k-sp-2);
  margin: 0;
  padding: 0;
  list-style: none;
  max-height: 360px;
  overflow: auto;
}

.rtn-dt__run {
  display: flex;
  flex-direction: column;
  gap: var(--k-sp-1);
  padding: var(--k-sp-2) var(--k-sp-3);
  border: var(--k-rule-thin) solid var(--k-line);
  border-left-width: 3px;
  border-radius: var(--k-r);
}

.rtn-dt__run--succeeded { border-left-color: var(--k-success, var(--k-accent)); }
.rtn-dt__run--running { border-left-color: var(--k-accent); }
.rtn-dt__run--failed { border-left-color: var(--k-danger); }
.rtn-dt__run--skipped { border-left-color: var(--k-line-strong); }

.rtn-dt__run-head,
.rtn-dt__run-body {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: var(--k-sp-2);
  font-size: var(--k-fs-xs);
  color: var(--k-muted);
}

.rtn-dt__status {
  font-size: var(--k-fs-xs);
  color: var(--k-text);
}

.rtn-dt__link {
  color: var(--k-accent);
  cursor: pointer;
}

.rtn-dt__reason {
  margin: 0;
  font-size: var(--k-fs-xs);
  line-height: 1.5;
  color: var(--k-danger);
}

.rtn-dt__run--skipped .rtn-dt__reason {
  color: var(--k-muted);
}

.rtn-dt__report {
  padding-top: var(--k-sp-2);
  border-top: var(--k-rule-thin) solid var(--k-line);
}
</style>
