<template>
  <JiraStatusPickDialog
    :model-value="!!current"
    :title="current ? t('jira.mergePrompt.title', { key: current.jiraKey }) : ''"
    :lead="t('jira.mergePrompt.lead')"
    :options="options"
    :busy="busy"
    skippable
    @update:model-value="onToggle"
    @pick="apply"
  />
</template>

<script setup lang="ts">
// The merge half of the launch agreement: when a shadow task (tasks.jira_key) reaches
// `merged` ON THIS MACHINE, its developer is asked where the Jira ticket goes next.
// Mounted in MainLayout, not BoardPage — the merge lands wherever the user happens to
// be, and a prompt that only fires on one page would be a coin toss.
//
// «This machine» is the sessions test: only the machine that ran the task has a local
// session bound to it, so a teammate watching the same board is never prompted.
import { computed, ref, watch } from 'vue';
import type { Task } from '@kermanych/cloud';
import { listJiraIntegrations } from '@kermanych/cloud';
import JiraStatusPickDialog from './JiraStatusPickDialog.vue';
import { api } from '../../lib/api';
import type { JiraTransitionView } from '../../lib/jira-view';
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
const options = ref<JiraTransitionView[]>([]);
const busy = ref(false);
// The board the current ticket belongs to, resolved from its key's project prefix — a
// workspace may mirror several boards, and «KAN-42» belongs to whichever integration has
// project key «KAN». Null while unresolved (no matching board = nothing to move).
const integrationId = ref<string | null>(null);

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
      if (!t.jiraKey || t.status !== 'merged' || was === 'merged' || was === undefined) continue;
      if (!local.sessions.some((s) => s.taskId === t.id)) continue;
      if (queue.value.some((q) => q.id === t.id)) continue;
      queue.value = [...queue.value, t];
    }
  },
  { deep: true },
);

// The workspace's board whose project key prefixes this ticket key. No match = the mirror
// no longer carries that board, so there is nothing to transition.
async function resolveIntegration(ws: string, jiraKey: string): Promise<string | undefined> {
  const prefix = jiraKey.split('-')[0];
  try {
    const boards = await listJiraIntegrations(auth.client, ws);
    return boards.find((b) => b.projectKey === prefix)?.id;
  } catch {
    return undefined;
  }
}

// Transitions are fetched when a prompt surfaces — they are per-issue per-moment.
watch(current, async (task) => {
  options.value = [];
  integrationId.value = null;
  if (!task?.jiraKey) return;
  const ws = local.projectWorkspace[task.projectId];
  if (!ws) {
    queue.value = queue.value.slice(1);
    return;
  }
  const intg = await resolveIntegration(ws, task.jiraKey);
  if (!intg) {
    queue.value = queue.value.slice(1);
    return;
  }
  integrationId.value = intg;
  try {
    options.value = await api.jiraTransitions(intg, task.jiraKey);
  } catch {
    // No token or no reach: the ask cannot be honoured, and a dialog with zero options
    // saying «Jira не пропонує переходів» would blame the workflow. Drop silently.
    queue.value = queue.value.slice(1);
  }
});

function onToggle(open: boolean): void {
  if (!open) queue.value = queue.value.slice(1); // «Не переносити»
}

async function apply(transition: JiraTransitionView): Promise<void> {
  const task = current.value;
  const intg = integrationId.value;
  if (!task?.jiraKey || !intg) return;
  busy.value = true;
  try {
    await api.jiraTransition(intg, task.jiraKey, transition.id);
    local.notify(t('jira.mergePrompt.moved', { key: task.jiraKey, name: transition.to.name }), 'info');
  } catch (e) {
    local.notify(e instanceof Error ? e.message : String(e), 'error');
  } finally {
    busy.value = false;
    queue.value = queue.value.slice(1);
  }
}
</script>
