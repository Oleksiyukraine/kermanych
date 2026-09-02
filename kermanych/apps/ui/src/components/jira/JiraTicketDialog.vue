<template>
  <KModal :model-value="modelValue" :title="`${issue.key}`" width="780px" @update:model-value="emit('update:modelValue', $event)">
    <template #head-meta>
      <span class="jtd__headmeta mono">{{ issue.statusName }}</span>
    </template>

    <div class="jtd">
      <div class="jtd__main">
        <h3 class="jtd__summary">{{ issue.summary }}</h3>

        <!-- Sanitized before v-html: the mirror stores what Jira rendered; trust is decided
             here (lib/sanitize-html.ts). -->
        <div v-if="descriptionHtml" class="jtd__desc" v-html="descriptionHtml"></div>
        <p v-else class="jtd__empty mono">Без опису.</p>

        <div v-if="subtasks.length" class="jtd__section">
          <h4 class="jtd__section-title">Підзадачі</h4>
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
          <h4 class="jtd__section-title">Вкладення</h4>
          <div v-for="a in kids?.attachments ?? []" :key="a.attachmentId" class="jtd__attachment">
            <button class="jtd__attachment-name" type="button" :disabled="!canAct" @click="download(a)">
              {{ a.filename }}
            </button>
            <span class="jtd__attachment-meta mono">{{ prettySize(a.size) }} · {{ a.authorName }}</span>
          </div>
          <div v-if="canAct" class="jtd__attach-row">
            <input ref="fileInput" type="file" class="jtd__file" @change="upload" />
            <KBtn variant="ghost" :disabled="uploading" @click="fileInput?.click()">
              {{ uploading ? 'Завантажуємо…' : '⛶ Додати файл' }}
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
            >Коментарі{{ kids?.comments.length ? ` · ${kids.comments.length}` : '' }}</button>
            <button
              class="jtd__tab"
              :class="{ 'jtd__tab--on': tab === 'worklogs' }"
              type="button"
              @click="tab = 'worklogs'"
            >Ворклоги{{ kids?.worklogs.length ? ` · ${kids.worklogs.length}` : '' }}</button>
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
            <p v-if="!kids?.comments.length" class="jtd__empty mono">Коментарів ще немає.</p>

            <div v-if="canAct" class="jtd__composer">
              <textarea
                v-model="commentDraft"
                class="jtd__composer-input"
                rows="3"
                placeholder="Коментар піде в Jira від вашого імені"
              ></textarea>
              <KBtn variant="secondary" :disabled="!commentDraft.trim() || commenting" @click="sendComment">
                {{ commenting ? 'Надсилаємо…' : 'Коментувати' }}
              </KBtn>
            </div>
          </template>

          <template v-else>
            <div v-for="w in kids?.worklogs ?? []" :key="w.worklogId" class="jtd__worklog">
              <span class="jtd__worklog-time mono">{{ w.timeSpent }}</span>
              <span class="jtd__worklog-author">{{ w.authorName }}</span>
              <span class="jtd__worklog-when mono">{{ shortTime(w.startedAt) }}</span>
              <span v-if="w.commentHtml" class="jtd__worklog-note">{{ w.commentHtml }}</span>
            </div>
            <p v-if="!kids?.worklogs.length" class="jtd__empty mono">Ворклогів немає.</p>
          </template>
        </div>
      </div>

      <aside class="jtd__side">
        <dl class="jtd__facts">
          <div>
            <dt>Статус</dt>
            <dd>
              <button
                class="jtd__status"
                type="button"
                :disabled="!canAct"
                v-tip="canAct ? 'Перенести в інший статус' : READ_ONLY_HINT"
                @click="openTransition"
              >{{ issue.statusName }}</button>
            </dd>
          </div>
          <div v-if="issue.typeName"><dt>Тип</dt><dd class="jtd__fact-icon"><img v-if="issue.typeIcon" :src="issue.typeIcon" alt="" />{{ issue.typeName }}</dd></div>
          <div v-if="issue.priorityName"><dt>Пріоритет</dt><dd class="jtd__fact-icon"><img v-if="issue.priorityIcon" :src="issue.priorityIcon" alt="" />{{ issue.priorityName }}</dd></div>
          <div><dt>Виконавець</dt><dd>{{ issue.assigneeName ?? 'не призначено' }}</dd></div>
          <div v-if="issue.reporterName"><dt>Автор</dt><dd>{{ issue.reporterName }}</dd></div>
          <div v-if="issue.labels.length">
            <dt>Мітки</dt>
            <dd class="jtd__labels">
              <span v-for="label in issue.labels" :key="label" class="jtd__label mono">{{ label }}</span>
            </dd>
          </div>
          <div v-if="issue.parentKey">
            <dt>Батьківський</dt>
            <dd><button class="jtd__link mono" type="button" @click="emit('openIssue', issue.parentKey!)">{{ issue.parentKey }}</button></dd>
          </div>
        </dl>

        <div class="jtd__actions">
          <KBtn
            variant="primary"
            :disabled="!canLaunch"
            :title="launchHint"
            @click="emit('launch')"
          >Запустити</KBtn>
          <KBtn variant="secondary" :disabled="!canAct" :title="canAct ? '' : READ_ONLY_HINT" @click="emit('edit')">Редагувати</KBtn>
          <KBtn variant="ghost" :disabled="!canAct" :title="canAct ? '' : READ_ONLY_HINT" @click="emit('subtask')">+ Підзадача</KBtn>
          <KBtn v-if="!confirmingDelete" variant="ghost" :disabled="!canAct" :title="canAct ? '' : READ_ONLY_HINT" @click="confirmingDelete = true">Видалити</KBtn>
          <template v-else>
            <p class="jtd__confirm">Видалити {{ issue.key }} у Jira разом із підзадачами?</p>
            <div class="jtd__confirm-row">
              <KBtn variant="ghost" @click="confirmingDelete = false">Ні</KBtn>
              <KBtn variant="secondary" :disabled="deleting" @click="doDelete">{{ deleting ? '…' : 'Так, видалити' }}</KBtn>
            </div>
          </template>
        </div>
      </aside>
    </div>

    <JiraStatusPickDialog
      v-model="transitionOpen"
      :title="`${issue.key} → статус`"
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
import type { JiraAttachment, JiraIssue } from '@kermanych/cloud';
import KAvatar from 'components/kit/KAvatar.vue';
import KBtn from 'components/kit/KBtn.vue';
import KModal from 'components/kit/KModal.vue';
import JiraStatusPickDialog from './JiraStatusPickDialog.vue';
import { api } from '../../lib/api';
import { sanitizeJiraHtml } from '../../lib/sanitize-html';
import { subtasksOf, type JiraTransitionView } from '../../lib/jira-view';
import { useJira } from 'stores/jira';
import { useOrchestrator } from 'stores/orchestrator';

const READ_ONLY_HINT = 'Додайте свій Jira-токен у Менеджмент → Integrations, щоб діяти';

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
const commentDraft = ref('');
const commenting = ref(false);
const uploading = ref(false);
const deleting = ref(false);
const confirmingDelete = ref(false);
const fileInput = ref<HTMLInputElement | null>(null);

const transitionOpen = ref(false);
const transitionOptions = ref<JiraTransitionView[]>([]);
const transitioning = ref(false);

const canAct = computed(() => jira.tokenPresent);
const kids = computed(() => jira.children[props.issue.issueId]);
const descriptionHtml = computed(() => sanitizeJiraHtml(props.issue.descriptionHtml));
const subtasks = computed(() => subtasksOf(jira.issues, props.issue.key));

// Launch is gated the native way (assignment is not: a Jira ticket has no Kermanych
// assignee): a running shadow task means «уже виконується».
const running = computed(() => {
  const taskId = props.issue.taskId;
  return !!taskId && local.sessions.some((s) => s.taskId === taskId);
});
const canLaunch = computed(() => canAct.value && !running.value);
const launchHint = computed(() => {
  if (!canAct.value) return READ_ONLY_HINT;
  if (running.value) return 'Тікет уже виконується на цій машині';
  return 'Запустити агента на цьому тікеті';
});

// Fresh detail on every open: live refresh through the api when a token is here (comments
// fresher than the 30 s tick), the mirror's cache otherwise.
watch(
  () => props.modelValue,
  (open) => {
    if (!open) return;
    tab.value = 'comments';
    confirmingDelete.value = false;
    void jira.loadChildren(props.issue.issueId);
    void jira.refreshIssue(props.workspaceId, props.issue.key);
  },
);

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
.jtd {
  display: grid;
  grid-template-columns: 1fr 220px;
  gap: var(--k-sp-4);
}

.jtd__headmeta {
  font-size: var(--k-fs-xs);
  color: var(--k-faint);
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

  :deep(img) {
    max-width: 100%;
  }

  :deep(pre),
  :deep(code) {
    font-family: var(--k-font-mono);
    font-size: var(--k-fs-sm);
  }

  :deep(a) {
    color: var(--k-accent);
  }
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
