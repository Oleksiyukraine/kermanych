<template>
  <section class="rtn">
    <p class="rtn__lead">
      {{ t('management.routines.leadBefore') }}
      <span class="rtn__lead-workspace mono">{{ workspaceName }}</span>
      {{ t('management.routines.leadAfter') }}
    </p>

    <div class="rtn__toolbar">
      <!-- Workspace or project level: the same list, narrowed. Opens on the project the sidebar
           has selected, because «this project's routines» is what that selection asks for. -->
      <KSelect
        class="rtn__scope"
        :model-value="scope"
        :options="scopeOptions"
        @update:model-value="(v: string) => (scope = v)"
      />
      <span class="rtn__count mono">{{ shown.length ? t('management.routines.count', { count: shown.length }) : '' }}</span>
      <KBtn variant="primary" @click="openNew">{{ t('management.routines.new') }}</KBtn>
    </div>

    <p v-if="store.loadError" class="rtn__error">{{ t('management.routines.loadError', { error: store.loadError }) }}</p>

    <div v-else-if="!shown.length" class="rtn__blank">
      <span class="rtn__blank-eyebrow mono">{{ t('management.routines.blankEyebrow') }}</span>
      <p class="rtn__blank-text">{{ t('management.routines.blankText') }}</p>
    </div>

    <ol v-else class="rtn__list">
      <li
        v-for="r in shown"
        :key="r.id"
        class="rtn__row"
        :class="{ 'rtn__row--paused': !r.enabled }"
        @click="openId = r.id"
      >
        <div class="rtn__row-main">
          <span class="rtn__row-title">{{ r.name }}</span>
          <span class="rtn__row-meta">
            <KTag>{{ r.projectId ? projectName(r.projectId) : t('management.routines.scopeWorkspace') }}</KTag>
            <KTag>{{ kindLabel(r) }}</KTag>
            <KTag v-if="r.slack">#{{ r.slack.channelName }}</KTag>
            <span class="rtn__row-schedule">{{ describeSchedule(t, r.schedule) }}</span>
          </span>
          <span class="rtn__row-author">{{ t('management.routines.byAuthor', { name: memberName(r.createdBy) }) }}</span>
        </div>
        <div class="rtn__row-side">
          <span class="rtn__row-when mono">{{ nextLabel(r) }}</span>
          <span v-if="lastRun(r)" class="rtn__row-last mono" :class="`rtn__row-last--${lastRun(r)!.status}`">
            {{ t(`management.routines.status.${lastRun(r)!.status}`) }} · {{ renderTime(t, relativeTime(lastRun(r)!.startedAt, now)) }}
          </span>
        </div>
      </li>
    </ol>

    <RoutineEditor
      v-model="editorOpen"
      :workspace-id="workspaceId"
      :routine="editing"
      :default-project-id="scope === ALL || scope === WORKSPACE ? undefined : scope"
    />
    <RoutineDetail
      :routine="opened"
      :workspace-id="workspaceId"
      @close="openId = undefined"
      @edit="openEdit"
      @open-section="goTo"
    />
  </section>
</template>

<script setup lang="ts">
// Routines — the Менеджмент section of scheduled tasks (docs/specs/2026-10-16-routines.md). The
// shell (ManagementPage) renders the heading and the workspace gate; this screen lists the
// workspace's routines, narrowed to the workspace level or one project, and opens the editor and
// the detail with its run history.
//
// The runs themselves happen in the AUTHOR's local api, not here. This window hears about its
// own machine's runs over the socket (`lastRoutineRun`) and refetches; every other member sees
// the same history when they open the screen.
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRouter } from 'vue-router';
import { nextOccurrence } from '@kermanych/core';
import type { WorkspaceRoutine, WorkspaceRoutineRun } from '@kermanych/cloud';
import KSelect, { type KSelectOption } from 'components/kit/KSelect.vue';
import KBtn from 'components/kit/KBtn.vue';
import KTag from 'components/kit/KTag.vue';
import RoutineEditor from 'components/routines/RoutineEditor.vue';
import RoutineDetail from 'components/routines/RoutineDetail.vue';
import { useRoutines } from 'stores/routines';
import { useProjects } from 'stores/projects';
import { useOrchestrator } from 'stores/orchestrator';
import { relativeTime, renderTime } from '../lib/time';
import { describeSchedule, formatInstant } from '../lib/routines';
import { useNow } from '../composables/useNow';

const props = defineProps<{ workspaceId: string; workspaceName: string }>();

const { t, locale } = useI18n();
const router = useRouter();
const store = useRoutines();
const projects = useProjects();
const local = useOrchestrator();
const now = useNow(30_000);

watch(
  () => props.workspaceId,
  (id) => {
    if (!id) return;
    void store.load(id);
    if (!projects.members[id]) void projects.loadMembers(id);
  },
  { immediate: true },
);

// A run of THIS machine started or ended. A finished one-off has switched itself off, so a
// final event reloads the routines too, not only the history.
watch(
  () => local.lastRoutineRun,
  (e) => {
    if (!e || e.workspaceId !== props.workspaceId) return;
    void (e.status === 'running' ? store.loadRuns(props.workspaceId) : store.load(props.workspaceId));
  },
);

// ── scope ─────────────────────────────────────────────────────────────────────

const ALL = 'all';
const WORKSPACE = 'workspace';
const scope = ref<string>(ALL);
const workspaceProjects = computed(() => projects.projects.filter((p) => p.workspaceId === props.workspaceId));

watch(
  () => [props.workspaceId, local.selectedProjectId] as const,
  ([, projectId]) => {
    scope.value = projectId && workspaceProjects.value.some((p) => p.id === projectId) ? projectId : ALL;
  },
  { immediate: true },
);

const scopeOptions = computed<KSelectOption[]>(() => [
  { value: ALL, label: t('management.routines.scopeAll') },
  { value: WORKSPACE, label: t('management.routines.scopeWorkspace') },
  ...workspaceProjects.value.map((p) => ({ value: p.id, label: p.name })),
]);

const routines = computed<WorkspaceRoutine[]>(() => store.byWorkspace[props.workspaceId] ?? []);
const shown = computed(() =>
  routines.value.filter((r) => (scope.value === ALL ? true : scope.value === WORKSPACE ? !r.projectId : r.projectId === scope.value)),
);

// ── rows ──────────────────────────────────────────────────────────────────────

function projectName(id: string): string {
  return projects.projects.find((p) => p.id === id)?.name ?? id;
}

function memberName(id: string | undefined): string {
  if (!id) return '—';
  const m = (projects.members[props.workspaceId] ?? []).find((x) => x.userId === id);
  return m?.profile?.displayName ?? m?.profile?.githubUsername ?? id;
}

function kindLabel(r: WorkspaceRoutine): string {
  if (r.action.kind === 'release_notes') return t('management.routines.kind.release_notes');
  return r.projectId ? t('management.routines.kind.promptProject') : t('management.routines.kind.promptWorkspace');
}

function nextLabel(r: WorkspaceRoutine): string {
  if (!r.enabled) return t('management.routines.paused');
  const at = nextOccurrence(r.schedule, r.timezone, now.value);
  return at === undefined ? t('management.routines.noNextRun') : t('management.routines.nextRun', { when: formatInstant(at, r.timezone, locale.value) });
}

// The history is newest first, so the first run of a routine is its latest.
function lastRun(r: WorkspaceRoutine): WorkspaceRoutineRun | undefined {
  return (store.runs[props.workspaceId] ?? []).find((run) => run.routineId === r.id);
}

// ── editor and detail ─────────────────────────────────────────────────────────

const editorOpen = ref(false);
const editing = ref<WorkspaceRoutine | undefined>(undefined);
const openId = ref<string | undefined>(undefined);
// Read through the store so a pause, an edit or a finished run shows in the open detail at once.
const opened = computed(() => routines.value.find((r) => r.id === openId.value));

function openNew(): void {
  editing.value = undefined;
  editorOpen.value = true;
}

function openEdit(r: WorkspaceRoutine): void {
  openId.value = undefined;
  editing.value = r;
  editorOpen.value = true;
}

function goTo(name: string): void {
  openId.value = undefined;
  void router.push({ name });
}
</script>

<style scoped lang="scss">
.rtn {
  display: flex;
  flex-direction: column;
  gap: var(--k-sp-4);
  width: 100%;
  max-width: 960px;
  padding: var(--k-sp-3) 0;
}

.rtn__lead {
  margin: 0;
  font-family: var(--k-font-ui);
  font-size: var(--k-fs-base);
  line-height: 1.5;
  color: var(--k-muted);
}

.rtn__lead-workspace {
  color: var(--k-text);
}

.rtn__toolbar {
  display: flex;
  align-items: center;
  gap: var(--k-sp-3);
}

.rtn__scope {
  width: 240px;
}

.rtn__count {
  margin-right: auto;
  font-size: var(--k-fs-xs);
  color: var(--k-faint);
}

.rtn__error {
  margin: 0;
  font-size: var(--k-fs-sm);
  color: var(--k-danger);
}

.rtn__blank {
  display: flex;
  flex-direction: column;
  gap: var(--k-sp-2);
  padding: var(--k-sp-5) var(--k-sp-4);
  border: var(--k-rule-thin) dashed var(--k-line);
  border-radius: var(--k-r-lg);
}

.rtn__blank-eyebrow {
  font-size: 10px;
  letter-spacing: 0.12em;
  color: var(--k-faint);
}

.rtn__blank-text {
  margin: 0;
  max-width: 600px;
  font-size: var(--k-fs-sm);
  line-height: 1.55;
  color: var(--k-muted);
}

.rtn__list {
  display: flex;
  flex-direction: column;
  gap: var(--k-sp-2);
  margin: 0;
  padding: 0;
  list-style: none;
}

.rtn__row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--k-sp-3);
  padding: var(--k-sp-3);
  background: color-mix(in srgb, var(--k-surface2) 40%, transparent);
  border: var(--k-rule-thin) solid var(--k-line);
  border-radius: var(--k-r-lg);
  cursor: pointer;
  transition: border-color 120ms ease;

  &:hover {
    border-color: color-mix(in srgb, var(--k-accent) 45%, var(--k-line));
  }
}

// A paused routine is still listed — it keeps its history — but reads as set aside.
.rtn__row--paused {
  border-style: dashed;

  .rtn__row-title {
    color: var(--k-muted);
  }
}

.rtn__row-main {
  display: flex;
  flex-direction: column;
  gap: var(--k-sp-1);
  min-width: 0;
}

.rtn__row-title {
  font-family: var(--k-font-ui);
  font-size: var(--k-fs-base);
  font-weight: 650;
  color: var(--k-text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.rtn__row-meta {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--k-sp-1);
}

.rtn__row-schedule,
.rtn__row-author {
  font-size: var(--k-fs-xs);
  color: var(--k-muted);
}

.rtn__row-author {
  color: var(--k-faint);
}

.rtn__row-side {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: var(--k-sp-1);
  flex-shrink: 0;
}

.rtn__row-when {
  font-size: var(--k-fs-xs);
  color: var(--k-muted);
}

.rtn__row-last {
  font-size: var(--k-fs-xs);
  color: var(--k-faint);
}

.rtn__row-last--failed {
  color: var(--k-danger);
}

.rtn__row-last--running {
  color: var(--k-accent);
}
</style>
