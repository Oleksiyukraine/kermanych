<template>
  <KModal
    :model-value="modelValue"
    :title="`${issue.key}`"
    :width="expanded ? 'min(90vw, 1680px)' : '780px'"
    @update:model-value="emit('update:modelValue', $event)"
  >
    <template #head-meta>
      <span class="jtd__headside">
        <span class="jtd__headmeta mono">{{ issue.statusName }}</span>
        <KIconButton
          :title="expanded ? t('jira.ticketDialog.collapse') : t('jira.ticketDialog.expand')"
          @click="expanded = !expanded"
        >{{ expanded ? '⤡' : '⤢' }}</KIconButton>
      </span>
    </template>

    <div class="jtd">
      <div class="jtd__main">
        <h3 class="jtd__summary">{{ issue.summary }}</h3>

        <!-- Sanitized before v-html: the mirror stores what Jira rendered; trust is decided
             here (lib/sanitize-html.ts). -->
        <div v-if="descriptionHtml" class="jtd__desc" v-html="descriptionHtml"></div>
        <p v-else class="jtd__empty mono">{{ t('jira.ticketDialog.emptyDescription') }}</p>

        <div v-if="subtasks.length" class="jtd__section">
          <h4 class="jtd__section-title">{{ t('jira.ticketDialog.subtasks') }}</h4>
          <button
            v-for="sub in subtasks"
            :key="sub.issueId"
            class="jtd__subtask"
            type="button"
            @click="emit('openIssue', sub.key)"
          >
            <span class="mono">{{ sub.key }}</span>
            <span class="jtd__subtask-summary">{{ sub.summary }}</span>
            <span class="jtd__subtask-status mono">{{ sub.statusName }}</span>
          </button>
        </div>

        <div v-if="kids?.attachments.length || canAct" class="jtd__section">
          <h4 class="jtd__section-title">{{ t('jira.ticketDialog.attachments') }}</h4>
          <div v-for="a in kids?.attachments ?? []" :key="a.attachmentId" class="jtd__attachment">
            <button class="jtd__attachment-name" type="button" :disabled="!canAct" @click="download(a)">
              {{ a.filename }}
            </button>
            <span class="jtd__attachment-meta mono">{{ prettySize(a.size) }} · {{ a.authorName }}</span>
          </div>
          <div v-if="canAct" class="jtd__attach-row">
            <input ref="fileInput" type="file" class="jtd__file" @change="upload" />
            <KBtn variant="ghost" :disabled="uploading" @click="fileInput?.click()">
              {{ uploading ? t('jira.ticketDialog.uploading') : t('jira.ticketDialog.addFile') }}
            </KBtn>
          </div>
        </div>

        <div class="jtd__section">
          <div class="jtd__tabs">
            <button
              class="jtd__tab"
              :class="{ 'jtd__tab--on': tab === 'comments' }"
              type="button"
              @click="tab = 'comments'"
            >{{ t('jira.ticketDialog.comments') }}{{ kids?.comments.length ? ` · ${kids.comments.length}` : '' }}</button>
            <button
              class="jtd__tab"
              :class="{ 'jtd__tab--on': tab === 'worklogs' }"
              type="button"
              @click="tab = 'worklogs'"
            >{{ t('jira.ticketDialog.worklogs') }}{{ kids?.worklogs.length ? ` · ${kids.worklogs.length}` : '' }}</button>
          </div>

          <template v-if="tab === 'comments'">
            <div v-for="c in kids?.comments ?? []" :key="c.commentId" class="jtd__comment">
              <div class="jtd__comment-head">
                <KAvatar :name="c.authorName || '?'" :avatar-url="c.authorAvatar || undefined" :size="18" />
                <span class="jtd__comment-author">{{ c.authorName }}</span>
                <span class="jtd__comment-time mono">{{ shortTime(c.jiraCreatedAt) }}</span>
              </div>
              <div class="jtd__comment-body" v-html="sanitizeJiraHtml(c.bodyHtml)"></div>
            </div>
            <p v-if="!kids?.comments.length" class="jtd__empty mono">{{ t('jira.ticketDialog.noComments') }}</p>

            <div v-if="canAct" class="jtd__composer">
              <textarea
                v-model="commentDraft"
                class="jtd__composer-input"
                rows="3"
                :placeholder="t('jira.ticketDialog.commentPlaceholder')"
              ></textarea>
              <KBtn variant="secondary" :disabled="!commentDraft.trim() || commenting" @click="sendComment">
                {{ commenting ? t('jira.ticketDialog.sending') : t('jira.ticketDialog.comment') }}
              </KBtn>
            </div>
          </template>

          <template v-else>
            <div v-for="w in kids?.worklogs ?? []" :key="w.worklogId" class="jtd__worklog">
              <span class="jtd__worklog-time mono">{{ w.timeSpent }}</span>
              <span class="jtd__worklog-author">{{ w.authorName }}</span>
              <span class="jtd__worklog-when mono">{{ shortTime(w.startedAt) }}</span>
              <span v-if="w.commentHtml" class="jtd__worklog-note">{{ w.commentHtml }}</span>
              <!-- Only the controls Jira said yes to: own-versus-all worklog permissions,
                   answered per entry by whose accountId wrote it. -->
              <span class="jtd__worklog-acts">
                <button
                  v-if="mayEditWorklog(w)"
                  class="jtd__worklog-act"
                  type="button"
                  :disabled="logging"
                  @click="startEditWorklog(w)"
                >{{ editingWorklogId === w.worklogId ? t('jira.ticketDialog.worklogEditing') : t('jira.ticketDialog.edit') }}</button>
                <button
                  v-if="mayDeleteWorklog(w)"
                  class="jtd__worklog-act"
                  type="button"
                  :disabled="logging"
                  @click="askDeleteWorklog(w.worklogId)"
                >{{ t('jira.ticketDialog.delete') }}</button>
              </span>

              <!-- Jira asks the same estimate question when an entry goes away; here
                   `manual` is «increase by», because deleting gives the time back. -->
              <div v-if="deletingWorklogId === w.worklogId" class="jtd__worklog-confirm">
                <p class="jtd__confirm">{{ t('jira.ticketDialog.deleteWorklogConfirm') }}</p>
                <div class="jtd__logwork-row">
                  <label class="jtd__field">
                    <span class="jtd__field-label">{{ t('jira.ticketDialog.remainingEstimate') }}</span>
                    <KSelect
                      :model-value="deleteAdjust"
                      :options="DELETE_ADJUST_OPTIONS"
                      :disabled="logging"
                      @update:model-value="pickDeleteAdjust"
                    />
                  </label>
                  <label v-if="deleteAdjustNeedsValue" class="jtd__field">
                    <span class="jtd__field-label">{{ deleteAdjustValueLabel }}</span>
                    <input
                      v-model="deleteAdjustValue"
                      class="jtd__estimate mono"
                      :placeholder="t('jira.ticketDialog.estimatePlaceholder')"
                      :disabled="logging"
                    />
                  </label>
                </div>
                <div class="jtd__confirm-row">
                  <KBtn variant="ghost" :disabled="logging" @click="deletingWorklogId = null">{{ t('jira.ticketDialog.no') }}</KBtn>
                  <KBtn variant="secondary" :disabled="logging" @click="deleteWorklog(w.worklogId)">
                    {{ logging ? '…' : t('jira.ticketDialog.yesDelete') }}
                  </KBtn>
                </div>
              </div>
            </div>
            <p v-if="!kids?.worklogs.length" class="jtd__empty mono">{{ t('jira.ticketDialog.noWorklogs') }}</p>

            <!-- Jira's «Log work», field for field: duration, when it started, what it did
                 to the remaining estimate, and an optional note. The entry lands in Jira
                 under this member's own name.

                 The SAME form edits an existing entry — that is what Jira's own dialog is
                 — with one difference Jira imposes: its update endpoint has no relative
                 estimate move, so «Зменшити на» is not on offer while editing. -->
            <div v-if="canAct" class="jtd__logwork">
              <p v-if="editingWorklogId" class="jtd__logwork-mode mono">{{ t('jira.ticketDialog.worklogEditMode') }}</p>
              <div class="jtd__logwork-row">
                <label class="jtd__field">
                  <span class="jtd__field-label">{{ t('jira.ticketDialog.spent') }}</span>
                  <input
                    v-model="workTime"
                    class="jtd__estimate mono"
                    :placeholder="t('jira.ticketDialog.timePlaceholder')"
                    :disabled="logging"
                    v-tip="t('jira.ticketDialog.timeFormatTip')"
                  />
                </label>
                <label class="jtd__field">
                  <span class="jtd__field-label">{{ t('jira.ticketDialog.start') }}</span>
                  <input v-model="workStarted" type="datetime-local" class="jtd__date mono" :disabled="logging" />
                </label>
              </div>
              <div class="jtd__logwork-row">
                <label class="jtd__field">
                  <span class="jtd__field-label">{{ t('jira.ticketDialog.remainingEstimate') }}</span>
                  <KSelect
                    :model-value="workAdjust"
                    :options="adjustOptions"
                    :disabled="logging"
                    @update:model-value="pickAdjust"
                  />
                </label>
                <label v-if="adjustNeedsValue" class="jtd__field">
                  <span class="jtd__field-label">{{ adjustValueLabel }}</span>
                  <input
                    v-model="workAdjustValue"
                    class="jtd__estimate mono"
                    :placeholder="t('jira.ticketDialog.estimatePlaceholder')"
                    :disabled="logging"
                  />
                </label>
              </div>
              <textarea
                v-model="workComment"
                class="jtd__composer-input"
                rows="2"
                :placeholder="t('jira.ticketDialog.workNotePlaceholder')"
              ></textarea>
              <div class="jtd__confirm-row">
                <KBtn v-if="editingWorklogId" variant="ghost" :disabled="logging" @click="resetWorkDraft">
                  {{ t('jira.ticketDialog.cancel') }}
                </KBtn>
                <KBtn variant="secondary" :disabled="!workTime.trim() || logging" @click="submitWork">
                  {{ submitLabel }}
                </KBtn>
              </div>
            </div>
          </template>
        </div>
      </div>

      <aside class="jtd__side">
        <dl class="jtd__facts">
          <div>
            <dt>{{ t('jira.ticketDialog.status') }}</dt>
            <dd>
              <button
                class="jtd__status"
                type="button"
                :disabled="!canAct"
                v-tip="canAct ? t('jira.ticketDialog.transitionTip') : readOnlyHint"
                @click="openTransition"
              >{{ issue.statusName }}</button>
            </dd>
          </div>
          <div v-if="issue.typeName"><dt>{{ t('jira.ticketDialog.type') }}</dt><dd class="jtd__fact-icon"><img v-if="issue.typeIcon" :src="issue.typeIcon" alt="" />{{ issue.typeName }}</dd></div>
          <div v-if="canAct || issue.priorityName">
            <dt>{{ t('jira.ticketDialog.priority') }}</dt>
            <dd v-if="canAct && priorityOptions.length">
              <KSelect
                :model-value="priorityCurrent"
                :options="priorityOptions"
                :disabled="savingField === 'priority'"
                placeholder="—"
                @update:model-value="pickPriority"
              />
            </dd>
            <dd v-else class="jtd__fact-icon"><img v-if="issue.priorityIcon" :src="issue.priorityIcon" alt="" />{{ issue.priorityName || '—' }}</dd>
          </div>
          <div>
            <dt>{{ t('jira.ticketDialog.estimate') }}</dt>
            <dd>
              <input
                v-if="canAct"
                v-model="estimateDraft"
                class="jtd__estimate mono"
                :placeholder="t('jira.ticketDialog.estimateBigPlaceholder')"
                :disabled="savingField === 'estimate'"
                v-tip="t('jira.ticketDialog.estimateTip')"
                @keydown.enter.prevent="blurTarget($event)"
                @blur="saveEstimate"
              />
              <span v-else>{{ issue.originalEstimate || '—' }}</span>
            </dd>
          </div>
          <!-- Jira's other two time-tracking counters, read-only because only a worklog
               moves them: they appear once Jira actually holds one, so a ticket nobody has
               logged against does not carry two blank rows. -->
          <div v-if="issue.timeSpent"><dt>{{ t('jira.ticketDialog.spent') }}</dt><dd class="mono">{{ issue.timeSpent }}</dd></div>
          <div v-if="issue.remainingEstimate"><dt>{{ t('jira.ticketDialog.remaining') }}</dt><dd class="mono">{{ issue.remainingEstimate }}</dd></div>
          <!-- The start row appears only where there is something to show: a site without
               a «Start date» field would otherwise offer an input whose every save is a
               refusal, and a blank «Початок —» beside it. -->
          <div v-if="issue.startDate || (canAct && editorOptions.startDateSupported)">
            <dt>{{ t('jira.ticketDialog.start') }}</dt>
            <dd>
              <input
                v-if="canAct && editorOptions.startDateSupported"
                v-model="startDraft"
                type="date"
                class="jtd__date mono"
                :disabled="savingField === 'startDate'"
                v-tip="t('jira.ticketDialog.startDateTip')"
                @change="saveStartDate"
              />
              <span v-else>{{ issue.startDate || '—' }}</span>
            </dd>
          </div>
          <div>
            <dt>{{ t('jira.ticketDialog.due') }}</dt>
            <dd>
              <input
                v-if="canAct"
                v-model="dueDraft"
                type="date"
                class="jtd__date mono"
                :class="{ 'jtd__date--overdue': overdue }"
                :disabled="savingField === 'dueDate'"
                v-tip="overdue ? t('jira.ticketDialog.dueTipOverdue') : t('jira.ticketDialog.dueTip')"
                @change="saveDueDate"
              />
              <span v-else :class="{ 'jtd__date--overdue': overdue }">{{ issue.dueDate || '—' }}</span>
            </dd>
          </div>
          <div>
            <dt>{{ t('jira.ticketDialog.assignee') }}</dt>
            <dd v-if="canAct && assigneeOptions.length > 1">
              <KSelect
                :model-value="assigneeCurrent"
                :options="assigneeOptions"
                :disabled="savingField === 'assignee'"
                :placeholder="t('jira.ticketDialog.unassigned')"
                searchable
                @update:model-value="pickAssignee"
              />
            </dd>
            <dd v-else>{{ issue.assigneeName ?? t('jira.ticketDialog.unassigned') }}</dd>
          </div>
          <div v-if="issue.reporterName"><dt>{{ t('jira.ticketDialog.reporter') }}</dt><dd>{{ issue.reporterName }}</dd></div>
          <div v-if="issue.labels.length">
            <dt>{{ t('jira.ticketDialog.labels') }}</dt>
            <dd class="jtd__labels">
              <span v-for="label in issue.labels" :key="label" class="jtd__label mono">{{ label }}</span>
            </dd>
          </div>
          <div v-if="issue.parentKey">
            <dt>{{ t('jira.ticketDialog.parent') }}</dt>
            <dd><button class="jtd__link mono" type="button" @click="emit('openIssue', issue.parentKey!)">{{ issue.parentKey }}</button></dd>
          </div>
        </dl>

        <div class="jtd__actions">
          <KBtn
            variant="primary"
            :disabled="!canLaunch"
            :title="launchHint"
            @click="emit('launch')"
          >{{ t('jira.ticketDialog.launch') }}</KBtn>
          <KBtn variant="secondary" :disabled="!canAct" :title="canAct ? '' : readOnlyHint" @click="emit('edit')">{{ t('jira.ticketDialog.edit') }}</KBtn>
          <KBtn variant="ghost" :disabled="!canAct" :title="canAct ? '' : readOnlyHint" @click="emit('subtask')">{{ t('jira.ticketDialog.addSubtask') }}</KBtn>
          <KBtn v-if="!confirmingDelete" variant="ghost" :disabled="!canAct" :title="canAct ? '' : readOnlyHint" @click="confirmingDelete = true">{{ t('jira.ticketDialog.delete') }}</KBtn>
          <template v-else>
            <p class="jtd__confirm">{{ t('jira.ticketDialog.deleteConfirm', { key: issue.key }) }}</p>
            <div class="jtd__confirm-row">
              <KBtn variant="ghost" @click="confirmingDelete = false">{{ t('jira.ticketDialog.no') }}</KBtn>
              <KBtn variant="secondary" :disabled="deleting" @click="doDelete">{{ deleting ? '…' : t('jira.ticketDialog.yesDelete') }}</KBtn>
            </div>
          </template>
        </div>
      </aside>
    </div>

    <JiraStatusPickDialog
      v-model="transitionOpen"
      :title="t('jira.ticketDialog.statusTitle', { key: issue.key })"
      :options="transitionOptions"
      :busy="transitioning"
      @pick="applyTransition"
    />
  </KModal>
</template>

<script setup lang="ts">
// The mirrored ticket, whole: description, standard fields (custom fields are v1
// read-only by design and simply not mirrored), subtasks, attachments, comments and
// worklogs. Every ACTION goes to Jira under this member's token and lands back in the
// mirror; a tokenless member sees everything and can touch nothing — each control says
// why instead of hiding.
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import type { JiraAttachment, JiraIssue, JiraWorklog } from '@kermanych/cloud';
import KAvatar from 'components/kit/KAvatar.vue';
import KBtn from 'components/kit/KBtn.vue';
import KModal from 'components/kit/KModal.vue';
import KIconButton from 'components/kit/KIconButton.vue';
import KSelect, { type KSelectOption } from 'components/kit/KSelect.vue';
import JiraStatusPickDialog from './JiraStatusPickDialog.vue';
import {
  api,
  type JiraAssignableUser,
  type JiraEditorOptions,
  type JiraIssueDraftWire,
  type JiraWorklogAdjustWire,
  type JiraWorklogDraftWire,
} from '../../lib/api';
import { sanitizeJiraHtml } from '../../lib/sanitize-html';
import {
  dateChip,
  localDateTimeValue,
  subtasksOf,
  todayIso,
  worklogStartedInstant,
  type JiraTransitionView,
} from '../../lib/jira-view';
import { useJira } from 'stores/jira';
import { useOrchestrator } from 'stores/orchestrator';

const { t } = useI18n();
const readOnlyHint = computed(() => t('jira.ticketDialog.readOnlyHint'));

const props = defineProps<{ modelValue: boolean; issue: JiraIssue; workspaceId: string }>();
const emit = defineEmits<{
  'update:modelValue': [value: boolean];
  launch: [];
  edit: [];
  subtask: [];
  openIssue: [key: string];
  deleted: [];
}>();

const jira = useJira();
const local = useOrchestrator();

const tab = ref<'comments' | 'worklogs'>('comments');
// The wide mode: the same ticket at ~90% of the screen, for descriptions that need room.
const expanded = ref(false);
const commentDraft = ref('');
const commenting = ref(false);
const uploading = ref(false);
const deleting = ref(false);
const confirmingDelete = ref(false);
const fileInput = ref<HTMLInputElement | null>(null);

const transitionOpen = ref(false);
const transitionOptions = ref<JiraTransitionView[]>([]);
const transitioning = ref(false);

// ── logging work ─────────────────────────────────────────────────────────────
// Jira's «Log work» dialog reproduced: the duration, the moment it started, and what the
// entry does to the remaining estimate — Jira's own four-way choice, whose two «by how
// much» modes grow a second input. The same form edits an existing entry.
//
// Three option sets, because Jira's three worklog endpoints accept three different
// vocabularies: logging can REDUCE the estimate by an amount, deleting can INCREASE it by
// one (the entry's time comes back), and updating offers no relative move at all.
const ADJUST_OPTIONS = computed<KSelectOption[]>(() => [
  { value: 'auto', label: t('jira.ticketDialog.adjustAuto') },
  { value: 'leave', label: t('jira.ticketDialog.adjustLeave') },
  { value: 'new', label: t('jira.ticketDialog.adjustNew') },
  { value: 'manual', label: t('jira.ticketDialog.adjustManual') },
]);

const EDIT_ADJUST_OPTIONS = computed<KSelectOption[]>(() => ADJUST_OPTIONS.value.filter((o) => o.value !== 'manual'));

const DELETE_ADJUST_OPTIONS = computed<KSelectOption[]>(() => [
  { value: 'auto', label: t('jira.ticketDialog.deleteAdjustAuto') },
  { value: 'leave', label: t('jira.ticketDialog.adjustLeave') },
  { value: 'new', label: t('jira.ticketDialog.adjustNew') },
  { value: 'manual', label: t('jira.ticketDialog.deleteAdjustManual') },
]);

type AdjustMode = JiraWorklogAdjustWire['mode'];

const workTime = ref('');
const workStarted = ref('');
const workComment = ref('');
const workAdjust = ref<AdjustMode>('auto');
const workAdjustValue = ref('');
const logging = ref(false);
// Which existing entry the form is editing (null = it is composing a new one), and which
// one is asking to be deleted. Separate: a delete confirm is a per-row question, while
// the edit takes over the one form at the bottom.
const editingWorklogId = ref<string | null>(null);
const deletingWorklogId = ref<string | null>(null);
const deleteAdjust = ref<AdjustMode>('auto');
const deleteAdjustValue = ref('');

// ── inline facts editing: priority / assignee / estimate / start & due date ───
// One-field drafts through PUT /jira/issues — the same endpoint the full editor uses,
// so Jira's own validation (estimate format, screens) is the only validation.
const editorOptions = ref<JiraEditorOptions>({
  issueTypes: [],
  priorities: [],
  startDateSupported: false,
  // No identity and no permissions until the api answers — so no entry reads as «mine»
  // and no edit/delete control is offered. The read-only default is the safe one.
  myAccountId: '',
  worklog: { editOwn: false, editAll: false, deleteOwn: false, deleteAll: false },
});
const assignable = ref<JiraAssignableUser[]>([]);
const estimateDraft = ref('');
const startDraft = ref('');
const dueDraft = ref('');
const savingField = ref<'priority' | 'assignee' | 'estimate' | 'startDate' | 'dueDate' | null>(null);

const priorityOptions = computed<KSelectOption[]>(() =>
  editorOptions.value.priorities.map((p) => ({ value: p.id, label: p.name })),
);
// The mirror stores the NAME (Jira's payload does); the picker needs the id.
const priorityCurrent = computed(
  () => editorOptions.value.priorities.find((p) => p.name === props.issue.priorityName)?.id ?? '',
);

const assigneeOptions = computed<KSelectOption[]>(() => [
  { value: '', label: t('jira.ticketDialog.unassigned') },
  ...assignable.value.map((u) => ({ value: u.accountId, label: u.displayName })),
]);
const assigneeCurrent = computed(() => props.issue.assigneeAccountId ?? '');

const canAct = computed(() => jira.tokenPresent);
const kids = computed(() => jira.children[props.issue.issueId]);
const descriptionHtml = computed(() => sanitizeJiraHtml(props.issue.descriptionHtml));
const subtasks = computed(() => subtasksOf(jira.issues, props.issue.key));

// «Встановити» and the relative move are the modes that carry a duration of their own;
// the other two adjust the estimate without one.
const adjustOptions = computed(() => (editingWorklogId.value ? EDIT_ADJUST_OPTIONS.value : ADJUST_OPTIONS.value));
const adjustNeedsValue = computed(() => workAdjust.value === 'new' || workAdjust.value === 'manual');
const adjustValueLabel = computed(() => (workAdjust.value === 'new' ? t('jira.ticketDialog.adjustValueNew') : t('jira.ticketDialog.adjustManual')));
const submitLabel = computed(() => {
  if (logging.value) return editingWorklogId.value ? t('jira.ticketDialog.savingWorklog') : t('jira.ticketDialog.loggingWork');
  return editingWorklogId.value ? t('jira.ticketDialog.saveWorklog') : t('jira.ticketDialog.logWork');
});

const deleteAdjustNeedsValue = computed(
  () => deleteAdjust.value === 'new' || deleteAdjust.value === 'manual',
);
const deleteAdjustValueLabel = computed(() =>
  deleteAdjust.value === 'new' ? t('jira.ticketDialog.adjustValueNew') : t('jira.ticketDialog.deleteAdjustManual'),
);

// Whose entry it is, in Jira's terms — and therefore which of Jira's two permissions
// applies. A blank author (a row mirrored before the column existed, or a deleted Jira
// account) is NOT mine: it then needs the all-worklogs permission, which is the
// conservative reading and self-heals on the next poll.
function isMyWorklog(w: JiraWorklog): boolean {
  const me = editorOptions.value.myAccountId;
  return !!me && w.authorAccountId === me;
}

function mayEditWorklog(w: JiraWorklog): boolean {
  const { editOwn, editAll } = editorOptions.value.worklog;
  return isMyWorklog(w) ? editOwn || editAll : editAll;
}

function mayDeleteWorklog(w: JiraWorklog): boolean {
  const { deleteOwn, deleteAll } = editorOptions.value.worklog;
  return isMyWorklog(w) ? deleteOwn || deleteAll : deleteAll;
}

// The card's own verdict, reused so the dialog cannot disagree with the board about a
// late ticket.
const overdue = computed(() => dateChip(props.issue, todayIso())?.tone === 'overdue');

// Launch is gated the native way (assignment is not: a Jira ticket has no Kermanych
// assignee): a running shadow task means «уже виконується».
const running = computed(() => {
  const taskId = props.issue.taskId;
  return !!taskId && local.sessions.some((s) => s.taskId === taskId);
});
const canLaunch = computed(() => canAct.value && !running.value);
const launchHint = computed(() => {
  if (!canAct.value) return readOnlyHint.value;
  if (running.value) return t('jira.ticketDialog.launchHintRunning');
  return t('jira.ticketDialog.launchHintReady');
});

// Fresh detail on every open: live refresh through the api when a token is here (comments
// fresher than the 30 s tick), the mirror's cache otherwise.
watch(
  () => props.modelValue,
  (open) => {
    if (!open) return;
    tab.value = 'comments';
    confirmingDelete.value = false;
    estimateDraft.value = props.issue.originalEstimate;
    startDraft.value = props.issue.startDate;
    dueDraft.value = props.issue.dueDate;
    resetWorkDraft();
    deletingWorklogId.value = null;
    void jira.loadChildren(props.issue.issueId);
    void jira.refreshIssue(props.workspaceId, props.issue.key);
    if (canAct.value) void loadEditorLists();
  },
);

// Realtime/refresh may change the issue under an open dialog; the inline inputs must
// follow unless the user is mid-save on that very field (their draft would be stomped by
// the pre-save row).
watch(
  () => props.issue,
  (issue) => {
    if (savingField.value !== 'estimate') estimateDraft.value = issue.originalEstimate;
    if (savingField.value !== 'startDate') startDraft.value = issue.startDate;
    if (savingField.value !== 'dueDate') dueDraft.value = issue.dueDate;
  },
);

// Failure degrades to the read-only facts — the selects render only on loaded lists.
async function loadEditorLists(): Promise<void> {
  try {
    const [opts, users] = await Promise.all([
      api.jiraEditorOptions(props.workspaceId),
      api.jiraAssignableUsers(props.workspaceId, ''),
    ]);
    editorOptions.value = opts;
    assignable.value = users;
  } catch {
    /* keep static facts */
  }
}

async function saveField(field: NonNullable<typeof savingField.value>, draft: JiraIssueDraftWire): Promise<void> {
  savingField.value = field;
  try {
    jira.upsert(await api.jiraEditIssue(props.workspaceId, props.issue.key, draft));
  } catch (e) {
    local.notify(e instanceof Error ? e.message : String(e), 'error');
    // A refused write leaves the mirror row as the truth: every draft returns to it.
    estimateDraft.value = props.issue.originalEstimate;
    startDraft.value = props.issue.startDate;
    dueDraft.value = props.issue.dueDate;
  } finally {
    savingField.value = null;
  }
}

function pickPriority(id: string): void {
  if (id && id !== priorityCurrent.value) void saveField('priority', { priorityId: id });
}

function pickAssignee(id: string): void {
  if (id !== assigneeCurrent.value) void saveField('assignee', { assigneeAccountId: id || null });
}

async function saveEstimate(): Promise<void> {
  if (estimateDraft.value.trim() === props.issue.originalEstimate) return;
  await saveField('estimate', { originalEstimate: estimateDraft.value.trim() });
}

// Both dates go to Jira exactly as <input type="date"> spells them (YYYY-MM-DD), and a
// cleared input is a cleared date in Jira.
async function saveStartDate(): Promise<void> {
  if (startDraft.value === props.issue.startDate) return;
  await saveField('startDate', { startDate: startDraft.value });
}

async function saveDueDate(): Promise<void> {
  if (dueDraft.value === props.issue.dueDate) return;
  await saveField('dueDate', { dueDate: dueDraft.value });
}

function blurTarget(e: Event): void {
  (e.target as HTMLElement).blur();
}

async function openTransition(): Promise<void> {
  try {
    transitionOptions.value = await api.jiraTransitions(props.workspaceId, props.issue.key);
    transitionOpen.value = true;
  } catch (e) {
    local.notify(e instanceof Error ? e.message : String(e), 'error');
  }
}

async function applyTransition(t: JiraTransitionView): Promise<void> {
  transitioning.value = true;
  try {
    const updated = await api.jiraTransition(props.workspaceId, props.issue.key, t.id);
    jira.upsert(updated);
    transitionOpen.value = false;
  } catch (e) {
    local.notify(e instanceof Error ? e.message : String(e), 'error');
  } finally {
    transitioning.value = false;
  }
}

async function sendComment(): Promise<void> {
  commenting.value = true;
  try {
    const updated = await api.jiraComment(props.workspaceId, props.issue.key, commentDraft.value.trim());
    jira.upsert(updated);
    commentDraft.value = '';
    await jira.loadChildren(props.issue.issueId);
  } catch (e) {
    local.notify(e instanceof Error ? e.message : String(e), 'error');
  } finally {
    commenting.value = false;
  }
}

// A fresh «Log work» form: blank duration and note, the start prefilled with now (Jira's
// own default), the estimate left to Jira's automatic adjustment — and NOT editing
// anything, so this doubles as «cancel the edit».
function resetWorkDraft(): void {
  editingWorklogId.value = null;
  workTime.value = '';
  workStarted.value = localDateTimeValue();
  workComment.value = '';
  workAdjust.value = 'auto';
  workAdjustValue.value = '';
}

function pickAdjust(mode: string): void {
  workAdjust.value = mode as AdjustMode;
}

function pickDeleteAdjust(mode: string): void {
  deleteAdjust.value = mode as AdjustMode;
}

// The form takes over an existing entry: its own values, and Jira's automatic
// recalculation as the estimate default — the same thing Jira's edit dialog opens with.
// The stored start is an INSTANT, shown back on the user's own clock.
function startEditWorklog(w: JiraWorklog): void {
  deletingWorklogId.value = null;
  editingWorklogId.value = w.worklogId;
  workTime.value = w.timeSpent;
  workStarted.value = localDateTimeValue(new Date(w.startedAt));
  workComment.value = w.commentHtml;
  workAdjust.value = 'auto';
  workAdjustValue.value = '';
}

function askDeleteWorklog(worklogId: string): void {
  deletingWorklogId.value = worklogId;
  deleteAdjust.value = 'auto';
  deleteAdjustValue.value = '';
}

// The estimate adjustment as the wire takes it, or `undefined` when the picked mode needs
// a duration the user has not typed — the caller then says so instead of sending it.
function wireAdjust(mode: AdjustMode, raw: string, needsValue: boolean): JiraWorklogAdjustWire | null {
  if (!needsValue) return { mode: mode as 'auto' | 'leave' };
  const value = raw.trim();
  return value ? { mode: mode as 'new' | 'manual', value } : null;
}

// One worklog written to Jira under this member's token, then the refreshed issue into
// the store: «Витрачено»/«Залишилось» move with the write, and the children refetch
// brings the entry itself into the list. Creating and editing differ in one call.
async function submitWork(): Promise<void> {
  const timeSpent = workTime.value.trim();
  if (!timeSpent) return;
  // Said here rather than sent: an adjustment with nothing to adjust by would come back
  // as Jira's own refusal about a query parameter the user never saw.
  const adjust = wireAdjust(workAdjust.value, workAdjustValue.value, adjustNeedsValue.value);
  if (!adjust) {
    local.notify(t('jira.ticketDialog.notifyAdjustNeedsValue'), 'error');
    return;
  }
  const started = worklogStartedInstant(workStarted.value);
  const comment = workComment.value.trim();
  const editing = editingWorklogId.value;
  // An edit must carry its start: an omitted one would restamp the entry to now, and
  // «I fixed the duration» is not «this happened just now».
  if (editing && !started) {
    local.notify(t('jira.ticketDialog.notifyStartRequired'), 'error');
    return;
  }
  const draft: JiraWorklogDraftWire = {
    timeSpent,
    ...(started ? { started } : {}),
    ...(comment ? { comment } : {}),
    adjust,
  };
  logging.value = true;
  try {
    jira.upsert(
      editing
        ? await api.jiraEditWorklog(props.workspaceId, props.issue.key, editing, draft)
        : await api.jiraLogWork(props.workspaceId, props.issue.key, draft),
    );
    resetWorkDraft();
    await jira.loadChildren(props.issue.issueId);
  } catch (e) {
    local.notify(e instanceof Error ? e.message : String(e), 'error');
  } finally {
    logging.value = false;
  }
}

async function deleteWorklog(worklogId: string): Promise<void> {
  const adjust = wireAdjust(deleteAdjust.value, deleteAdjustValue.value, deleteAdjustNeedsValue.value);
  if (!adjust) {
    local.notify(t('jira.ticketDialog.notifyAdjustNeedsValue'), 'error');
    return;
  }
  logging.value = true;
  try {
    jira.upsert(await api.jiraDeleteWorklog(props.workspaceId, props.issue.key, worklogId, adjust));
    deletingWorklogId.value = null;
    // A deleted entry must not stay loaded in the form behind it.
    if (editingWorklogId.value === worklogId) resetWorkDraft();
    await jira.loadChildren(props.issue.issueId);
  } catch (e) {
    local.notify(e instanceof Error ? e.message : String(e), 'error');
  } finally {
    logging.value = false;
  }
}

async function upload(e: Event): Promise<void> {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = '';
  if (!file) return;
  uploading.value = true;
  try {
    const buf = await file.arrayBuffer();
    let binary = '';
    const bytes = new Uint8Array(buf);
    for (const b of bytes) binary += String.fromCharCode(b);
    const updated = await api.jiraUploadAttachment(
      props.workspaceId,
      props.issue.key,
      file.name,
      btoa(binary),
      file.type,
    );
    jira.upsert(updated);
    await jira.loadChildren(props.issue.issueId);
  } catch (err) {
    local.notify(err instanceof Error ? err.message : String(err), 'error');
  } finally {
    uploading.value = false;
  }
}

async function download(a: JiraAttachment): Promise<void> {
  try {
    const blob = await api.jiraDownloadAttachment(props.workspaceId, a.attachmentId);
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = a.filename;
    link.click();
    URL.revokeObjectURL(url);
  } catch (e) {
    local.notify(e instanceof Error ? e.message : String(e), 'error');
  }
}

async function doDelete(): Promise<void> {
  deleting.value = true;
  try {
    await api.jiraDeleteIssue(props.workspaceId, props.issue.key);
    jira.drop(props.issue.issueId);
    emit('update:modelValue', false);
    emit('deleted');
  } catch (e) {
    local.notify(e instanceof Error ? e.message : String(e), 'error');
  } finally {
    deleting.value = false;
  }
}

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
// Jira's rendered HTML (descriptions, comment bodies) restyled to Jira's own proportions
// on the modal's type ramp. Em-based so the same rules fit the description's base size
// and the comments' smaller one. Without this, h1/h2 from a ticket land at the page's
// browser-default heading scale and dwarf the dialog.
@mixin jira-rich {
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

  // A nested list closes with its parent item, not with a paragraph's worth of air.
  :deep(li > ul),
  :deep(li > ol) {
    margin-bottom: 0;
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

  // display:block + max-content: a Jira table wider than the column scrolls in place
  // instead of blowing the grid open.
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

.jtd {
  display: grid;
  grid-template-columns: 1fr 220px;
  gap: var(--k-sp-4);
}

.jtd__headmeta {
  font-size: var(--k-fs-xs);
  color: var(--k-faint);
}

.jtd__headside {
  display: flex;
  align-items: center;
  gap: var(--k-sp-2);
}

.jtd__main {
  display: flex;
  flex-direction: column;
  gap: var(--k-sp-3);
  min-width: 0;
}

.jtd__summary {
  margin: 0;
  font-family: var(--k-font-ui);
  font-size: var(--k-fs-lg);
  font-weight: var(--k-fw-semibold);
  color: var(--k-text);
}

.jtd__desc {
  font-family: var(--k-font-ui);
  font-size: var(--k-fs-base);
  line-height: 1.5;
  color: var(--k-text);
  overflow-wrap: anywhere;

  @include jira-rich;
}

.jtd__empty {
  margin: 0;
  font-size: var(--k-fs-sm);
  color: var(--k-faint);
}

.jtd__section {
  display: flex;
  flex-direction: column;
  gap: var(--k-sp-2);
  padding-top: var(--k-sp-2);
  border-top: var(--k-rule-thin) solid var(--k-line);
}

.jtd__section-title {
  margin: 0;
  font-family: var(--k-font-ui);
  font-size: var(--k-fs-sm);
  font-weight: var(--k-fw-medium);
  color: var(--k-muted);
}

.jtd__subtask {
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

.jtd__subtask-summary {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.jtd__subtask-status {
  font-size: var(--k-fs-xs);
  color: var(--k-faint);
}

.jtd__attachment {
  display: flex;
  align-items: baseline;
  gap: var(--k-sp-2);
}

.jtd__attachment-name {
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

.jtd__attachment-meta {
  font-size: var(--k-fs-xs);
  color: var(--k-faint);
}

.jtd__attach-row {
  display: flex;
}

.jtd__file {
  display: none;
}

.jtd__tabs {
  display: flex;
  gap: var(--k-sp-2);
}

.jtd__tab {
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

.jtd__comment {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.jtd__comment-head {
  display: flex;
  align-items: center;
  gap: var(--k-sp-2);
}

.jtd__comment-author {
  font-family: var(--k-font-ui);
  font-size: var(--k-fs-sm);
  font-weight: var(--k-fw-medium);
  color: var(--k-text);
}

.jtd__comment-time {
  font-size: var(--k-fs-xs);
  color: var(--k-faint);
}

.jtd__comment-body {
  font-family: var(--k-font-ui);
  font-size: var(--k-fs-sm);
  line-height: 1.5;
  color: var(--k-text);
  overflow-wrap: anywhere;

  @include jira-rich;
}

.jtd__composer {
  display: flex;
  flex-direction: column;
  gap: var(--k-sp-2);
  align-items: flex-end;
}

.jtd__composer-input {
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

.jtd__worklog {
  display: flex;
  // Wraps because the delete confirm is a block INSIDE the row it is about — the question
  // belongs beside the entry, not at the bottom of the tab.
  flex-wrap: wrap;
  align-items: baseline;
  gap: var(--k-sp-2);
  font-family: var(--k-font-ui);
  font-size: var(--k-fs-sm);
  color: var(--k-text);
}

.jtd__worklog-time {
  min-width: 40px;
  color: var(--k-accent);
}

.jtd__worklog-when,
.jtd__worklog-note {
  color: var(--k-faint);
  font-size: var(--k-fs-xs);
}

// Per-entry actions: quiet until the row is hovered, because a worklog list is read far
// more often than it is corrected.
.jtd__worklog-acts {
  display: flex;
  gap: var(--k-sp-2);
  margin-left: auto;
  opacity: 0;
  transition: opacity 0.12s;

  .jtd__worklog:hover &,
  .jtd__worklog:focus-within & {
    opacity: 1;
  }
}

.jtd__worklog-act {
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

.jtd__worklog-confirm {
  display: flex;
  flex-direction: column;
  gap: var(--k-sp-2);
  width: 100%;
  padding: var(--k-sp-2) 0;
}

// Which entry the form below is about — stated, because the form is the same one that
// composes a new worklog.
.jtd__logwork-mode {
  align-self: flex-start;
  font-size: var(--k-fs-xs);
  color: var(--k-accent);
}

// The «Log work» form: two two-up rows of small labelled inputs above the note and the
// button, so the whole of Jira's dialog fits under the worklog list without a modal of
// its own. Same right-aligned action as the comment composer.
.jtd__logwork {
  display: flex;
  flex-direction: column;
  gap: var(--k-sp-2);
  align-items: flex-end;
  margin-top: var(--k-sp-3);
  padding-top: var(--k-sp-3);
  border-top: var(--k-rule-thin) solid var(--k-line);
}

.jtd__logwork-row {
  display: flex;
  gap: var(--k-sp-2);
  width: 100%;
}

.jtd__field {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}

.jtd__field-label {
  font-family: var(--k-font-ui);
  font-size: var(--k-fs-xs);
  color: var(--k-faint);
}

// The two date pickers wear the estimate input's surface: same row, same weight — three
// small facts a token holder edits in place.
.jtd__estimate,
.jtd__date {
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
.jtd__date--overdue {
  color: var(--k-danger);
  border-color: color-mix(in srgb, var(--k-danger) 45%, var(--k-line-strong));
}

.jtd__side {
  display: flex;
  flex-direction: column;
  gap: var(--k-sp-3);
}

.jtd__facts {
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

.jtd__fact-icon {
  display: flex;
  align-items: center;
  gap: 6px;

  img {
    width: 14px;
    height: 14px;
  }
}

.jtd__status {
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

.jtd__labels {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}

.jtd__label {
  padding: 1px 6px;
  font-size: 10px;
  color: var(--k-muted);
  border: var(--k-rule-thin) solid var(--k-line);
  border-radius: var(--k-r-pill);
}

.jtd__link {
  padding: 0;
  font-size: var(--k-fs-sm);
  color: var(--k-accent);
  background: none;
  border: none;
  cursor: pointer;
}

.jtd__actions {
  display: flex;
  flex-direction: column;
  gap: var(--k-sp-2);
  padding-top: var(--k-sp-2);
  border-top: var(--k-rule-thin) solid var(--k-line);
}

.jtd__confirm {
  margin: 0;
  font-family: var(--k-font-ui);
  font-size: var(--k-fs-sm);
  color: var(--k-text);
}

.jtd__confirm-row {
  display: flex;
  gap: var(--k-sp-2);
}
</style>
