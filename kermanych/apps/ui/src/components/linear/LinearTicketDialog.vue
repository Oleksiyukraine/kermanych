<template>
  <KModal
    :model-value="modelValue"
    :title="`${issue.key}`"
    :width="expanded ? 'min(90vw, 1680px)' : '780px'"
    @update:model-value="emit('update:modelValue', $event)"
  >
    <template #head-meta>
      <span class="ltd__headside">
        <span class="ltd__headmeta mono">{{ issue.stateName }}</span>
        <KIconButton
          :title="expanded ? t('linear.ticketDialog.collapse') : t('linear.ticketDialog.expand')"
          @click="expanded = !expanded"
        >{{ expanded ? '⤡' : '⤢' }}</KIconButton>
      </span>
    </template>

    <div class="ltd">
      <div class="ltd__main">
        <h3 class="ltd__summary">{{ issue.title }}</h3>

        <!-- Linear descriptions are markdown; renderMarkdown is html:false, so its output
             is a controlled tag set safe to inject via v-html. -->
        <div v-if="descriptionHtml" class="ltd__desc" v-html="descriptionHtml"></div>
        <p v-else class="ltd__empty mono">{{ t('linear.ticketDialog.emptyDescription') }}</p>

        <div v-if="subtasks.length" class="ltd__section">
          <h4 class="ltd__section-title">{{ t('linear.ticketDialog.subtasks') }}</h4>
          <button
            v-for="sub in subtasks"
            :key="sub.issueId"
            class="ltd__subtask"
            type="button"
            @click="emit('openIssue', sub.key)"
          >
            <span class="mono">{{ sub.key }}</span>
            <span class="ltd__subtask-summary">{{ sub.title }}</span>
            <span class="ltd__subtask-status mono">{{ sub.stateName }}</span>
          </button>
        </div>

        <!-- Attachments are read-only links in Linear (no upload): each opens its url in a
             new tab. -->
        <div v-if="kids?.attachments.length" class="ltd__section">
          <h4 class="ltd__section-title">{{ t('linear.ticketDialog.attachments') }}</h4>
          <div v-for="a in kids?.attachments ?? []" :key="a.attachmentId" class="ltd__attachment">
            <a class="ltd__attachment-name" :href="a.url" target="_blank" rel="noopener noreferrer">
              {{ a.title || a.url }}
            </a>
            <span v-if="a.subtitle" class="ltd__attachment-meta mono">{{ a.subtitle }}</span>
          </div>
        </div>

        <div class="ltd__section">
          <h4 class="ltd__section-title">{{ t('linear.ticketDialog.comments') }}{{ kids?.comments.length ? ` · ${kids.comments.length}` : '' }}</h4>
          <div v-for="c in kids?.comments ?? []" :key="c.commentId" class="ltd__comment">
            <div class="ltd__comment-head">
              <KAvatar :name="c.authorName || '?'" :avatar-url="c.authorAvatar || undefined" :size="18" />
              <span class="ltd__comment-author">{{ c.authorName }}</span>
              <span class="ltd__comment-time mono">{{ shortTime(c.createdAt) }}</span>
            </div>
            <div class="ltd__comment-body" v-html="renderMarkdown(c.bodyMd)"></div>
          </div>
          <p v-if="!kids?.comments.length" class="ltd__empty mono">{{ t('linear.ticketDialog.noComments') }}</p>

          <div v-if="canAct" class="ltd__composer">
            <textarea
              v-model="commentDraft"
              class="ltd__composer-input"
              rows="3"
              :placeholder="t('linear.ticketDialog.commentPlaceholder')"
            ></textarea>
            <KBtn variant="secondary" :disabled="!commentDraft.trim() || commenting" @click="sendComment">
              {{ commenting ? t('linear.ticketDialog.sending') : t('linear.ticketDialog.comment') }}
            </KBtn>
          </div>
        </div>
      </div>

      <aside class="ltd__side">
        <dl class="ltd__facts">
          <div>
            <dt>{{ t('linear.ticketDialog.status') }}</dt>
            <dd>
              <button
                class="ltd__status"
                type="button"
                :disabled="!canAct || transitionsLoading"
                v-tip="canAct ? t('linear.ticketDialog.transitionTip') : readOnlyHint"
                @click="openTransition"
              >{{ issue.stateName }}</button>
            </dd>
          </div>
          <div>
            <dt>{{ t('linear.ticketDialog.priority') }}</dt>
            <dd v-if="canAct">
              <KSelect
                :model-value="priorityCurrent"
                :options="priorityOptions"
                :disabled="savingField === 'priority'"
                @update:model-value="pickPriority"
              />
            </dd>
            <dd v-else>{{ issue.priorityName || '—' }}</dd>
          </div>
          <div>
            <dt>{{ t('linear.ticketDialog.estimate') }}</dt>
            <dd>
              <input
                v-if="canAct"
                v-model="estimateDraft"
                type="number"
                class="ltd__estimate mono"
                :placeholder="t('linear.ticketDialog.estimatePlaceholder')"
                :disabled="savingField === 'estimate'"
                v-tip="t('linear.ticketDialog.estimateTip')"
                @keydown.enter.prevent="blurTarget($event)"
                @blur="saveEstimate"
              />
              <span v-else>{{ issue.estimate > 0 ? issue.estimate : '—' }}</span>
            </dd>
          </div>
          <!-- Start date is read-only: Linear derives it from when the issue first entered a
               started state and has no user-editable field. Shown only when present. -->
          <div v-if="issue.startDate">
            <dt>{{ t('linear.ticketDialog.start') }}</dt>
            <dd>{{ issue.startDate }}</dd>
          </div>
          <div>
            <dt>{{ t('linear.ticketDialog.due') }}</dt>
            <dd>
              <input
                v-if="canAct"
                v-model="dueDraft"
                type="date"
                class="ltd__date mono"
                :class="{ 'ltd__date--overdue': overdue }"
                :disabled="savingField === 'dueDate'"
                v-tip="overdue ? t('linear.ticketDialog.dueTipOverdue') : t('linear.ticketDialog.dueTip')"
                @change="saveDueDate"
              />
              <span v-else :class="{ 'ltd__date--overdue': overdue }">{{ issue.dueDate || '—' }}</span>
            </dd>
          </div>
          <div>
            <dt>{{ t('linear.ticketDialog.assignee') }}</dt>
            <dd v-if="canAct && assigneeOptions.length > 1">
              <KSelect
                :model-value="assigneeCurrent"
                :options="assigneeOptions"
                :disabled="savingField === 'assignee'"
                :placeholder="t('linear.ticketDialog.unassigned')"
                searchable
                @update:model-value="pickAssignee"
              />
            </dd>
            <dd v-else>{{ issue.assigneeName ?? t('linear.ticketDialog.unassigned') }}</dd>
          </div>
          <div v-if="issue.labels.length">
            <dt>{{ t('linear.ticketDialog.labels') }}</dt>
            <dd class="ltd__labels">
              <span v-for="label in issue.labels" :key="label" class="ltd__label mono">{{ label }}</span>
            </dd>
          </div>
          <div v-if="issue.url">
            <dt>{{ t('linear.ticketDialog.link') }}</dt>
            <dd><a class="ltd__link mono" :href="issue.url" target="_blank" rel="noopener noreferrer">{{ issue.key }}</a></dd>
          </div>
          <div v-if="issue.parentKey">
            <dt>{{ t('linear.ticketDialog.parent') }}</dt>
            <dd><button class="ltd__link mono" type="button" @click="emit('openIssue', issue.parentKey!)">{{ issue.parentKey }}</button></dd>
          </div>
        </dl>

        <div class="ltd__actions">
          <KBtn
            variant="primary"
            :disabled="!canLaunch"
            :title="launchHint"
            @click="emit('launch')"
          >{{ t('linear.ticketDialog.launch') }}</KBtn>
          <KBtn variant="secondary" :disabled="!canAct" :title="canAct ? '' : readOnlyHint" @click="emit('edit')">{{ t('linear.ticketDialog.edit') }}</KBtn>
          <KBtn variant="ghost" :disabled="!canAct" :title="canAct ? '' : readOnlyHint" @click="emit('subtask')">{{ t('linear.ticketDialog.addSubtask') }}</KBtn>
          <KBtn v-if="!confirmingDelete" variant="ghost" :disabled="!canAct" :title="canAct ? '' : readOnlyHint" @click="confirmingDelete = true">{{ t('linear.ticketDialog.delete') }}</KBtn>
          <template v-else>
            <p class="ltd__confirm">{{ t('linear.ticketDialog.deleteConfirm', { key: issue.key }) }}</p>
            <div class="ltd__confirm-row">
              <KBtn variant="ghost" @click="confirmingDelete = false">{{ t('linear.ticketDialog.no') }}</KBtn>
              <KBtn variant="secondary" :disabled="deleting" @click="doDelete">{{ deleting ? '…' : t('linear.ticketDialog.yesDelete') }}</KBtn>
            </div>
          </template>
        </div>
      </aside>
    </div>

    <LinearStatusPickDialog
      v-model="transitionOpen"
      :title="t('linear.ticketDialog.statusTitle', { key: issue.key })"
      :options="transitionOptions"
      :busy="transitioning"
      @pick="applyTransition"
    />
  </KModal>
</template>

<script setup lang="ts">
// The mirrored ticket, whole: markdown description, standard fields, subtasks, read-only
// attachment links and comments. Every ACTION goes to Linear under this member's API key
// and lands back in the mirror; a tokenless member sees everything and can touch nothing —
// each control says why instead of hiding. Linear has no worklogs and no time tracking, so
// this dialog is the Jira ticket dialog minus that half.
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import type { LinearIssue } from '@kermanych/cloud';
import KAvatar from 'components/kit/KAvatar.vue';
import KBtn from 'components/kit/KBtn.vue';
import KModal from 'components/kit/KModal.vue';
import KIconButton from 'components/kit/KIconButton.vue';
import KSelect, { type KSelectOption } from 'components/kit/KSelect.vue';
import LinearStatusPickDialog from './LinearStatusPickDialog.vue';
import { api, type LinearAssignableUser, type LinearIssueDraftWire } from '../../lib/api';
import { renderMarkdown } from '../../lib/markdown';
import { dateChip, subtasksOf, todayIso, type LinearTransitionView } from '../../lib/linear-view';
import { useLinear } from 'stores/linear';
import { useOrchestrator } from 'stores/orchestrator';

const { t } = useI18n();
const readOnlyHint = computed(() => t('linear.ticketDialog.readOnlyHint'));

const props = defineProps<{ modelValue: boolean; issue: LinearIssue; workspaceId: string }>();
const emit = defineEmits<{
  'update:modelValue': [value: boolean];
  launch: [];
  edit: [];
  subtask: [];
  openIssue: [key: string];
  deleted: [];
}>();

const linear = useLinear();
const local = useOrchestrator();

// The wide mode: the same ticket at ~90% of the screen, for descriptions that need room.
const expanded = ref(false);
const commentDraft = ref('');
const commenting = ref(false);
const deleting = ref(false);
const confirmingDelete = ref(false);

const transitionOpen = ref(false);
const transitionOptions = ref<LinearTransitionView[]>([]);
const transitioning = ref(false);
const transitionsLoading = ref(false);

// ── inline facts editing: priority / assignee / estimate / due date ───────────
// One-field drafts through PUT /linear/issues — the same endpoint the full editor uses.
const assignable = ref<LinearAssignableUser[]>([]);
const estimateDraft = ref('');
const dueDraft = ref('');
const savingField = ref<'priority' | 'assignee' | 'estimate' | 'dueDate' | null>(null);

// Linear's fixed 0–4 priority scale from i18n; the value is the number as a string.
const priorityOptions = computed<KSelectOption[]>(() => [
  { value: '0', label: t('linear.priority.0') },
  { value: '1', label: t('linear.priority.1') },
  { value: '2', label: t('linear.priority.2') },
  { value: '3', label: t('linear.priority.3') },
  { value: '4', label: t('linear.priority.4') },
]);
const priorityCurrent = computed(() => String(props.issue.priority));

const assigneeOptions = computed<KSelectOption[]>(() => [
  { value: '', label: t('linear.ticketDialog.unassigned') },
  ...assignable.value.map((u) => ({ value: u.id, label: u.name })),
]);
const assigneeCurrent = computed(() => props.issue.assigneeId ?? '');

const canAct = computed(() => linear.tokenPresent);
const kids = computed(() => linear.children[props.issue.issueId]);
const descriptionHtml = computed(() => renderMarkdown(props.issue.descriptionMd));
const subtasks = computed(() => subtasksOf(linear.issues, props.issue.key));

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
  if (running.value) return t('linear.ticketDialog.launchHintRunning');
  return t('linear.ticketDialog.launchHintReady');
});

// Fresh detail on every open: live refresh through the api when a token is here (comments
// fresher than the 30 s tick), the mirror's cache otherwise.
watch(
  () => props.modelValue,
  (open) => {
    if (!open) return;
    confirmingDelete.value = false;
    commentDraft.value = '';
    estimateDraft.value = props.issue.estimate > 0 ? String(props.issue.estimate) : '';
    dueDraft.value = props.issue.dueDate;
    void linear.loadChildren(props.issue.issueId);
    void linear.refreshIssue(props.workspaceId, props.issue.key);
    if (canAct.value) void loadAssignable();
  },
);

// Realtime/refresh may change the issue under an open dialog; the inline inputs must
// follow unless the user is mid-save on that very field.
watch(
  () => props.issue,
  (issue) => {
    if (savingField.value !== 'estimate') estimateDraft.value = issue.estimate > 0 ? String(issue.estimate) : '';
    if (savingField.value !== 'dueDate') dueDraft.value = issue.dueDate;
  },
);

// Failure degrades to the read-only facts — the assignee select renders only on a loaded list.
async function loadAssignable(): Promise<void> {
  try {
    assignable.value = await api.linearAssignableUsers(props.workspaceId, '');
  } catch {
    /* keep static facts */
  }
}

async function saveField(field: NonNullable<typeof savingField.value>, draft: LinearIssueDraftWire): Promise<void> {
  savingField.value = field;
  try {
    linear.upsert(await api.linearEditIssue(props.workspaceId, props.issue.key, draft));
  } catch (e) {
    local.notify(e instanceof Error ? e.message : String(e), 'error');
    // A refused write leaves the mirror row as the truth: every draft returns to it.
    estimateDraft.value = props.issue.estimate > 0 ? String(props.issue.estimate) : '';
    dueDraft.value = props.issue.dueDate;
  } finally {
    savingField.value = null;
  }
}

function pickPriority(id: string): void {
  if (id !== priorityCurrent.value) void saveField('priority', { priority: Number(id) });
}

function pickAssignee(id: string): void {
  if (id !== assigneeCurrent.value) void saveField('assignee', { assigneeId: id || null });
}

async function saveEstimate(): Promise<void> {
  const raw = estimateDraft.value.trim();
  const next = raw === '' ? 0 : Number(raw);
  if (next === props.issue.estimate) return;
  await saveField('estimate', { estimate: raw === '' ? null : Number(raw) });
}

// The due date goes to Linear exactly as <input type="date"> spells it (YYYY-MM-DD), and a
// cleared input is a cleared date in Linear.
async function saveDueDate(): Promise<void> {
  if (dueDraft.value === props.issue.dueDate) return;
  await saveField('dueDate', { dueDate: dueDraft.value });
}

function blurTarget(e: Event): void {
  (e.target as HTMLElement).blur();
}

async function openTransition(): Promise<void> {
  if (transitionsLoading.value) return;
  transitionsLoading.value = true;
  try {
    transitionOptions.value = await api.linearTransitions(props.workspaceId, props.issue.key);
    transitionOpen.value = true;
  } catch (e) {
    local.notify(e instanceof Error ? e.message : String(e), 'error');
  } finally {
    transitionsLoading.value = false;
  }
}

async function applyTransition(tr: LinearTransitionView): Promise<void> {
  transitioning.value = true;
  try {
    const updated = await api.linearTransition(props.workspaceId, props.issue.key, tr.id);
    linear.upsert(updated);
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
    const updated = await api.linearComment(props.workspaceId, props.issue.key, commentDraft.value.trim());
    linear.upsert(updated);
    commentDraft.value = '';
    await linear.loadChildren(props.issue.issueId);
  } catch (e) {
    local.notify(e instanceof Error ? e.message : String(e), 'error');
  } finally {
    commenting.value = false;
  }
}

async function doDelete(): Promise<void> {
  deleting.value = true;
  try {
    await api.linearDeleteIssue(props.workspaceId, props.issue.key);
    linear.drop(props.issue.issueId);
    emit('update:modelValue', false);
    emit('deleted');
  } catch (e) {
    local.notify(e instanceof Error ? e.message : String(e), 'error');
  } finally {
    deleting.value = false;
  }
}

function shortTime(iso: string): string {
  const d = new Date(iso);
  return `${d.toLocaleDateString('uk-UA')} ${d.toLocaleTimeString('uk-UA', { hour: '2-digit', minute: '2-digit' })}`;
}
</script>

<style scoped lang="scss">
// Rendered markdown (descriptions, comment bodies) restyled to the modal's type ramp.
// Em-based so the same rules fit the description's base size and the comments' smaller one.
@mixin linear-rich {
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

.ltd {
  display: grid;
  grid-template-columns: 1fr 220px;
  gap: var(--k-sp-4);
}

.ltd__headmeta {
  font-size: var(--k-fs-xs);
  color: var(--k-faint);
}

.ltd__headside {
  display: flex;
  align-items: center;
  gap: var(--k-sp-2);
}

.ltd__main {
  display: flex;
  flex-direction: column;
  gap: var(--k-sp-3);
  min-width: 0;
}

.ltd__summary {
  margin: 0;
  font-family: var(--k-font-ui);
  font-size: var(--k-fs-lg);
  font-weight: var(--k-fw-semibold);
  color: var(--k-text);
}

.ltd__desc {
  font-family: var(--k-font-ui);
  font-size: var(--k-fs-base);
  line-height: 1.5;
  color: var(--k-text);
  overflow-wrap: anywhere;

  @include linear-rich;
}

.ltd__empty {
  margin: 0;
  font-size: var(--k-fs-sm);
  color: var(--k-faint);
}

.ltd__section {
  display: flex;
  flex-direction: column;
  gap: var(--k-sp-2);
  padding-top: var(--k-sp-2);
  border-top: var(--k-rule-thin) solid var(--k-line);
}

.ltd__section-title {
  margin: 0;
  font-family: var(--k-font-ui);
  font-size: var(--k-fs-sm);
  font-weight: var(--k-fw-medium);
  color: var(--k-muted);
}

.ltd__subtask {
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

.ltd__subtask-summary {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ltd__subtask-status {
  font-size: var(--k-fs-xs);
  color: var(--k-faint);
}

.ltd__attachment {
  display: flex;
  align-items: baseline;
  gap: var(--k-sp-2);
}

.ltd__attachment-name {
  font-family: var(--k-font-ui);
  font-size: var(--k-fs-sm);
  color: var(--k-accent);
  text-decoration: none;

  &:hover {
    text-decoration: underline;
  }
}

.ltd__attachment-meta {
  font-size: var(--k-fs-xs);
  color: var(--k-faint);
}

.ltd__comment {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.ltd__comment-head {
  display: flex;
  align-items: center;
  gap: var(--k-sp-2);
}

.ltd__comment-author {
  font-family: var(--k-font-ui);
  font-size: var(--k-fs-sm);
  font-weight: var(--k-fw-medium);
  color: var(--k-text);
}

.ltd__comment-time {
  font-size: var(--k-fs-xs);
  color: var(--k-faint);
}

.ltd__comment-body {
  font-family: var(--k-font-ui);
  font-size: var(--k-fs-sm);
  line-height: 1.5;
  color: var(--k-text);
  overflow-wrap: anywhere;

  @include linear-rich;
}

.ltd__composer {
  display: flex;
  flex-direction: column;
  gap: var(--k-sp-2);
  align-items: flex-end;
}

.ltd__composer-input {
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

.ltd__side {
  display: flex;
  flex-direction: column;
  gap: var(--k-sp-3);
}

.ltd__facts {
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

.ltd__status {
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

.ltd__estimate,
.ltd__date {
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

.ltd__date--overdue {
  color: var(--k-danger);
  border-color: color-mix(in srgb, var(--k-danger) 45%, var(--k-line-strong));
}

.ltd__labels {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}

.ltd__label {
  padding: 1px 6px;
  font-size: 10px;
  color: var(--k-muted);
  border: var(--k-rule-thin) solid var(--k-line);
  border-radius: var(--k-r-pill);
}

.ltd__link {
  padding: 0;
  font-size: var(--k-fs-sm);
  color: var(--k-accent);
  background: none;
  border: none;
  cursor: pointer;
  text-decoration: none;

  &:hover {
    text-decoration: underline;
  }
}

.ltd__actions {
  display: flex;
  flex-direction: column;
  gap: var(--k-sp-2);
  padding-top: var(--k-sp-2);
  border-top: var(--k-rule-thin) solid var(--k-line);
}

.ltd__confirm {
  margin: 0;
  font-family: var(--k-font-ui);
  font-size: var(--k-fs-sm);
  color: var(--k-text);
}

.ltd__confirm-row {
  display: flex;
  gap: var(--k-sp-2);
}
</style>
