<template>
  <KModal
    :model-value="modelValue"
    :title="`${issue.key}`"
    :width="expanded ? 'min(90vw, 1680px)' : '780px'"
    @update:model-value="emit('update:modelValue', $event)"
  >
    <template #head-meta>
      <span class="ptd__headside">
        <span class="ptd__headmeta mono">{{ issue.statusName }}</span>
        <KFullscreenButton
          :on="expanded"
          :enter-title="t('plane.ticketDialog.expand')"
          :exit-title="t('plane.ticketDialog.collapse')"
          @click="expanded = !expanded"
        />
      </span>
    </template>

    <div class="ptd">
      <div class="ptd__main">
        <h3 class="ptd__summary">{{ issue.summary }}</h3>

        <!-- Sanitized before v-html: the mirror stores what Plane's editor wrote; trust is
             decided here (lib/sanitize-html.ts). -->
        <div v-if="descriptionHtml" class="ptd__desc" v-html="descriptionHtml"></div>
        <p v-else class="ptd__empty mono">{{ t('plane.ticketDialog.emptyDescription') }}</p>

        <div v-if="subtasks.length" class="ptd__section">
          <h4 class="ptd__section-title">{{ t('plane.ticketDialog.subtasks') }}</h4>
          <button
            v-for="sub in subtasks"
            :key="sub.issueId"
            class="ptd__subtask"
            type="button"
            @click="emit('openIssue', sub.key)"
          >
            <span class="mono">{{ sub.key }}</span>
            <span class="ptd__subtask-summary">{{ sub.summary }}</span>
            <span class="ptd__subtask-status mono">{{ sub.statusName }}</span>
          </button>
        </div>

        <div v-if="kids?.attachments.length || canAct || kidsPhase === 'skeleton'" class="ptd__section">
          <h4 class="ptd__section-title">{{ t('plane.ticketDialog.attachments') }}</h4>
          <KSkeleton v-if="kidsPhase === 'skeleton'" variant="lines" :rows="2" />
          <div v-for="a in kids?.attachments ?? []" :key="a.attachmentId" class="ptd__attachment">
            <button
              class="ptd__attachment-name"
              type="button"
              :disabled="!canAct || downloadBusy(a.attachmentId)"
              :aria-busy="downloadBusy(a.attachmentId) || undefined"
              @click="download(a.attachmentId, a)"
            >
              {{ a.filename }}
            </button>
            <KSpinner v-if="downloadBusy(a.attachmentId)" :size="10" />
            <span class="ptd__attachment-meta mono">{{ prettySize(a.size) }}{{ a.authorName ? ` · ${a.authorName}` : '' }}</span>
          </div>
          <div v-if="canAct" class="ptd__attach-row">
            <input ref="fileInput" type="file" class="ptd__file" @change="upload" />
            <KBtn variant="ghost" :loading="uploading" @click="fileInput?.click()">
              {{ uploading ? t('plane.ticketDialog.uploading') : t('plane.ticketDialog.addFile') }}
            </KBtn>
            <span class="ptd__attach-hint mono">{{ t('plane.ticketDialog.sizeHint') }}</span>
          </div>
        </div>

        <div class="ptd__section">
          <!-- Tabs only where there is a second tab: without time tracking (the feature off,
               or an edition without worklogs) the section is just the comments. -->
          <div v-if="worklogsOn" class="ptd__tabs">
            <button
              class="ptd__tab"
              :class="{ 'ptd__tab--on': tab === 'comments' }"
              type="button"
              @click="tab = 'comments'"
            >{{ t('plane.ticketDialog.comments') }}{{ kids?.comments.length ? ` · ${kids.comments.length}` : '' }}</button>
            <button
              class="ptd__tab"
              :class="{ 'ptd__tab--on': tab === 'worklogs' }"
              type="button"
              @click="tab = 'worklogs'"
            >{{ t('plane.ticketDialog.worklogs') }}{{ kids?.worklogs.length ? ` · ${kids.worklogs.length}` : '' }}</button>
          </div>
          <h4 v-else class="ptd__section-title">
            {{ t('plane.ticketDialog.comments') }}{{ kids?.comments.length ? ` · ${kids.comments.length}` : '' }}
          </h4>

          <template v-if="tab === 'comments' || !worklogsOn">
            <KSkeleton v-if="kidsPhase === 'skeleton'" variant="rows" :rows="3" />
            <div v-for="c in kids?.comments ?? []" :key="c.commentId" class="ptd__comment">
              <div class="ptd__comment-head">
                <KAvatar :name="c.authorName || '?'" :avatar-url="c.authorAvatar || undefined" :size="18" />
                <span class="ptd__comment-author">{{ c.authorName }}</span>
                <span class="ptd__comment-time mono">{{ shortTime(c.planeCreatedAt) }}</span>
              </div>
              <div class="ptd__comment-body" v-html="sanitizeJiraHtml(c.bodyHtml)"></div>
            </div>
            <p v-if="kidsPhase === 'ready' && !kids?.comments.length" class="ptd__empty mono">{{ t('plane.ticketDialog.noComments') }}</p>

            <div v-if="canAct" class="ptd__composer">
              <textarea
                v-model="commentDraft"
                class="ptd__composer-input"
                rows="3"
                :placeholder="t('plane.ticketDialog.commentPlaceholder')"
              ></textarea>
              <KBtn variant="secondary" :disabled="!commentDraft.trim()" :loading="commenting" @click="sendComment">
                {{ commenting ? t('plane.ticketDialog.sending') : t('plane.ticketDialog.comment') }}
              </KBtn>
            </div>
          </template>

          <template v-else>
            <KSkeleton v-if="kidsPhase === 'skeleton'" variant="rows" :rows="3" />
            <div v-for="w in kids?.worklogs ?? []" :key="w.worklogId" class="ptd__worklog">
              <span class="ptd__worklog-time mono">{{ w.timeSpent || formatDuration(w.seconds) }}</span>
              <span class="ptd__worklog-author">{{ w.authorName }}</span>
              <span class="ptd__worklog-when mono">{{ shortTime(w.startedAt) }}</span>
              <span v-if="w.description" class="ptd__worklog-note">{{ w.description }}</span>
              <!-- Only the controls Plane allows: own entries, or anyone's for a project
                   admin — answered per entry by whose id wrote it. -->
              <span class="ptd__worklog-acts">
                <button
                  v-if="mayEditWorklog(w)"
                  class="ptd__worklog-act"
                  type="button"
                  :disabled="logging"
                  @click="startEditWorklog(w)"
                >{{ editingWorklogId === w.worklogId ? t('plane.ticketDialog.worklogEditing') : t('plane.ticketDialog.edit') }}</button>
                <button
                  v-if="mayDeleteWorklog(w)"
                  class="ptd__worklog-act"
                  type="button"
                  :disabled="logging"
                  @click="deletingWorklogId = w.worklogId"
                >{{ t('plane.ticketDialog.delete') }}</button>
              </span>

              <div v-if="deletingWorklogId === w.worklogId" class="ptd__worklog-confirm">
                <p class="ptd__confirm">{{ t('plane.ticketDialog.deleteWorklogConfirm') }}</p>
                <div class="ptd__confirm-row">
                  <KBtn variant="ghost" :disabled="logging" @click="deletingWorklogId = null">{{ t('plane.ticketDialog.no') }}</KBtn>
                  <KBtn variant="secondary" :disabled="submitting" :loading="deletingWorklog" @click="deleteWorklog(w.worklogId)">
                    {{ t('plane.ticketDialog.yesDelete') }}
                  </KBtn>
                </div>
              </div>
            </div>
            <p v-if="kidsPhase === 'ready' && !kids?.worklogs.length" class="ptd__empty mono">{{ t('plane.ticketDialog.noWorklogs') }}</p>

            <!-- Plane's worklog, field for field: a duration and an optional note. Plane has
                 no «started» and no estimate to adjust, so neither is asked. The SAME form
                 edits an existing entry. -->
            <div v-if="canAct" class="ptd__logwork">
              <p v-if="editingWorklogId" class="ptd__logwork-mode mono">{{ t('plane.ticketDialog.worklogEditMode') }}</p>
              <label class="ptd__field">
                <span class="ptd__field-label">{{ t('plane.ticketDialog.spent') }}</span>
                <input
                  v-model="workTime"
                  class="ptd__estimate mono"
                  :placeholder="t('plane.ticketDialog.timePlaceholder')"
                  :disabled="logging"
                  v-tip="t('plane.ticketDialog.timeFormatTip')"
                  @keydown.enter.prevent="submitWork"
                />
              </label>
              <textarea
                v-model="workNote"
                class="ptd__composer-input"
                rows="2"
                :placeholder="t('plane.ticketDialog.workNotePlaceholder')"
                :disabled="logging"
              ></textarea>
              <div class="ptd__confirm-row">
                <KBtn v-if="editingWorklogId" variant="ghost" :disabled="logging" @click="resetWorkDraft">
                  {{ t('plane.ticketDialog.cancel') }}
                </KBtn>
                <KBtn variant="secondary" :disabled="!workTime.trim() || deletingWorklog" :loading="submitting" @click="submitWork">
                  {{ submitLabel }}
                </KBtn>
              </div>
            </div>
          </template>
        </div>
      </div>

      <aside class="ptd__side">
        <dl class="ptd__facts">
          <div>
            <dt>{{ t('plane.ticketDialog.status') }}</dt>
            <dd>
              <button
                class="ptd__status"
                type="button"
                :disabled="!canAct || transitionsLoading"
                :aria-busy="transitionsLoading || undefined"
                v-tip="canAct ? t('plane.ticketDialog.transitionTip') : readOnlyHint"
                @click="openTransition"
              >{{ issue.statusName }}<KSpinner v-if="transitionsLoading" :size="10" class="ptd__spin" /></button>
            </dd>
          </div>
          <div v-if="issue.typeName"><dt>{{ t('plane.ticketDialog.type') }}</dt><dd>{{ issue.typeName }}</dd></div>
          <div>
            <dt>{{ t('plane.ticketDialog.priority') }}</dt>
            <dd v-if="canAct">
              <KSelect
                :model-value="priorityShown"
                :options="priorityOptions"
                :loading="priorityPending"
                @update:model-value="pickPriority"
              />
            </dd>
            <dd v-else>{{ t(`plane.priority.${priorityCurrent}`) }}</dd>
          </div>
          <!-- The estimate is a pick from the project's estimate points; a project (or an
               edition) without them shows Plane's value read-only. -->
          <div v-if="issue.estimate || (canAct && (estimateOptions.length || listsLoading))">
            <dt>{{ t('plane.ticketDialog.estimate') }}</dt>
            <dd v-if="canAct && (estimateOptions.length || listsLoading)">
              <KSelect
                :model-value="estimateShown"
                :options="estimateOptions"
                :loading="estimatePending || listsLoading"
                @update:model-value="pickEstimate"
              />
            </dd>
            <dd v-else class="mono">{{ issue.estimate || '—' }}</dd>
          </div>
          <!-- Logged time is read-only here: only a worklog moves it. It appears once Plane
               holds one, so an item nobody logged against carries no blank row. -->
          <div v-if="issue.timeSpent"><dt>{{ t('plane.ticketDialog.spent') }}</dt><dd class="mono">{{ issue.timeSpent }}</dd></div>
          <div>
            <dt>{{ t('plane.ticketDialog.start') }}</dt>
            <dd>
              <input
                v-if="canAct"
                v-model="startDraft"
                type="date"
                class="ptd__date mono"
                :disabled="savingField === 'startDate'"
                v-tip="t('plane.ticketDialog.startDateTip')"
                @change="saveStartDate"
              />
              <KSpinner v-if="savingField === 'startDate'" :size="10" class="ptd__spin" />
              <span v-else-if="!canAct">{{ issue.startDate || '—' }}</span>
            </dd>
          </div>
          <div>
            <dt>{{ t('plane.ticketDialog.due') }}</dt>
            <dd>
              <input
                v-if="canAct"
                v-model="dueDraft"
                type="date"
                class="ptd__date mono"
                :class="{ 'ptd__date--overdue': overdue }"
                :disabled="savingField === 'dueDate'"
                v-tip="overdue ? t('plane.ticketDialog.dueTipOverdue') : t('plane.ticketDialog.dueTip')"
                @change="saveDueDate"
              />
              <KSpinner v-if="savingField === 'dueDate'" :size="10" class="ptd__spin" />
              <span v-else-if="!canAct" :class="{ 'ptd__date--overdue': overdue }">{{ issue.dueDate || '—' }}</span>
            </dd>
          </div>
          <div>
            <dt>{{ t('plane.ticketDialog.assignee') }}</dt>
            <dd v-if="canAct && (assigneeOptions.length > 1 || listsLoading)">
              <KSelect
                :model-value="assigneeShown"
                :options="assigneeOptions"
                :loading="assigneePending || listsLoading"
                :placeholder="t('plane.ticketDialog.unassigned')"
                searchable
                @update:model-value="pickAssignee"
              />
            </dd>
            <dd v-else>{{ issue.assigneeName ?? t('plane.ticketDialog.unassigned') }}</dd>
          </div>
          <div v-if="issue.reporterName"><dt>{{ t('plane.ticketDialog.reporter') }}</dt><dd>{{ issue.reporterName }}</dd></div>
          <div v-if="issue.labels.length">
            <dt>{{ t('plane.ticketDialog.labels') }}</dt>
            <dd class="ptd__labels">
              <span v-for="label in issue.labels" :key="label" class="ptd__label mono">{{ label }}</span>
            </dd>
          </div>
          <div v-if="issue.parentKey">
            <dt>{{ t('plane.ticketDialog.parent') }}</dt>
            <dd><button class="ptd__link mono" type="button" @click="emit('openIssue', issue.parentKey!)">{{ issue.parentKey }}</button></dd>
          </div>
          <div v-if="webUrl">
            <dt>{{ t('plane.ticketDialog.link') }}</dt>
            <dd><a class="ptd__link mono" :href="webUrl" target="_blank" rel="noopener noreferrer">{{ t('plane.ticketDialog.openInPlane') }}</a></dd>
          </div>
        </dl>

        <div class="ptd__actions">
          <KBtn
            variant="primary"
            :disabled="!canLaunch"
            :title="launchHint"
            @click="emit('launch')"
          >{{ t('plane.ticketDialog.launch') }}</KBtn>
          <KBtn variant="secondary" :disabled="!canAct" :title="canAct ? '' : readOnlyHint" @click="emit('edit')">{{ t('plane.ticketDialog.edit') }}</KBtn>
          <KBtn variant="ghost" :disabled="!canAct" :title="canAct ? '' : readOnlyHint" @click="emit('subtask')">{{ t('plane.ticketDialog.addSubtask') }}</KBtn>
          <KBtn v-if="!confirmingDelete" variant="ghost" :disabled="!canAct" :title="canAct ? '' : readOnlyHint" @click="confirmingDelete = true">{{ t('plane.ticketDialog.delete') }}</KBtn>
          <template v-else>
            <p class="ptd__confirm">{{ t('plane.ticketDialog.deleteConfirm', { key: issue.key }) }}</p>
            <div class="ptd__confirm-row">
              <KBtn variant="ghost" :disabled="deleting" @click="confirmingDelete = false">{{ t('plane.ticketDialog.no') }}</KBtn>
              <KBtn variant="secondary" :loading="deleting" @click="doDelete">{{ t('plane.ticketDialog.yesDelete') }}</KBtn>
            </div>
          </template>
        </div>
      </aside>
    </div>

    <PlaneStatusPickDialog
      v-model="transitionOpen"
      :title="t('plane.ticketDialog.statusTitle', { key: issue.key })"
      :options="transitionOptions"
      :busy="transitioning"
      @pick="applyTransition"
    />
  </KModal>
</template>

<script setup lang="ts">
// The mirrored work item, whole: description, standard fields, sub-work items, attachments,
// comments and — where the project tracks time — worklogs. Every ACTION goes to Plane under
// this member's token and lands back in the mirror; a tokenless member sees everything and
// can touch nothing — each control says why instead of hiding. The Jira ticket dialog's twin
// with Plane's own shape: a fixed priority enum, estimate POINTS instead of a duration, and
// worklogs that are a duration plus a note.
import { computed, onMounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import type { PlaneAttachment, PlaneIssue, PlaneWorklog } from '@kermanych/cloud';
import KAvatar from 'components/kit/KAvatar.vue';
import KBtn from 'components/kit/KBtn.vue';
import KModal from 'components/kit/KModal.vue';
import KFullscreenButton from 'components/kit/KFullscreenButton.vue';
import KSelect, { type KSelectOption } from 'components/kit/KSelect.vue';
import KSkeleton from 'components/kit/KSkeleton.vue';
import KSpinner from 'components/kit/KSpinner.vue';
import PlaneStatusPickDialog from './PlaneStatusPickDialog.vue';
import {
  api,
  type PlaneAssignableUser,
  type PlaneEditorOptions,
  type PlaneIssueDraft,
  type PlaneWorklogDraft,
} from '../../lib/api';
import { sanitizeJiraHtml } from '../../lib/sanitize-html';
import {
  dateChip,
  formatDuration,
  planeIssueUrl,
  PLANE_PRIORITIES,
  priorityValue,
  subtasksOf,
  todayIso,
  type PlaneTransitionView,
} from '../../lib/plane-view';
import { useAsyncAction, useKeyedAction } from '../../composables/useAsyncAction';
import { useLoadPhase } from '../../composables/useLoadPhase';
import { useOptimisticValue } from '../../composables/useOptimisticValue';
import { usePlane } from 'stores/plane';
import { useOrchestrator } from 'stores/orchestrator';

const { t } = useI18n();
const readOnlyHint = computed(() => t('plane.ticketDialog.readOnlyHint'));

const props = defineProps<{ modelValue: boolean; issue: PlaneIssue; integrationId: string }>();
const emit = defineEmits<{
  'update:modelValue': [value: boolean];
  launch: [];
  edit: [];
  subtask: [];
  openIssue: [key: string];
  deleted: [];
}>();

const plane = usePlane();
const local = useOrchestrator();

const tab = ref<'comments' | 'worklogs'>('comments');
// The wide mode: the same ticket at ~90% of the screen, for descriptions that need room.
const expanded = ref(false);
const commentDraft = ref('');
const confirmingDelete = ref(false);
const fileInput = ref<HTMLInputElement | null>(null);

const transitionOpen = ref(false);
const transitionOptions = ref<PlaneTransitionView[]>([]);

// ── logging work ─────────────────────────────────────────────────────────────
const workTime = ref('');
const workNote = ref('');
// Which existing entry the form is editing (null = composing a new one), and which one is
// asking to be deleted. Separate: a delete confirm is a per-row question, while the edit
// takes over the one form at the bottom.
const editingWorklogId = ref<string | null>(null);
const deletingWorklogId = ref<string | null>(null);

// ── inline facts editing: priority / assignee / estimate / start & due date ───
// One-field drafts through PUT /plane/issues — the same endpoint the full editor uses, so
// Plane's own validation is the only validation.
const editorOptions = ref<PlaneEditorOptions>({
  issueTypes: [],
  priorities: [],
  labels: [],
  states: [],
  estimatePoints: [],
  estimateType: '',
  timeTrackingEnabled: false,
  // No identity and no permissions until the api answers — so no entry reads as «mine»
  // and no edit/delete control is offered. The read-only default is the safe one.
  myAccountId: '',
  worklog: { editOwn: false, editAll: false, deleteOwn: false, deleteAll: false },
});
const assignable = ref<PlaneAssignableUser[]>([]);
const startDraft = ref('');
const dueDraft = ref('');
// The date fields saved on change; the three selects go through useOptimisticValue instead
// (they show the pick while it saves).
const savingField = ref<'startDate' | 'dueDate' | null>(null);
// The editor lists (estimate points, assignees, worklog permissions) are being read: the
// selects render with a spinner instead of appearing later and shifting the facts column.
const listsLoading = ref(false);
// The item's children (comments, worklogs, attachments) are being read for this open and
// none are cached yet: skeletons, never «Коментарів немає».
const kidsLoading = ref(false);
let openRun = 0;

// Plane's fixed enum, labelled from i18n: offered at once, no list to wait for.
const priorityOptions = computed<KSelectOption[]>(() =>
  PLANE_PRIORITIES.map((p) => ({ value: p, label: t(`plane.priority.${p}`) })),
);
const priorityCurrent = computed(() => priorityValue(props.issue.priority));

const assigneeOptions = computed<KSelectOption[]>(() => [
  { value: '', label: t('plane.ticketDialog.unassigned') },
  ...assignable.value.map((u) => ({ value: u.accountId, label: u.displayName })),
]);
const assigneeCurrent = computed(() => props.issue.assigneeAccountId ?? '');

// '' first: «no estimate» is a real choice, and it is how an estimate is cleared.
const estimateOptions = computed<KSelectOption[]>(() =>
  editorOptions.value.estimatePoints.length
    ? [
        { value: '', label: t('plane.ticketDialog.estimateNone') },
        ...editorOptions.value.estimatePoints.map((p) => ({ value: p.id, label: p.value })),
      ]
    : [],
);
const estimateCurrent = computed(() => props.issue.estimatePointId ?? '');

const canAct = computed(() => plane.tokenPresent);
const kids = computed(() => plane.children[props.issue.issueId]);
const kidsPhase = useLoadPhase(() => kids.value === undefined && kidsLoading.value);
const descriptionHtml = computed(() => sanitizeJiraHtml(props.issue.descriptionHtml));
const subtasks = computed(() => subtasksOf(plane.issues, props.issue.key));

// The worklog surface exists where the project tracks time: the api's answer for a token
// holder, and — for a member without a token, who cannot ask — the mirror itself, since a
// project that holds worklogs tracks time. Hidden otherwise, never broken (spec Decision 9).
const worklogsOn = computed(() => editorOptions.value.timeTrackingEnabled || !!kids.value?.worklogs.length);

const webUrl = computed(() => {
  const row = plane.integrations.find((i) => i.id === props.integrationId);
  return row ? planeIssueUrl(row, props.issue.key) : '';
});

const submitLabel = computed(() => {
  if (submitting.value) return editingWorklogId.value ? t('plane.ticketDialog.savingWorklog') : t('plane.ticketDialog.loggingWork');
  return editingWorklogId.value ? t('plane.ticketDialog.saveWorklog') : t('plane.ticketDialog.logWork');
});

// Plane's rule: own entries are editable (and deletable); a project admin may touch anyone's.
// A blank author is NOT mine — it then needs the all-entries permission, the conservative
// reading.
function isMyWorklog(w: PlaneWorklog): boolean {
  const me = editorOptions.value.myAccountId;
  return !!me && w.authorAccountId === me;
}

function mayEditWorklog(w: PlaneWorklog): boolean {
  const { editOwn, editAll } = editorOptions.value.worklog;
  return canAct.value && (isMyWorklog(w) ? editOwn || editAll : editAll);
}

function mayDeleteWorklog(w: PlaneWorklog): boolean {
  const { deleteOwn, deleteAll } = editorOptions.value.worklog;
  return canAct.value && (isMyWorklog(w) ? deleteOwn || deleteAll : deleteAll);
}

// The card's own verdict, reused so the dialog cannot disagree with the board about a
// late ticket.
const overdue = computed(() => dateChip(props.issue, todayIso())?.tone === 'overdue');

// Launch is gated the native way: a running shadow task means «уже виконується».
const running = computed(() => {
  const taskId = props.issue.taskId;
  return !!taskId && local.sessions.some((s) => s.taskId === taskId);
});
const canLaunch = computed(() => canAct.value && !running.value);
const launchHint = computed(() => {
  if (!canAct.value) return readOnlyHint.value;
  if (running.value) return t('plane.ticketDialog.launchHintRunning');
  return t('plane.ticketDialog.launchHintReady');
});

// Fresh detail on every open: a live refresh through the api when a token is here (the one
// item whose comments, attachments and worklogs are re-read at once — the sync drains the
// rest a few per tick), the mirror's cache otherwise.
function onOpen(): void {
  tab.value = 'comments';
  confirmingDelete.value = false;
  commentDraft.value = '';
  startDraft.value = props.issue.startDate;
  dueDraft.value = props.issue.dueDate;
  resetWorkDraft();
  deletingWorklogId.value = null;
  const mine = ++openRun;
  kidsLoading.value = true;
  void plane.loadChildren(props.issue.issueId).finally(() => {
    if (mine === openRun) kidsLoading.value = false;
  });
  void plane.refreshIssue(props.issue.key);
  if (canAct.value) void loadEditorLists(mine);
}

watch(
  () => props.modelValue,
  (open) => {
    if (open) onOpen();
  },
);

// The board mounts this dialog together with its first open (`v-if` on the subject and
// `modelValue` flip in one tick), so the watcher above never sees that first false → true.
onMounted(() => {
  if (props.modelValue) onOpen();
});

// Realtime/refresh may change the item under an open dialog; the date inputs must follow
// unless the user is mid-save on that very field.
watch(
  () => props.issue,
  (issue) => {
    if (savingField.value !== 'startDate') startDraft.value = issue.startDate;
    if (savingField.value !== 'dueDate') dueDraft.value = issue.dueDate;
  },
);

// Failure degrades to the read-only facts — the selects render only on loaded lists.
async function loadEditorLists(mine: number): Promise<void> {
  listsLoading.value = true;
  try {
    const lists = await plane.editorLists();
    if (mine !== openRun) return;
    editorOptions.value = lists.options;
    assignable.value = lists.assignable;
  } catch {
    /* keep static facts */
  } finally {
    if (mine === openRun) listsLoading.value = false;
  }
}

async function writeField(draft: PlaneIssueDraft): Promise<void> {
  plane.upsert(await api.planeEditIssue(props.integrationId, props.issue.key, draft));
}

async function saveField(field: NonNullable<typeof savingField.value>, draft: PlaneIssueDraft): Promise<void> {
  savingField.value = field;
  try {
    await writeField(draft);
  } catch (e) {
    local.notify(e instanceof Error ? e.message : String(e), 'error');
    // A refused write leaves the mirror row as the truth: every draft returns to it.
    startDraft.value = props.issue.startDate;
    dueDraft.value = props.issue.dueDate;
  } finally {
    savingField.value = null;
  }
}

// The pick shows at once and holds until the upserted row reports it; a refusal rolls the
// select back to the mirror's value with a toast.
const {
  value: priorityShown,
  pending: priorityPending,
  set: setPriority,
} = useOptimisticValue<string>(() => priorityCurrent.value, (p) => writeField({ priority: priorityValue(p) }));
const {
  value: assigneeShown,
  pending: assigneePending,
  set: setAssignee,
} = useOptimisticValue<string>(() => assigneeCurrent.value, (id) => writeField({ assigneeAccountId: id || null }));
const {
  value: estimateShown,
  pending: estimatePending,
  set: setEstimate,
} = useOptimisticValue<string>(() => estimateCurrent.value, (id) => writeField({ estimatePointId: id || null }));

function pickPriority(p: string): void {
  if (p !== priorityCurrent.value) void setPriority(p);
}

function pickAssignee(id: string): void {
  if (id !== assigneeCurrent.value) void setAssignee(id);
}

function pickEstimate(id: string): void {
  if (id !== estimateCurrent.value) void setEstimate(id);
}

// Both dates go to Plane exactly as <input type="date"> spells them (YYYY-MM-DD), and a
// cleared input is a cleared date in Plane.
async function saveStartDate(): Promise<void> {
  if (startDraft.value === props.issue.startDate) return;
  await saveField('startDate', { startDate: startDraft.value });
}

async function saveDueDate(): Promise<void> {
  if (dueDraft.value === props.issue.dueDate) return;
  await saveField('dueDate', { dueDate: dueDraft.value });
}

// The status button spins while the states are read, then opens the pick.
const { run: openTransition, busy: transitionsLoading } = useAsyncAction(async () => {
  transitionOptions.value = await api.planeTransitions(props.integrationId, props.issue.key);
  transitionOpen.value = true;
});

const { run: applyTransition, busy: transitioning } = useAsyncAction(async (tr: PlaneTransitionView) => {
  const updated = await api.planeTransition(props.integrationId, props.issue.key, tr.id);
  plane.upsert(updated);
  transitionOpen.value = false;
});

const { run: sendComment, busy: commenting } = useAsyncAction(async () => {
  const body = commentDraft.value.trim();
  if (!body) return;
  const updated = await api.planeComment(props.integrationId, props.issue.key, body);
  plane.upsert(updated);
  commentDraft.value = '';
  await plane.loadChildren(props.issue.issueId);
});

// A fresh worklog form, editing nothing — so this doubles as «cancel the edit».
function resetWorkDraft(): void {
  editingWorklogId.value = null;
  workTime.value = '';
  workNote.value = '';
}

// The form takes over an existing entry: its duration in the spelling the field accepts
// back, and its note.
function startEditWorklog(w: PlaneWorklog): void {
  deletingWorklogId.value = null;
  editingWorklogId.value = w.worklogId;
  workTime.value = w.timeSpent || formatDuration(w.seconds);
  workNote.value = w.description;
}

// One worklog written to Plane under this member's token, then the refreshed item into the
// store: «Витрачено» moves with the write, and the children refetch brings the entry itself
// into the list. Creating and editing differ in one call.
const { run: submitWork, busy: submitting } = useAsyncAction(async () => {
  const timeSpent = workTime.value.trim();
  if (!timeSpent) return;
  const note = workNote.value.trim();
  const editing = editingWorklogId.value;
  // An edit sends the note even when it was emptied: that is how a note is removed.
  const draft: PlaneWorklogDraft = { timeSpent, ...(note || editing ? { description: note } : {}) };
  plane.upsert(
    editing
      ? await api.planeEditWorklog(props.integrationId, props.issue.key, editing, draft)
      : await api.planeLogWork(props.integrationId, props.issue.key, draft),
  );
  resetWorkDraft();
  await plane.loadChildren(props.issue.issueId);
});

const { run: deleteWorklog, busy: deletingWorklog } = useAsyncAction(async (worklogId: string) => {
  plane.upsert(await api.planeDeleteWorklog(props.integrationId, props.issue.key, worklogId));
  deletingWorklogId.value = null;
  // A deleted entry must not stay loaded in the form behind it.
  if (editingWorklogId.value === worklogId) resetWorkDraft();
  await plane.loadChildren(props.issue.issueId);
});

// Either worklog write disables the whole form.
const logging = computed(() => submitting.value || deletingWorklog.value);

// Plane's three-step upload (metadata, presigned POST, «uploaded» mark) runs in the api; the
// browser only hands it the bytes.
const { run: upload, busy: uploading } = useAsyncAction(async (e: Event) => {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = '';
  if (!file) return;
  const buf = await file.arrayBuffer();
  let binary = '';
  const bytes = new Uint8Array(buf);
  for (const b of bytes) binary += String.fromCharCode(b);
  const updated = await api.planeUploadAttachment(
    props.integrationId,
    props.issue.key,
    file.name,
    btoa(binary),
    file.type,
  );
  plane.upsert(updated);
  await plane.loadChildren(props.issue.issueId);
});

// Per attachment: one slow download neither blocks nor spins the others.
const { run: download, busyFor: downloadBusy } = useKeyedAction(async (_id: string, a: PlaneAttachment) => {
  const blob = await api.planeDownloadAttachment(props.integrationId, props.issue.key, a.attachmentId);
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = a.filename;
  link.click();
  URL.revokeObjectURL(url);
});

const { run: doDelete, busy: deleting } = useAsyncAction(async () => {
  await api.planeDeleteIssue(props.integrationId, props.issue.key);
  plane.drop(props.issue.issueId);
  emit('update:modelValue', false);
  emit('deleted');
});

function prettySize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

function shortTime(iso: string): string {
  const d = new Date(iso);
  return `${d.toLocaleDateString('uk-UA')} ${d.toLocaleTimeString('uk-UA', { hour: '2-digit', minute: '2-digit' })}`;
}
</script>

<style scoped lang="scss">
// Plane's editor HTML (descriptions, comment bodies) restyled to the modal's type ramp.
// Em-based so the same rules fit the description's base size and the comments' smaller one.
@mixin plane-rich {
  :deep(h1),
  :deep(h2),
  :deep(h3),
  :deep(h4),
  :deep(h5),
  :deep(h6) {
    margin: 1em 0 0.4em;
    font-family: var(--k-font-ui);
    font-weight: var(--k-fw-semibold);
    line-height: 1.3;
    color: var(--k-text);

    &:first-child {
      margin-top: 0;
    }
  }

  :deep(h1) { font-size: 1.45em; }
  :deep(h2) { font-size: 1.3em; }
  :deep(h3) { font-size: 1.15em; }
  :deep(h4) { font-size: 1.05em; }
  :deep(h5) { font-size: 1em; }
  :deep(h6) { font-size: 0.9em; color: var(--k-muted); }

  :deep(p) {
    margin: 0 0 0.6em;
  }

  :deep(ul),
  :deep(ol) {
    margin: 0 0 0.6em;
    padding-left: 1.5em;
  }

  :deep(li) {
    margin: 0.15em 0;
  }

  :deep(li > ul),
  :deep(li > ol) {
    margin-bottom: 0;
  }

  // Plane's task list (`- [ ]` written by Kermanych, or a checklist made in Plane): the
  // sanitizer keeps only the check state, and the box is drawn from it. The checkbox's own
  // label wrapper unwraps to an empty span, which must not take a gap of its own.
  :deep(ul[data-type='taskList']) {
    padding-left: 0.2em;
    list-style: none;
  }

  :deep(li[data-checked]) {
    display: flex;
    gap: 0.4em;

    &::before {
      content: '☐';
      color: var(--k-muted);
    }

    > span:empty {
      display: none;
    }

    > p,
    > div > p {
      margin: 0;
    }
  }

  :deep(li[data-checked='true']) {
    color: var(--k-muted);

    &::before {
      content: '☑';
      color: var(--k-accent);
    }
  }

  :deep(blockquote) {
    margin: 0 0 0.6em;
    padding: 0 0 0 0.75em;
    border-left: 2px solid var(--k-line-strong);
    color: var(--k-muted);
  }

  :deep(pre),
  :deep(code) {
    font-family: var(--k-font-mono);
    font-size: var(--k-fs-sm);
  }

  :deep(pre) {
    margin: 0 0 0.6em;
    padding: var(--k-sp-2);
    overflow-x: auto;
    background: var(--k-surface2);
    border: var(--k-rule-thin) solid var(--k-line);
    border-radius: var(--k-r);
  }

  :deep(code) {
    padding: 1px 4px;
    background: var(--k-surface2);
    border-radius: var(--k-r-sm);
  }

  :deep(pre code) {
    padding: 0;
    background: none;
    border-radius: 0;
  }

  // display:block + max-content: a table wider than the column scrolls in place instead of
  // blowing the grid open.
  :deep(table) {
    display: block;
    width: max-content;
    max-width: 100%;
    margin: 0 0 0.6em;
    overflow-x: auto;
    border-collapse: collapse;
  }

  :deep(th),
  :deep(td) {
    padding: 4px 8px;
    border: var(--k-rule-thin) solid var(--k-line);
    text-align: left;
    vertical-align: top;
  }

  :deep(th) {
    background: var(--k-surface2);
    font-weight: var(--k-fw-semibold);
  }

  :deep(hr) {
    margin: var(--k-sp-3) 0;
    border: none;
    border-top: var(--k-rule-thin) solid var(--k-line);
  }

  :deep(img) {
    max-width: 100%;
  }

  :deep(a) {
    color: var(--k-accent);
  }

  :deep(> :last-child) {
    margin-bottom: 0;
  }
}

.ptd {
  display: grid;
  grid-template-columns: 1fr 220px;
  gap: var(--k-sp-4);
}

.ptd__headmeta {
  font-size: var(--k-fs-xs);
  color: var(--k-faint);
}

.ptd__headside {
  display: flex;
  align-items: center;
  gap: var(--k-sp-2);
}

.ptd__main {
  display: flex;
  flex-direction: column;
  gap: var(--k-sp-3);
  min-width: 0;
}

.ptd__summary {
  margin: 0;
  font-family: var(--k-font-ui);
  font-size: var(--k-fs-lg);
  font-weight: var(--k-fw-semibold);
  color: var(--k-text);
}

.ptd__desc {
  font-family: var(--k-font-ui);
  font-size: var(--k-fs-base);
  line-height: 1.5;
  color: var(--k-text);
  overflow-wrap: anywhere;

  @include plane-rich;
}

.ptd__empty {
  margin: 0;
  font-size: var(--k-fs-sm);
  color: var(--k-faint);
}

.ptd__section {
  display: flex;
  flex-direction: column;
  gap: var(--k-sp-2);
  padding-top: var(--k-sp-2);
  border-top: var(--k-rule-thin) solid var(--k-line);
}

.ptd__section-title {
  margin: 0;
  font-family: var(--k-font-ui);
  font-size: var(--k-fs-sm);
  font-weight: var(--k-fw-medium);
  color: var(--k-muted);
}

.ptd__subtask {
  display: flex;
  align-items: center;
  gap: var(--k-sp-2);
  padding: var(--k-sp-2);
  font-family: var(--k-font-ui);
  font-size: var(--k-fs-sm);
  color: var(--k-text);
  background: var(--k-surface2);
  border: var(--k-rule-thin) solid var(--k-line);
  border-radius: var(--k-r);
  cursor: pointer;
  text-align: left;

  &:hover {
    border-color: var(--k-line-strong);
  }
}

.ptd__subtask-summary {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ptd__subtask-status {
  font-size: var(--k-fs-xs);
  color: var(--k-faint);
}

.ptd__attachment {
  display: flex;
  align-items: baseline;
  gap: var(--k-sp-2);
}

.ptd__attachment-name {
  padding: 0;
  font-family: var(--k-font-ui);
  font-size: var(--k-fs-sm);
  color: var(--k-accent);
  background: none;
  border: none;
  cursor: pointer;
  text-align: left;

  &:disabled {
    color: var(--k-muted);
    cursor: default;
  }
}

.ptd__attachment-meta,
.ptd__attach-hint {
  font-size: var(--k-fs-xs);
  color: var(--k-faint);
}

.ptd__attach-row {
  display: flex;
  align-items: center;
  gap: var(--k-sp-2);
}

.ptd__file {
  display: none;
}

.ptd__tabs {
  display: flex;
  gap: var(--k-sp-2);
}

.ptd__tab {
  padding: 4px 10px;
  font-family: var(--k-font-ui);
  font-size: var(--k-fs-sm);
  color: var(--k-muted);
  background: none;
  border: var(--k-rule-thin) solid transparent;
  border-radius: var(--k-r-pill);
  cursor: pointer;

  &--on {
    color: var(--k-text);
    border-color: var(--k-line-strong);
  }
}

.ptd__comment {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.ptd__comment-head {
  display: flex;
  align-items: center;
  gap: var(--k-sp-2);
}

.ptd__comment-author {
  font-family: var(--k-font-ui);
  font-size: var(--k-fs-sm);
  font-weight: var(--k-fw-medium);
  color: var(--k-text);
}

.ptd__comment-time {
  font-size: var(--k-fs-xs);
  color: var(--k-faint);
}

.ptd__comment-body {
  font-family: var(--k-font-ui);
  font-size: var(--k-fs-sm);
  line-height: 1.5;
  color: var(--k-text);
  overflow-wrap: anywhere;

  @include plane-rich;
}

.ptd__composer {
  display: flex;
  flex-direction: column;
  gap: var(--k-sp-2);
  align-items: flex-end;
}

.ptd__composer-input {
  width: 100%;
  padding: var(--k-sp-2);
  font-family: var(--k-font-ui);
  font-size: var(--k-fs-sm);
  color: var(--k-text);
  background: var(--k-surface2);
  border: var(--k-rule-thin) solid var(--k-line);
  border-radius: var(--k-r);
  resize: vertical;

  &:focus {
    outline: none;
    border-color: var(--k-line-strong);
  }
}

.ptd__worklog {
  display: flex;
  // Wraps because the delete confirm is a block INSIDE the row it is about.
  flex-wrap: wrap;
  align-items: baseline;
  gap: var(--k-sp-2);
  font-family: var(--k-font-ui);
  font-size: var(--k-fs-sm);
  color: var(--k-text);
}

.ptd__worklog-time {
  min-width: 40px;
  color: var(--k-accent);
}

.ptd__worklog-when,
.ptd__worklog-note {
  color: var(--k-faint);
  font-size: var(--k-fs-xs);
}

// Per-entry actions: quiet until the row is hovered, because a worklog list is read far
// more often than it is corrected.
.ptd__worklog-acts {
  display: flex;
  gap: var(--k-sp-2);
  margin-left: auto;
  opacity: 0;
  transition: opacity 0.12s;

  .ptd__worklog:hover &,
  .ptd__worklog:focus-within & {
    opacity: 1;
  }
}

.ptd__worklog-act {
  padding: 0;
  font-family: var(--k-font-ui);
  font-size: var(--k-fs-xs);
  color: var(--k-muted);
  background: none;
  border: none;
  cursor: pointer;

  &:hover:not(:disabled) {
    color: var(--k-text);
  }

  &:disabled {
    opacity: 0.45;
    cursor: default;
  }
}

.ptd__worklog-confirm {
  display: flex;
  flex-direction: column;
  gap: var(--k-sp-2);
  width: 100%;
  padding: var(--k-sp-2) 0;
}

// Which entry the form below is about — stated, because the form is the same one that
// composes a new worklog.
.ptd__logwork-mode {
  align-self: flex-start;
  margin: 0;
  font-size: var(--k-fs-xs);
  color: var(--k-accent);
}

.ptd__logwork {
  display: flex;
  flex-direction: column;
  gap: var(--k-sp-2);
  align-items: flex-end;
  margin-top: var(--k-sp-3);
  padding-top: var(--k-sp-3);
  border-top: var(--k-rule-thin) solid var(--k-line);
}

.ptd__field {
  display: flex;
  flex-direction: column;
  gap: 4px;
  width: 100%;
}

.ptd__field-label {
  font-family: var(--k-font-ui);
  font-size: var(--k-fs-xs);
  color: var(--k-faint);
}

// The duration input and the two date pickers wear one surface: small facts a token holder
// edits in place.
.ptd__estimate,
.ptd__date {
  width: 100%;
  padding: 4px 8px;
  font-size: var(--k-fs-sm);
  color: var(--k-text);
  background: var(--k-surface);
  border: var(--k-rule-thin) solid var(--k-line-strong);
  border-radius: var(--k-r);
  outline: none;
  transition: border-color 0.12s;

  &::placeholder {
    color: var(--k-muted);
  }

  &:focus {
    border-color: var(--k-accent);
  }

  &:disabled {
    opacity: 0.45;
  }
}

// Past due, said in the same colour the board card says it in.
.ptd__date--overdue {
  color: var(--k-danger);
  border-color: color-mix(in srgb, var(--k-danger) 45%, var(--k-line-strong));
}

.ptd__side {
  display: flex;
  flex-direction: column;
  gap: var(--k-sp-3);
}

.ptd__facts {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin: 0;

  div {
    display: flex;
    flex-direction: column;
    gap: 2px;
    font-size: var(--k-fs-sm);
  }

  dt {
    color: var(--k-faint);
    font-size: var(--k-fs-xs);
  }

  dd {
    margin: 0;
    color: var(--k-text);
  }
}

.ptd__status {
  padding: 2px 10px;
  font-family: var(--k-font-ui);
  font-size: var(--k-fs-sm);
  color: var(--k-text);
  background: var(--k-surface2);
  border: var(--k-rule-thin) solid var(--k-line-strong);
  border-radius: var(--k-r-pill);
  cursor: pointer;

  &:disabled {
    cursor: default;
    border-color: var(--k-line);
    color: var(--k-muted);
  }
}

.ptd__labels {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}

.ptd__label {
  padding: 1px 6px;
  font-size: 10px;
  color: var(--k-muted);
  border: var(--k-rule-thin) solid var(--k-line);
  border-radius: var(--k-r-pill);
}

.ptd__link {
  padding: 0;
  font-size: var(--k-fs-sm);
  color: var(--k-accent);
  background: none;
  border: none;
  cursor: pointer;
}

.ptd__actions {
  display: flex;
  flex-direction: column;
  gap: var(--k-sp-2);
  padding-top: var(--k-sp-2);
  border-top: var(--k-rule-thin) solid var(--k-line);
}

.ptd__confirm {
  margin: 0;
  font-family: var(--k-font-ui);
  font-size: var(--k-fs-sm);
  color: var(--k-text);
}

.ptd__confirm-row {
  display: flex;
  gap: var(--k-sp-2);
}

// The «saving this field» mark beside an inline input / inside the status button.
.ptd__spin {
  margin-left: var(--k-sp-2);
  vertical-align: middle;
}
</style>
