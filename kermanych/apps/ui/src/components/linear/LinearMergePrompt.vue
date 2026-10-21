<template>
  <LinearStatusPickDialog
    :model-value="!!current"
    :title="current ? t('linear.mergePrompt.title', { key: current.linearKey }) : ''"
    :lead="t('linear.mergePrompt.lead')"
    :options="options"
    :busy="busy"
    :loading="loadingOptions"
    skippable
    @update:model-value="onToggle"
    @pick="apply"
  />
</template>

<script setup lang="ts">
// The merge half of the launch agreement: when a shadow task (tasks.linear_key) reaches
// `merged` ON THIS MACHINE, its developer is asked where the Linear ticket goes next.
// Mounted in MainLayout, not BoardPage — the merge lands wherever the user happens to
// be, and a prompt that only fires on one page would be a coin toss.
//
// «This machine» is the sessions test: only the machine that ran the task has a local
// session bound to it, so a teammate watching the same board is never prompted.
import { computed, ref, watch } from 'vue';
import type { Task } from '@kermanych/cloud';
import LinearStatusPickDialog from './LinearStatusPickDialog.vue';
import { api } from '../../lib/api';
import type { LinearTransitionView } from '../../lib/linear-view';
import { useAsyncAction } from '../../composables/useAsyncAction';
import { useBoard } from 'stores/board';
import { useOrchestrator } from 'stores/orchestrator';
import { useI18n } from 'vue-i18n';

const board = useBoard();
const local = useOrchestrator();
const { t } = useI18n();

// One prompt at a time; later merges queue behind it.
const queue = ref<Task[]>([]);
const options = ref<LinearTransitionView[]>([]);
// The current prompt's transitions are still being asked for: the dialog shows skeleton
// options, not «no transitions».
const loadingOptions = ref(false);

const current = computed(() => queue.value[0]);

// Edge detection over the shared board store: prior status per task id, the
// CloudSyncService.lastPushed idiom — act on transitions, never on repeats.
const prior = new Map<string, string>();

watch(
  () => board.tasks,
  (tasks) => {
    for (const t of tasks) {
      const was = prior.get(t.id);
      prior.set(t.id, t.status);
      if (!t.linearKey || t.status !== 'merged' || was === 'merged' || was === undefined) continue;
      if (!local.sessions.some((s) => s.taskId === t.id)) continue;
      if (queue.value.some((q) => q.id === t.id)) continue;
      queue.value = [...queue.value, t];
    }
  },
  { deep: true },
);

// Transitions are fetched when a prompt surfaces — they are per-issue per-moment.
watch(current, async (task) => {
  options.value = [];
  loadingOptions.value = false;
  if (!task?.linearKey) return;
  const ws = local.projectWorkspace[task.projectId];
  if (!ws) {
    queue.value = queue.value.slice(1);
    return;
  }
  loadingOptions.value = true;
  try {
    const answer = await api.linearTransitions(ws, task.linearKey);
    if (current.value !== task) return; // the queue moved on meanwhile
    options.value = answer;
    loadingOptions.value = false;
  } catch {
    if (current.value !== task) return;
    loadingOptions.value = false;
    // No token or no reach: the ask cannot be honoured, and a dialog with zero options
    // would blame the workflow. Drop silently.
    queue.value = queue.value.slice(1);
  }
});

function onToggle(open: boolean): void {
  if (!open && !busy.value) queue.value = queue.value.slice(1); // «Не переносити»
}

// The prompt is dequeued whatever Linear answers — the failure is a toast, and a retry
// would need a fresh transitions read anyway.
const { run: apply, busy } = useAsyncAction(async (transition: LinearTransitionView) => {
  const task = current.value;
  if (!task?.linearKey) return;
  const ws = local.projectWorkspace[task.projectId];
  if (!ws) return;
  try {
    await api.linearTransition(ws, task.linearKey, transition.id);
    local.notify(t('linear.mergePrompt.moved', { key: task.linearKey, name: transition.to.name }), 'info');
  } finally {
    queue.value = queue.value.slice(1);
  }
});
</script>
