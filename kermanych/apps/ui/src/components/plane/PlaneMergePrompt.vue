<template>
  <PlaneStatusPickDialog
    :model-value="!!current"
    :title="current ? t('plane.mergePrompt.title', { key: current.planeKey }) : ''"
    :lead="t('plane.mergePrompt.lead')"
    :options="options"
    :busy="busy"
    :loading="loadingOptions"
    skippable
    @update:model-value="onToggle"
    @pick="apply"
  />
</template>

<script setup lang="ts">
// The merge half of the launch agreement: when a shadow task (tasks.plane_key) reaches
// `merged` ON THIS MACHINE, its developer is asked which Plane state the work item goes to
// next. Mounted in MainLayout, not BoardPage — the merge lands wherever the user happens to
// be, and a prompt that only fires on one page would be a coin toss.
//
// «This machine» is the sessions test: only the machine that ran the task has a local
// session bound to it, so a teammate watching the same board is never prompted.
import { computed, ref, watch } from 'vue';
import type { Task } from '@kermanych/cloud';
import { listPlaneIntegrations } from '@kermanych/cloud';
import PlaneStatusPickDialog from './PlaneStatusPickDialog.vue';
import { api } from '../../lib/api';
import { integrationForKey, type PlaneTransitionView } from '../../lib/plane-view';
import { useAsyncAction } from '../../composables/useAsyncAction';
import { useAuth } from 'stores/auth';
import { useBoard } from 'stores/board';
import { useOrchestrator } from 'stores/orchestrator';
import { useI18n } from 'vue-i18n';

const auth = useAuth();
const board = useBoard();
const local = useOrchestrator();
const { t } = useI18n();

// One prompt at a time; later merges queue behind it.
const queue = ref<Task[]>([]);
const options = ref<PlaneTransitionView[]>([]);
// The current prompt's states are still being asked for: the dialog shows skeleton options,
// not «Plane не пропонує станів».
const loadingOptions = ref(false);
// The project the current work item belongs to, resolved from its key's identifier — a
// workspace may mirror several projects, and «WEB-42» belongs to whichever integration has
// the identifier «WEB». Null while unresolved (no match = nothing to move).
const integrationId = ref<string | null>(null);

const current = computed(() => queue.value[0]);

// Edge detection over the shared board store: prior status per task id, the
// CloudSyncService.lastPushed idiom — act on transitions, never on repeats. Shallow on
// purpose (the Jira prompt's reason: every board write replaces the `tasks` array).
const prior = new Map<string, string>();

watch(
  () => board.tasks,
  (tasks) => {
    for (const task of tasks) {
      const was = prior.get(task.id);
      prior.set(task.id, task.status);
      if (!task.planeKey || task.status !== 'merged' || was === 'merged' || was === undefined) continue;
      if (!local.sessions.some((s) => s.taskId === task.id)) continue;
      if (queue.value.some((q) => q.id === task.id)) continue;
      queue.value = [...queue.value, task];
    }
  },
);

async function resolveIntegration(ws: string, planeKey: string): Promise<string | undefined> {
  try {
    return integrationForKey(await listPlaneIntegrations(auth.client, ws), planeKey)?.id;
  } catch {
    return undefined;
  }
}

// States are fetched when a prompt surfaces — they are per-item per-moment.
watch(current, async (task) => {
  options.value = [];
  integrationId.value = null;
  loadingOptions.value = false;
  if (!task?.planeKey) return;
  const ws = local.projectWorkspace[task.projectId];
  if (!ws) {
    queue.value = queue.value.slice(1);
    return;
  }
  loadingOptions.value = true;
  const intg = await resolveIntegration(ws, task.planeKey);
  if (current.value !== task) return; // the queue moved on meanwhile
  if (!intg) {
    loadingOptions.value = false;
    queue.value = queue.value.slice(1);
    return;
  }
  integrationId.value = intg;
  try {
    const answer = await api.planeTransitions(intg, task.planeKey);
    if (current.value !== task) return;
    options.value = answer;
    loadingOptions.value = false;
  } catch {
    if (current.value !== task) return;
    loadingOptions.value = false;
    // No token or no reach: the ask cannot be honoured, and an empty dialog would blame
    // the project. Drop silently.
    queue.value = queue.value.slice(1);
  }
});

function onToggle(open: boolean): void {
  if (!open && !busy.value) queue.value = queue.value.slice(1); // «Не переносити»
}

// The prompt is dequeued whatever Plane answers — the failure is a toast, and a retry would
// need a fresh states read anyway.
const { run: apply, busy } = useAsyncAction(async (transition: PlaneTransitionView) => {
  const task = current.value;
  const intg = integrationId.value;
  if (!task?.planeKey || !intg) return;
  try {
    await api.planeTransition(intg, task.planeKey, transition.id);
    local.notify(t('plane.mergePrompt.moved', { key: task.planeKey, name: transition.to.name }), 'info');
  } finally {
    queue.value = queue.value.slice(1);
  }
});
</script>
