<template>
  <div class="pbv">
    <div class="pbv__bar">
      <KChipSelect
        v-if="plane.integrations.length > 1"
        :model-value="plane.activeId ?? ''"
        :options="projectChoices"
        icon="📋"
        placement="down"
        :title="t('plane.boardView.projectTitle')"
        @update:model-value="switchProject"
      />
      <KField
        v-model="query"
        class="pbv__search"
        type="search"
        :placeholder="t('plane.boardView.searchPlaceholder')"
      />
      <KChipSelect
        :model-value="assignee"
        :options="assigneeChoices"
        icon="👤"
        placement="down"
        :title="t('plane.boardView.assigneeTitle')"
        @update:model-value="assignee = $event"
      />
      <span v-if="filtering" class="pbv__count mono">{{ t('plane.boardView.searchCount', { n: matched.length, total: plane.issues.length, board: boardName }) }}</span>
      <span v-else class="pbv__count mono">{{ t('plane.boardView.count', { n: plane.issues.length, board: boardName }, plane.issues.length) }}</span>
      <span class="pbv__spacer"></span>
      <span v-if="plane.tokenKnown && !plane.tokenPresent" class="pbv__readonly mono" v-tip="readOnlyHint">{{ t('plane.boardView.readOnly') }}</span>
      <KBtn
        :disabled="!plane.tokenPresent"
        :loading="plane.syncing"
        :title="plane.tokenPresent ? syncHint : readOnlyHint"
        @click="plane.syncNow()"
      >
        {{ plane.syncing ? t('plane.boardView.syncing') : t('plane.boardView.sync') }}
      </KBtn>
      <KBtn variant="primary" :disabled="!plane.tokenPresent" :title="plane.tokenPresent ? '' : readOnlyHint" @click="creatorOpen = true">
        {{ t('plane.boardView.newTicket') }}
      </KBtn>
    </div>

    <p v-if="plane.loadError" class="pbv__error mono">{{ plane.loadError }}</p>

    <!-- The empty line names the filter the user can actually see: with something typed, the
         query it failed to match; with only the assignee chip narrowing, the query is blank. -->
    <p v-else-if="filtering && !matched.length && plane.columns.length" class="pbv__error mono">
      {{ query.trim() ? t('plane.boardView.searchEmpty', { q: query.trim() }) : t('plane.boardView.filterEmpty') }}
    </p>

    <div v-if="phase === 'skeleton'" class="pbv__columns" :style="{ '--cols': 3 }">
      <div v-for="i in 3" :key="i" class="pbv__column">
        <KSkeleton variant="card" :rows="3" />
      </div>
    </div>

    <div v-else-if="phase === 'ready' && plane.columns.length" class="pbv__columns" :style="{ '--cols': plane.columns.length }">
      <div
        v-for="col in plane.columns"
        :key="col.position"
        class="pbv__column"
        :class="{ 'pbv__column--over': dragOver === col.position }"
        @dragover.prevent="dragOver = col.position"
        @dragleave="dragOver = dragOver === col.position ? null : dragOver"
        @drop.prevent="onDrop(col)"
      >
        <KKanbanColumn :label="col.name" :count="grouped[col.position]?.length ?? 0">
          <PlaneCard
            v-for="issue in grouped[col.position]"
            :key="issue.issueId"
            :issue="issue"
            :agent-status="agentStatusOf(issue)"
            :draggable="plane.tokenPresent"
            :pending="pending.isPending(`issue:${issue.key}`)"
            @click="openIssue(issue)"
            @dragstart="dragged = issue"
          />
          <p v-if="!grouped[col.position]?.length" class="pbv__column-empty mono">—</p>
        </KKanbanColumn>
      </div>
    </div>

    <p v-else-if="phase === 'ready'" class="pbv__error mono">
      {{ t('plane.boardView.emptyBoard') }}
    </p>

    <!-- TICKET DETAIL — mounted only with a subject, so `issue` is always real inside. -->
    <PlaneTicketDialog
      v-if="openedIssue"
      v-model="dialogOpen"
      :issue="openedIssue"
      :integration-id="integrationId"
      @launch="launchOpen = true"
      @edit="editorOpen = true"
      @subtask="subtaskOpen = true"
      @open-issue="openByKey"
    />

    <PlaneLaunchDialog
      v-if="openedIssue"
      v-model="launchOpen"
      :issue="openedIssue"
      :workspace-id="workspaceId"
      :integration-id="integrationId"
      @launched="onLaunched"
    />

    <PlaneIssueEditor
      v-if="openedIssue"
      v-model="editorOpen"
      :integration-id="integrationId"
      :issue="openedIssue"
      @saved="plane.upsert"
    />

    <PlaneIssueEditor
      v-if="openedIssue"
      v-model="subtaskOpen"
      :integration-id="integrationId"
      :parent-key="openedIssue.key"
      @saved="plane.upsert"
    />

    <PlaneIssueEditor v-model="creatorOpen" :integration-id="integrationId" @saved="plane.upsert" />

    <PlaneStatusPickDialog
      v-model="dropPickOpen"
      :title="dropIssue ? `${dropIssue.key} → ${dropColumn?.name ?? ''}` : ''"
      :lead="t('plane.boardView.dropLead')"
      :options="dropOptions"
      :busy="dropBusy"
      @pick="applyDrop"
    />
  </div>
</template>

<script setup lang="ts">
// «Дошка → Plane»: the mirrored project, one column per Plane state from plane_columns,
// cards grouped by state (lib/plane-view.ts). Drag is the move surface: optimistic nothing —
// the card moves only when Plane says yes, because Plane is the source of truth and a
// snap-back after a fake move reads as breakage.
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import type { PlaneColumn, PlaneIssue } from '@kermanych/cloud';
import type { Session, SessionStatus } from '@kermanych/core';
import KBtn from 'components/kit/KBtn.vue';
import KChipSelect from 'components/kit/KChipSelect.vue';
import KField from 'components/kit/KField.vue';
import KSkeleton from 'components/kit/KSkeleton.vue';
import KKanbanColumn from 'components/kit/KKanbanColumn.vue';
import PlaneCard from './PlaneCard.vue';
import PlaneIssueEditor from './PlaneIssueEditor.vue';
import PlaneLaunchDialog from './PlaneLaunchDialog.vue';
import PlaneStatusPickDialog from './PlaneStatusPickDialog.vue';
import PlaneTicketDialog from './PlaneTicketDialog.vue';
import { api } from '../../lib/api';
import { useAsyncAction } from '../../composables/useAsyncAction';
import { useLoadPhase } from '../../composables/useLoadPhase';
import { useRememberedChoice } from '../../composables/useRememberedChoice';
import {
  assigneeOptions,
  filterByAssignee,
  filterIssues,
  issuesByColumn,
  transitionChoiceForDrop,
  UNASSIGNED,
  type PlaneTransitionView,
} from '../../lib/plane-view';
import { useBoard } from 'stores/board';
import { usePlane } from 'stores/plane';
import { useOrchestrator } from 'stores/orchestrator';
import { usePending } from 'stores/pending';
import { useI18n } from 'vue-i18n';

const { t } = useI18n();
const readOnlyHint = computed(() => t('plane.boardView.readOnlyHint'));
const syncHint = computed(() => t('plane.boardView.syncHint'));

const props = defineProps<{ workspaceId: string }>();

const plane = usePlane();
const board = useBoard();
const local = useOrchestrator();
const pending = usePending();

// Not loaded = no answer for this workspace yet, or a (first / project-switch) load with no
// columns on screen. A sync of a project already shown keeps the columns.
const phase = useLoadPhase(() => plane.integration === undefined || (plane.loading && !plane.columns.length));

// The search box filters the cards, never the columns: an empty column under a query
// still says which column it is, so the board keeps its shape while you type.
const query = ref('');
// The project name stays in the bar while filtering too — it says WHICH project you are
// searching.
const boardName = computed(() => plane.integration?.projectName ?? '');

// The active project's integration id — what every project-scoped api call signs with, and
// what the child dialogs act on. The switcher (shown only with more than one project) moves
// it through the store.
const integrationId = computed(() => plane.integration?.id ?? '');
const projectChoices = computed(() =>
  plane.integrations.map((i) => ({ value: i.id, label: `${i.projectName} · ${i.projectIdentifier}` })),
);
function switchProject(id: string): void {
  void plane.setActive(id);
}

// «Anyone» and «Unassigned» lead, then the people actually holding cards.
const assigneeChoices = computed(() => [
  { value: '', label: t('plane.boardView.assigneeAll') },
  { value: UNASSIGNED, label: t('plane.boardView.assigneeNone') },
  ...assigneeOptions(plane.issues).map((o) => ({ value: o.id, label: o.name })),
]);

// The assignee chip, remembered per project on this device (the Jira board's rule): a person
// who no longer holds a card falls back to «anyone» rather than leave the board empty.
const assignee = useRememberedChoice(
  () => (integrationId.value ? `kermanych.plane.assignee.${integrationId.value}` : ''),
  () => assigneeChoices.value,
  () => !plane.loading,
);

// Both narrowings, one after the other: the search box over the assignee's cards.
const matched = computed(() => filterByAssignee(filterIssues(plane.issues, query.value), assignee.value));
const filtering = computed(() => query.value.trim() !== '' || assignee.value !== '');
const grouped = computed(() => issuesByColumn(plane.columns, matched.value));

// ── detail / editors ──────────────────────────────────────────────────────────
const openedIssueId = ref<string | null>(null);
const dialogOpen = ref(false);
const launchOpen = ref(false);
const editorOpen = ref(false);
const subtaskOpen = ref(false);
const creatorOpen = ref(false);

// Resolved from the store, not a snapshot: a realtime upsert while the dialog is open
// must update the open dialog too.
const openedIssue = computed(() => plane.issues.find((i) => i.issueId === openedIssueId.value));

function openIssue(issue: PlaneIssue): void {
  openedIssueId.value = issue.issueId;
  dialogOpen.value = true;
}

function openByKey(key: string): void {
  const hit = plane.issues.find((i) => i.key === key);
  if (hit) openIssue(hit);
}

// The agent chip: the shadow task's live status off the SHARED board store (realtime
// already feeds it), so the Plane card and the native card can never disagree.
function agentStatusOf(issue: PlaneIssue): SessionStatus | undefined {
  if (!issue.taskId) return undefined;
  return board.tasks.find((task) => task.id === issue.taskId)?.status;
}

function onLaunched(session: Session, transitionError?: string): void {
  local.notify(t('plane.boardView.sessionLaunched', { name: session.name }), 'info');
  if (transitionError) {
    local.notify(t('plane.boardView.transitionFailedAfterLaunch', { error: transitionError }), 'error');
  }
  void plane.refreshIssue(openedIssue.value?.key ?? '');
}

// ── drag → state ──────────────────────────────────────────────────────────────
const dragged = ref<PlaneIssue | null>(null);
const dragOver = ref<number | null>(null);
const dropPickOpen = ref(false);
const dropIssue = ref<PlaneIssue | null>(null);
const dropColumn = ref<PlaneColumn | null>(null);
const dropOptions = ref<PlaneTransitionView[]>([]);

// The card waits on Plane from the drop until the mirror shows it in another state — the
// HTTP answer and the realtime echo both land through the store, so the condition is on the
// store's copy of the issue, not on the call.
function markMoving(issue: PlaneIssue): void {
  const key = issue.key;
  const from = issue.statusId;
  pending.mark(`issue:${key}`, () => {
    const now = plane.issues.find((i) => i.key === key);
    return !now || now.statusId !== from;
  });
}

async function onDrop(column: PlaneColumn): Promise<void> {
  dragOver.value = null;
  const issue = dragged.value;
  dragged.value = null;
  if (!issue || !plane.tokenPresent) return;
  if (pending.isPending(`issue:${issue.key}`)) return; // a move is already in flight
  if (column.stateIds.includes(issue.statusId)) return; // dropped where it already is

  markMoving(issue);
  // Plane has no workflow: a column is one state and any state may be set, so the column's
  // state IS the move — no states read first. That is one Plane call saved per drag out of
  // the 60 a minute the whole project shares. Only a column that ever held several states
  // (the Jira-parity shape) asks which.
  if (column.stateIds.length === 1) {
    await transitionIssue(issue, column.stateIds[0]!);
    return;
  }
  let transitions: PlaneTransitionView[];
  try {
    transitions = await api.planeTransitions(integrationId.value, issue.key);
  } catch (e) {
    pending.clear(`issue:${issue.key}`);
    local.notify(e instanceof Error ? e.message : String(e), 'error');
    return;
  }

  const decision = transitionChoiceForDrop(column, transitions);
  if (decision.kind === 'none') {
    pending.clear(`issue:${issue.key}`);
    local.notify(t('plane.boardView.dropRefused', { key: issue.key, column: column.name }), 'error');
    return;
  }
  if (decision.kind === 'auto') {
    await transitionIssue(issue, decision.transition.id);
    return;
  }
  // The pick dialog is the feedback while the human chooses; the card waits again on pick.
  pending.clear(`issue:${issue.key}`);
  dropIssue.value = issue;
  dropColumn.value = column;
  dropOptions.value = decision.options;
  dropPickOpen.value = true;
}

const { run: applyDrop, busy: dropBusy } = useAsyncAction(async (tr: PlaneTransitionView) => {
  const issue = dropIssue.value;
  if (!issue) return;
  markMoving(issue);
  await transitionIssue(issue, tr.id);
  dropPickOpen.value = false;
});

async function transitionIssue(issue: PlaneIssue, stateId: string): Promise<void> {
  try {
    const updated = await api.planeTransition(integrationId.value, issue.key, stateId);
    plane.upsert(updated);
  } catch (e) {
    pending.clear(`issue:${issue.key}`);
    // The stale-mirror case: the state vanished or the item moved meanwhile. Refresh the one
    // item so the board shows where it actually is.
    local.notify(e instanceof Error ? e.message : String(e), 'error');
    void plane.refreshIssue(issue.key);
  }
}

// ── lifecycle ─────────────────────────────────────────────────────────────────
onMounted(() => {
  void plane.open(props.workspaceId);
});
watch(
  () => props.workspaceId,
  (id) => {
    void plane.open(id);
  },
);
onUnmounted(() => {
  plane.close();
});
</script>

<style scoped lang="scss">
.pbv {
  display: flex;
  flex-direction: column;
  gap: 12px;
  flex: 1;
  min-height: 0;
}

// Wraps rather than overflowing: the board is routinely opened in a half-width window, and
// the Sync and New-ticket buttons must stay in reach.
.pbv__bar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--k-sp-3);
}

.pbv__count {
  font-size: var(--k-fs-xs);
  color: var(--k-faint);
}

// 220px is the preferred width, not a fixed one: the field gives room back to the chip and
// the buttons before the bar is forced to wrap.
.pbv__search {
  flex: 0 1 220px;
  min-width: 0;
}

.pbv__spacer {
  flex: 1;
}

.pbv__readonly {
  font-size: var(--k-fs-xs);
  color: var(--k-warning);
}

.pbv__error {
  margin: 0;
  font-size: var(--k-fs-sm);
  color: var(--k-muted);
}

.pbv__columns {
  display: grid;
  grid-template-columns: repeat(var(--cols), minmax(220px, 1fr));
  grid-auto-rows: 1fr;
  gap: var(--k-sp-4);
  flex: 1;
  min-height: 0;
  overflow-x: auto;
}

// The wrapper div exists only for the drag handlers; flex + flex:1 stretches the kanban
// column to the full grid row, exactly how the native board's direct grid child behaves.
.pbv__column {
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

.pbv__column-empty {
  padding: var(--k-sp-3);
  font-size: 11px;
  color: var(--k-muted);
}
</style>
