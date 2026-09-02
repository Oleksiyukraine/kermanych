<template>
  <div class="jbv">
    <div class="jbv__bar">
      <span class="jbv__count mono">{{ jira.issues.length }} тікетів · {{ jira.integration?.boardName ?? '' }}</span>
      <span v-if="jira.syncing" class="jbv__sync mono">синхронізація…</span>
      <span class="jbv__spacer"></span>
      <span v-if="!jira.tokenPresent" class="jbv__readonly mono" v-tip="READ_ONLY_HINT">лише читання</span>
      <KBtn variant="primary" :disabled="!jira.tokenPresent" :title="jira.tokenPresent ? '' : READ_ONLY_HINT" @click="creatorOpen = true">
        + Тікет
      </KBtn>
    </div>

    <p v-if="jira.loadError" class="jbv__error mono">{{ jira.loadError }}</p>

    <div v-if="jira.columns.length" class="jbv__columns" :style="{ '--cols': jira.columns.length }">
      <div
        v-for="col in jira.columns"
        :key="col.position"
        class="jbv__column"
        :class="{ 'jbv__column--over': dragOver === col.position }"
        @dragover.prevent="dragOver = col.position"
        @dragleave="dragOver = dragOver === col.position ? null : dragOver"
        @drop.prevent="onDrop(col)"
      >
        <KKanbanColumn :label="col.name" :count="grouped[col.position]?.length ?? 0">
          <JiraCard
            v-for="issue in grouped[col.position]"
            :key="issue.issueId"
            :issue="issue"
            :agent-status="agentStatusOf(issue)"
            :draggable="jira.tokenPresent"
            @click="openIssue(issue)"
            @dragstart="dragged = issue"
          />
          <p v-if="!grouped[col.position]?.length" class="jbv__column-empty mono">—</p>
        </KKanbanColumn>
      </div>
    </div>

    <p v-else-if="!jira.loading" class="jbv__error mono">
      Дошка ще порожня — колонки зʼявляться після першої синхронізації.
    </p>

    <!-- TICKET DETAIL — mounted only with a subject, so `issue` is always real inside. -->
    <JiraTicketDialog
      v-if="openedIssue"
      v-model="dialogOpen"
      :issue="openedIssue"
      :workspace-id="workspaceId"
      @launch="launchOpen = true"
      @edit="editorOpen = true"
      @subtask="subtaskOpen = true"
      @open-issue="openByKey"
    />

    <JiraLaunchDialog
      v-if="openedIssue"
      v-model="launchOpen"
      :issue="openedIssue"
      :workspace-id="workspaceId"
      @launched="onLaunched"
    />

    <JiraIssueEditor
      v-if="openedIssue"
      v-model="editorOpen"
      :workspace-id="workspaceId"
      :issue="openedIssue"
      @saved="jira.upsert"
    />

    <JiraIssueEditor
      v-if="openedIssue"
      v-model="subtaskOpen"
      :workspace-id="workspaceId"
      :parent-key="openedIssue.key"
      @saved="jira.upsert"
    />

    <JiraIssueEditor v-model="creatorOpen" :workspace-id="workspaceId" @saved="jira.upsert" />

    <JiraStatusPickDialog
      v-model="dropPickOpen"
      :title="dropIssue ? `${dropIssue.key} → ${dropColumn?.name ?? ''}` : ''"
      lead="У цій колонці кілька статусів — у який перенести?"
      :options="dropOptions"
      :busy="dropBusy"
      @pick="applyDrop"
    />
  </div>
</template>

<script setup lang="ts">
// «Дошка → Jira»: the mirrored board, columns verbatim from jira_columns, cards grouped
// by Jira's own status→column mapping (lib/jira-view.ts). Drag is the transition surface:
// optimistic nothing — the card moves only when Jira says yes, because Jira is the source
// of truth and a snap-back after a fake move reads as breakage.
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import type { JiraColumn, JiraIssue } from '@kermanych/cloud';
import type { Session, SessionStatus } from '@kermanych/core';
import KBtn from 'components/kit/KBtn.vue';
import KKanbanColumn from 'components/kit/KKanbanColumn.vue';
import JiraCard from './JiraCard.vue';
import JiraIssueEditor from './JiraIssueEditor.vue';
import JiraLaunchDialog from './JiraLaunchDialog.vue';
import JiraStatusPickDialog from './JiraStatusPickDialog.vue';
import JiraTicketDialog from './JiraTicketDialog.vue';
import { api } from '../../lib/api';
import { issuesByColumn, transitionChoiceForDrop, type JiraTransitionView } from '../../lib/jira-view';
import { useBoard } from 'stores/board';
import { useJira } from 'stores/jira';
import { useOrchestrator } from 'stores/orchestrator';

const READ_ONLY_HINT = 'Додайте свій Jira-токен у Менеджмент → Integrations, щоб діяти';

const props = defineProps<{ workspaceId: string }>();

const jira = useJira();
const board = useBoard();
const local = useOrchestrator();

const grouped = computed(() => issuesByColumn(jira.columns, jira.issues));

// ── detail / editors ──────────────────────────────────────────────────────────
const openedIssueId = ref<string | null>(null);
const dialogOpen = ref(false);
const launchOpen = ref(false);
const editorOpen = ref(false);
const subtaskOpen = ref(false);
const creatorOpen = ref(false);

// Resolved from the store, not a snapshot: a realtime upsert while the dialog is open
// must update the open dialog too.
const openedIssue = computed(() => jira.issues.find((i) => i.issueId === openedIssueId.value));

function openIssue(issue: JiraIssue): void {
  openedIssueId.value = issue.issueId;
  dialogOpen.value = true;
}

function openByKey(key: string): void {
  const hit = jira.issues.find((i) => i.key === key);
  if (hit) openIssue(hit);
}

// The agent chip: the shadow task's live status off the SHARED board store (realtime
// already feeds it), so the Jira card and the native card can never disagree.
function agentStatusOf(issue: JiraIssue): SessionStatus | undefined {
  if (!issue.taskId) return undefined;
  return board.tasks.find((t) => t.id === issue.taskId)?.status;
}

function onLaunched(session: Session, transitionError?: string): void {
  local.notify(`Сесію «${session.name}» запущено`, 'info');
  if (transitionError) {
    local.notify(`Сесія працює, але перенести тікет не вдалося: ${transitionError}`, 'error');
  }
  void jira.refreshIssue(props.workspaceId, openedIssue.value?.key ?? '');
}

// ── drag → transition ─────────────────────────────────────────────────────────
const dragged = ref<JiraIssue | null>(null);
const dragOver = ref<number | null>(null);
const dropPickOpen = ref(false);
const dropIssue = ref<JiraIssue | null>(null);
const dropColumn = ref<JiraColumn | null>(null);
const dropOptions = ref<JiraTransitionView[]>([]);
const dropBusy = ref(false);

async function onDrop(column: JiraColumn): Promise<void> {
  dragOver.value = null;
  const issue = dragged.value;
  dragged.value = null;
  if (!issue || !jira.tokenPresent) return;
  if (column.statusIds.includes(issue.statusId)) return; // dropped where it already is

  let transitions: JiraTransitionView[];
  try {
    transitions = await api.jiraTransitions(props.workspaceId, issue.key);
  } catch (e) {
    local.notify(e instanceof Error ? e.message : String(e), 'error');
    return;
  }

  const decision = transitionChoiceForDrop(column, transitions);
  if (decision.kind === 'none') {
    local.notify(`Jira не дозволяє перенести ${issue.key} у «${column.name}» звідси`, 'error');
    return;
  }
  if (decision.kind === 'auto') {
    await transitionIssue(issue, decision.transition.id);
    return;
  }
  dropIssue.value = issue;
  dropColumn.value = column;
  dropOptions.value = decision.options;
  dropPickOpen.value = true;
}

async function applyDrop(t: JiraTransitionView): Promise<void> {
  const issue = dropIssue.value;
  if (!issue) return;
  dropBusy.value = true;
  await transitionIssue(issue, t.id);
  dropBusy.value = false;
  dropPickOpen.value = false;
}

async function transitionIssue(issue: JiraIssue, transitionId: string): Promise<void> {
  try {
    const updated = await api.jiraTransition(props.workspaceId, issue.key, transitionId);
    jira.upsert(updated);
  } catch (e) {
    // The stale-mirror case: Jira refused because the ticket moved meanwhile. Refresh the
    // one issue so the board shows where it actually is.
    local.notify(e instanceof Error ? e.message : String(e), 'error');
    void jira.refreshIssue(props.workspaceId, issue.key);
  }
}

// ── lifecycle ─────────────────────────────────────────────────────────────────
onMounted(() => {
  void jira.open(props.workspaceId);
});
watch(
  () => props.workspaceId,
  (id) => {
    void jira.open(id);
  },
);
onUnmounted(() => {
  jira.close();
});
</script>

<style scoped lang="scss">
.jbv {
  display: flex;
  flex-direction: column;
  gap: 12px;
  flex: 1;
  min-height: 0;
}

.jbv__bar {
  display: flex;
  align-items: center;
  gap: var(--k-sp-3);
}

.jbv__count,
.jbv__sync {
  font-size: var(--k-fs-xs);
  color: var(--k-faint);
}

.jbv__spacer {
  flex: 1;
}

.jbv__readonly {
  font-size: var(--k-fs-xs);
  color: var(--k-warning);
}

.jbv__error {
  margin: 0;
  font-size: var(--k-fs-sm);
  color: var(--k-muted);
}

.jbv__columns {
  display: grid;
  grid-template-columns: repeat(var(--cols), minmax(220px, 1fr));
  grid-auto-rows: 1fr;
  gap: var(--k-sp-4);
  flex: 1;
  min-height: 0;
  overflow-x: auto;
}

// The Дошка parity fix: the wrapper div exists only for the drag handlers, but as a
// plain block it let .k-kanban-col shrink to its content — the column background (which
// KKanbanColumn owns) stopped right under the last card. Flex + flex:1 stretches the
// column to the full grid row, exactly how the native board's direct grid child behaves.
.jbv__column {
  display: flex;
  flex-direction: column;
  min-height: 0;
  border-radius: var(--k-r-lg);
  transition: outline-color 0.12s ease;
  outline: 2px solid transparent;

  :deep(.k-kanban-col) {
    flex: 1;
  }

  &--over {
    outline-color: var(--k-line-strong);
  }
}

.jbv__column-empty {
  padding: var(--k-sp-3);
  font-size: 11px;
  color: var(--k-muted);
}
</style>
