<template>
  <div class="lbv">
    <div class="lbv__bar">
      <KField
        v-model="query"
        class="lbv__search"
        type="search"
        :placeholder="t('linear.boardView.searchPlaceholder')"
      />
      <KChipSelect
        :model-value="assignee"
        :options="assigneeChoices"
        icon="👤"
        placement="down"
        :title="t('linear.boardView.assigneeTitle')"
        @update:model-value="assignee = $event"
      />
      <span v-if="filtering" class="lbv__count mono">{{ t('linear.boardView.searchCount', { n: matched.length, total: linear.issues.length, board: boardName }) }}</span>
      <span v-else class="lbv__count mono">{{ t('linear.boardView.count', { n: linear.issues.length, board: boardName }, linear.issues.length) }}</span>
      <span class="lbv__spacer"></span>
      <span v-if="!linear.tokenPresent" class="lbv__readonly mono" v-tip="readOnlyHint">{{ t('linear.boardView.readOnly') }}</span>
      <KBtn
        :disabled="!linear.tokenPresent || linear.syncing"
        :title="linear.tokenPresent ? syncHint : readOnlyHint"
        @click="linear.syncNow(workspaceId)"
      >
        {{ linear.syncing ? t('linear.boardView.syncing') : t('linear.boardView.sync') }}
      </KBtn>
      <KBtn variant="primary" :disabled="!linear.tokenPresent" :title="linear.tokenPresent ? '' : readOnlyHint" @click="creatorOpen = true">
        {{ t('linear.boardView.newTicket') }}
      </KBtn>
    </div>

    <p v-if="linear.loadError" class="lbv__error mono">{{ linear.loadError }}</p>

    <!-- The empty line names the filter the user can actually see: with something typed, the
         query it failed to match; with only the assignee chip narrowing, the query is blank. -->
    <p v-else-if="filtering && !matched.length && linear.columns.length" class="lbv__error mono">
      {{ query.trim() ? t('linear.boardView.searchEmpty', { q: query.trim() }) : t('linear.boardView.filterEmpty') }}
    </p>

    <div v-if="linear.columns.length" class="lbv__columns" :style="{ '--cols': linear.columns.length }">
      <div
        v-for="col in linear.columns"
        :key="col.position"
        class="lbv__column"
        :class="{ 'lbv__column--over': dragOver === col.position }"
        @dragover.prevent="dragOver = col.position"
        @dragleave="dragOver = dragOver === col.position ? null : dragOver"
        @drop.prevent="onDrop(col)"
      >
        <KKanbanColumn :label="col.name" :count="grouped[col.position]?.length ?? 0">
          <LinearCard
            v-for="issue in grouped[col.position]"
            :key="issue.issueId"
            :issue="issue"
            :agent-status="agentStatusOf(issue)"
            :draggable="linear.tokenPresent"
            @click="openIssue(issue)"
            @dragstart="dragged = issue"
          />
          <p v-if="!grouped[col.position]?.length" class="lbv__column-empty mono">—</p>
        </KKanbanColumn>
      </div>
    </div>

    <p v-else-if="!linear.loading" class="lbv__error mono">
      {{ t('linear.boardView.emptyBoard') }}
    </p>

    <!-- TICKET DETAIL — mounted only with a subject, so `issue` is always real inside. -->
    <LinearTicketDialog
      v-if="openedIssue"
      v-model="dialogOpen"
      :issue="openedIssue"
      :workspace-id="workspaceId"
      @launch="launchOpen = true"
      @edit="editorOpen = true"
      @subtask="subtaskOpen = true"
      @open-issue="openByKey"
    />

    <LinearLaunchDialog
      v-if="openedIssue"
      v-model="launchOpen"
      :issue="openedIssue"
      :workspace-id="workspaceId"
      @launched="onLaunched"
    />

    <LinearIssueEditor
      v-if="openedIssue"
      v-model="editorOpen"
      :workspace-id="workspaceId"
      :issue="openedIssue"
      @saved="linear.upsert"
    />

    <LinearIssueEditor
      v-if="openedIssue"
      v-model="subtaskOpen"
      :workspace-id="workspaceId"
      :parent-key="openedIssue.key"
      @saved="linear.upsert"
    />

    <LinearIssueEditor v-model="creatorOpen" :workspace-id="workspaceId" @saved="linear.upsert" />

    <LinearStatusPickDialog
      v-model="dropPickOpen"
      :title="dropIssue ? `${dropIssue.key} → ${dropColumn?.name ?? ''}` : ''"
      :lead="t('linear.boardView.dropLead')"
      :options="dropOptions"
      :busy="dropBusy"
      @pick="applyDrop"
    />
  </div>
</template>

<script setup lang="ts">
// «Дошка → Linear»: the mirrored board, columns verbatim from linear_columns, cards
// grouped by Linear's own state→column mapping (lib/linear-view.ts). Drag is the
// transition surface: optimistic nothing — the card moves only when Linear says yes,
// because Linear is the source of truth and a snap-back after a fake move reads as breakage.
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import type { LinearColumn, LinearIssue } from '@kermanych/cloud';
import type { Session, SessionStatus } from '@kermanych/core';
import KBtn from 'components/kit/KBtn.vue';
import KChipSelect from 'components/kit/KChipSelect.vue';
import KField from 'components/kit/KField.vue';
import KKanbanColumn from 'components/kit/KKanbanColumn.vue';
import LinearCard from './LinearCard.vue';
import LinearIssueEditor from './LinearIssueEditor.vue';
import LinearLaunchDialog from './LinearLaunchDialog.vue';
import LinearStatusPickDialog from './LinearStatusPickDialog.vue';
import LinearTicketDialog from './LinearTicketDialog.vue';
import { api } from '../../lib/api';
import {
  assigneeOptions,
  filterByAssignee,
  filterIssues,
  issuesByColumn,
  transitionChoiceForDrop,
  UNASSIGNED,
  type LinearTransitionView,
} from '../../lib/linear-view';
import { useBoard } from 'stores/board';
import { useLinear } from 'stores/linear';
import { useOrchestrator } from 'stores/orchestrator';
import { useI18n } from 'vue-i18n';

const { t } = useI18n();
const readOnlyHint = computed(() => t('linear.boardView.readOnlyHint'));
const syncHint = computed(() => t('linear.boardView.syncHint'));

const props = defineProps<{ workspaceId: string }>();

const linear = useLinear();
const board = useBoard();
const local = useOrchestrator();

// The search box filters the cards, never the columns: an empty column under a query
// still says which column it is, so the board keeps its shape while you type.
const query = ref('');
// The assignee chip: '' is «anyone» and the board's resting state. Deliberately NOT
// persisted, exactly like `query`.
const assignee = ref('');
// The team name stays in the bar while filtering too — it says WHICH board you are
// searching, and losing it mid-search reads as the board having changed.
const boardName = computed(() => linear.integration?.teamName ?? '');

// «Anyone» and «Unassigned» lead, then the people actually holding cards. The two standing
// rows come from i18n, so they sort with the list rather than into it.
const assigneeChoices = computed(() => [
  { value: '', label: t('linear.boardView.assigneeAll') },
  { value: UNASSIGNED, label: t('linear.boardView.assigneeNone') },
  ...assigneeOptions(linear.issues).map((o) => ({ value: o.id, label: o.name })),
]);

// Both narrowings, one after the other: the search box over the assignee's cards.
const matched = computed(() => filterByAssignee(filterIssues(linear.issues, query.value), assignee.value));
const filtering = computed(() => query.value.trim() !== '' || assignee.value !== '');
const grouped = computed(() => issuesByColumn(linear.columns, matched.value));

// A sync (or a reassignment in Linear) can retire the very person the chip is filtering by,
// which would leave the board empty with no cards to explain why. Falling back to «anyone»
// keeps the board readable; «Unassigned» is always a valid choice, so it never expires.
watch(assigneeChoices, (choices) => {
  if (assignee.value && !choices.some((c) => c.value === assignee.value)) assignee.value = '';
});

// ── detail / editors ──────────────────────────────────────────────────────────
const openedIssueId = ref<string | null>(null);
const dialogOpen = ref(false);
const launchOpen = ref(false);
const editorOpen = ref(false);
const subtaskOpen = ref(false);
const creatorOpen = ref(false);

// Resolved from the store, not a snapshot: a realtime upsert while the dialog is open
// must update the open dialog too.
const openedIssue = computed(() => linear.issues.find((i) => i.issueId === openedIssueId.value));

function openIssue(issue: LinearIssue): void {
  openedIssueId.value = issue.issueId;
  dialogOpen.value = true;
}

function openByKey(key: string): void {
  const hit = linear.issues.find((i) => i.key === key);
  if (hit) openIssue(hit);
}

// The agent chip: the shadow task's live status off the SHARED board store (realtime
// already feeds it), so the Linear card and the native card can never disagree.
function agentStatusOf(issue: LinearIssue): SessionStatus | undefined {
  if (!issue.taskId) return undefined;
  return board.tasks.find((t) => t.id === issue.taskId)?.status;
}

function onLaunched(session: Session, transitionError?: string): void {
  local.notify(t('linear.boardView.sessionLaunched', { name: session.name }), 'info');
  if (transitionError) {
    local.notify(t('linear.boardView.transitionFailedAfterLaunch', { error: transitionError }), 'error');
  }
  void linear.refreshIssue(props.workspaceId, openedIssue.value?.key ?? '');
}

// ── drag → transition ─────────────────────────────────────────────────────────
const dragged = ref<LinearIssue | null>(null);
const dragOver = ref<number | null>(null);
const dropPickOpen = ref(false);
const dropIssue = ref<LinearIssue | null>(null);
const dropColumn = ref<LinearColumn | null>(null);
const dropOptions = ref<LinearTransitionView[]>([]);
const dropBusy = ref(false);

async function onDrop(column: LinearColumn): Promise<void> {
  dragOver.value = null;
  const issue = dragged.value;
  dragged.value = null;
  if (!issue || !linear.tokenPresent) return;
  if (column.stateIds.includes(issue.stateId)) return; // dropped where it already is

  let transitions: LinearTransitionView[];
  try {
    transitions = await api.linearTransitions(props.workspaceId, issue.key);
  } catch (e) {
    local.notify(e instanceof Error ? e.message : String(e), 'error');
    return;
  }

  const decision = transitionChoiceForDrop(column, transitions);
  if (decision.kind === 'none') {
    local.notify(t('linear.boardView.dropRefused', { key: issue.key, column: column.name }), 'error');
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

async function applyDrop(tr: LinearTransitionView): Promise<void> {
  const issue = dropIssue.value;
  if (!issue) return;
  dropBusy.value = true;
  await transitionIssue(issue, tr.id);
  dropBusy.value = false;
  dropPickOpen.value = false;
}

async function transitionIssue(issue: LinearIssue, transitionId: string): Promise<void> {
  try {
    const updated = await api.linearTransition(props.workspaceId, issue.key, transitionId);
    linear.upsert(updated);
  } catch (e) {
    // The stale-mirror case: Linear refused because the ticket moved meanwhile. Refresh the
    // one issue so the board shows where it actually is.
    local.notify(e instanceof Error ? e.message : String(e), 'error');
    void linear.refreshIssue(props.workspaceId, issue.key);
  }
}

// ── lifecycle ─────────────────────────────────────────────────────────────────
onMounted(() => {
  void linear.open(props.workspaceId);
});
watch(
  () => props.workspaceId,
  (id) => {
    void linear.open(id);
  },
);
onUnmounted(() => {
  linear.close();
});
</script>

<style scoped lang="scss">
.lbv {
  display: flex;
  flex-direction: column;
  gap: 12px;
  flex: 1;
  min-height: 0;
}

// Wraps rather than overflowing: search + assignee chip + count + two buttons need ~700px,
// and the board is routinely opened in a half-width Electron window or beside a side panel.
.lbv__bar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--k-sp-3);
}

.lbv__count {
  font-size: var(--k-fs-xs);
  color: var(--k-faint);
}

.lbv__search {
  flex: 0 1 220px;
  min-width: 0;
}

.lbv__spacer {
  flex: 1;
}

.lbv__readonly {
  font-size: var(--k-fs-xs);
  color: var(--k-warning);
}

.lbv__error {
  margin: 0;
  font-size: var(--k-fs-sm);
  color: var(--k-muted);
}

.lbv__columns {
  display: grid;
  grid-template-columns: repeat(var(--cols), minmax(220px, 1fr));
  grid-auto-rows: 1fr;
  gap: var(--k-sp-4);
  flex: 1;
  min-height: 0;
  overflow-x: auto;
}

// Flex + flex:1 stretches the column to the full grid row, exactly how the native board's
// direct grid child behaves — without it the column background stops under the last card.
.lbv__column {
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

.lbv__column-empty {
  padding: var(--k-sp-3);
  font-size: 11px;
  color: var(--k-muted);
}
</style>
