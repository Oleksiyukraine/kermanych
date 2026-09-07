<template>
  <section class="vault">
    <p class="vault__lead">
      {{ t('management.storage.leadBefore') }}
      <span class="vault__lead-workspace mono">{{ workspaceName }}</span>
      {{ t('management.storage.leadAfter') }}
    </p>

    <!-- Pending requests, for a manager/owner only. A developer never sees another person's
         request; a manager sees every one waiting in this workspace and answers it here. -->
    <div v-if="canManage && pending.length" class="vault__requests">
      <h3 class="vault__requests-title mono">{{ t('management.storage.pendingTitle') }}</h3>
      <div v-for="req in pending" :key="req.id" class="vault__request">
        <span class="vault__request-who">
          {{ t('management.storage.requestedBy', { who: memberName(req.requesterId) }) }}
        </span>
        <span class="vault__request-what mono">{{ passwordTitle(req.passwordId) }}</span>
        <div class="vault__request-actions">
          <KBtn
            variant="primary"
            :disabled="deciding === req.id"
            @click="decide(req, true)"
          >{{ t('management.storage.approve') }}</KBtn>
          <KBtn
            variant="ghost"
            :disabled="deciding === req.id"
            @click="decide(req, false)"
          >{{ t('management.storage.decline') }}</KBtn>
        </div>
      </div>
    </div>

    <div class="vault__toolbar">
      <KField v-model="query" :placeholder="t('management.storage.searchPlaceholder')" />
      <KBtn v-if="canManage" variant="primary" @click="openCreate()">
        {{ t('management.storage.newPassword') }}
      </KBtn>
    </div>

    <p v-if="store.loadError" class="vault__error">
      {{ t('management.storage.loadError', { error: store.loadError }) }}
    </p>

    <div v-else-if="!rows.length" class="vault__blank">
      <span class="vault__blank-eyebrow mono">{{ t('management.storage.blankEyebrow') }}</span>
      <p class="vault__blank-text">
        {{ all.length ? t('management.storage.blankFiltered') : t('management.storage.blankEmpty') }}
      </p>
    </div>

    <KTable
      v-else
      class="vault__table"
      :columns="columns"
      :rows="rows"
      :row-key="(r: WorkspacePassword) => r.id"
    >
      <template #cell-title="{ row }">
        <span class="vault__title">{{ row.title }}</span>
      </template>

      <template #cell-status="{ row }">
        <KTag v-if="canManage" plain>{{ t('management.storage.youManage') }}</KTag>
        <KTag v-else-if="statusOf(row.id) === 'approved'" plain class="vault__ok">
          {{ t('management.storage.statusApproved') }}
        </KTag>
        <KTag v-else-if="statusOf(row.id) === 'pending'" plain class="vault__wait">
          {{ t('management.storage.statusPending') }}
        </KTag>
        <KTag v-else-if="statusOf(row.id) === 'declined'" plain class="vault__no">
          {{ t('management.storage.statusDeclined') }}
        </KTag>
        <KTag v-else plain>{{ t('management.storage.statusNone') }}</KTag>
      </template>

      <template #cell-actions="{ row }">
        <div class="vault__actions">
          <!-- Manager/owner: open, edit, delete. -->
          <template v-if="canManage">
            <KIconButton :title="t('management.storage.view')" @click="openView(row)">👁</KIconButton>
            <KIconButton :title="t('management.storage.edit')" @click="openEdit(row)">✎</KIconButton>
            <KIconButton
              class="vault__danger"
              :title="t('management.storage.delete')"
              :disabled="deleting === row.id"
              @click="remove(row)"
            >✕</KIconButton>
          </template>
          <!-- Developer with an approved grant: open only. -->
          <KIconButton
            v-else-if="statusOf(row.id) === 'approved'"
            :title="t('management.storage.view')"
            @click="openView(row)"
          >👁</KIconButton>
          <!-- Developer awaiting a decision: the button is spent. -->
          <KBtn v-else-if="statusOf(row.id) === 'pending'" variant="ghost" disabled>
            {{ t('management.storage.requested') }}
          </KBtn>
          <!-- Otherwise (never asked, or declined): ask (again). -->
          <KBtn
            v-else
            variant="secondary"
            :disabled="requesting === row.id"
            @click="request(row)"
          >
            {{ statusOf(row.id) === 'declined'
              ? t('management.storage.requestAgain')
              : t('management.storage.requestAccess') }}
          </KBtn>
        </div>
      </template>
    </KTable>

    <!-- ── view / reveal ─────────────────────────────────────────────────────── -->
    <KModal
      :model-value="viewOpen"
      :title="viewing?.title ?? ''"
      width="520px"
      @update:model-value="closeView"
    >
      <div v-if="viewSecret" class="vault__reveal">
        <label class="vault__reveal-label mono">{{ t('management.storage.secretLabel') }}</label>
        <div class="vault__reveal-row">
          <code class="vault__secret">{{ showSecret ? viewSecret.secret : mask(viewSecret.secret) }}</code>
          <KIconButton
            :title="showSecret ? t('management.storage.hideSecret') : t('management.storage.showSecret')"
            @click="showSecret = !showSecret"
          >{{ showSecret ? '🙈' : '👁' }}</KIconButton>
          <KIconButton :title="t('management.storage.copy')" @click="copy(viewSecret.secret)">⧉</KIconButton>
        </div>
        <span v-if="copied" class="vault__copied mono">{{ t('management.storage.copied') }}</span>

        <template v-if="viewSecret.filePath">
          <label class="vault__reveal-label mono">{{ t('management.storage.fileLabel') }}</label>
          <div class="vault__reveal-row">
            <span class="vault__file-name">{{ viewSecret.fileName ?? viewSecret.filePath }}</span>
            <KBtn variant="secondary" @click="download(viewSecret.filePath)">
              {{ t('management.storage.download') }}
            </KBtn>
          </div>
        </template>
      </div>

      <template #controls>
        <KBtn variant="ghost" @click="closeView(false)">{{ t('management.storage.close') }}</KBtn>
      </template>
    </KModal>

    <!-- ── create / edit (manager/owner) ─────────────────────────────────────── -->
    <KModal
      :model-value="editorOpen"
      :title="draft.id ? t('management.storage.editTitle') : t('management.storage.createTitle')"
      width="520px"
      persistent
      @update:model-value="closeEditor"
    >
      <div class="vault__form">
        <KField
          v-model="draft.title"
          :label="t('management.storage.fieldTitle')"
          :placeholder="t('management.storage.fieldTitlePlaceholder')"
        />
        <KField
          v-model="draft.secret"
          :label="t('management.storage.fieldSecret')"
          :placeholder="t('management.storage.fieldSecretPlaceholder')"
          :type="editorShowSecret ? 'text' : 'password'"
        />
        <button type="button" class="vault__link mono" @click="editorShowSecret = !editorShowSecret">
          {{ editorShowSecret ? t('management.storage.hideSecret') : t('management.storage.showSecret') }}
        </button>

        <div class="vault__file-field">
          <label class="vault__reveal-label mono">{{ t('management.storage.fileLabel') }}</label>
          <div class="vault__reveal-row">
            <span class="vault__file-name">{{ fileFieldLabel }}</span>
            <KBtn variant="secondary" @click="fileInput?.click()">
              {{ hasFile ? t('management.storage.replaceFile') : t('management.storage.attachFile') }}
            </KBtn>
            <KBtn v-if="hasFile" variant="ghost" @click="clearDraftFile()">
              {{ t('management.storage.removeFile') }}
            </KBtn>
          </div>
          <input ref="fileInput" type="file" class="vault__file-input" @change="onPick" />
        </div>

        <p v-if="editorError" class="vault__form-error">{{ editorError }}</p>
      </div>

      <template #controls>
        <KBtn variant="ghost" :disabled="saving" @click="closeEditor(false)">
          {{ t('management.storage.cancel') }}
        </KBtn>
        <KBtn variant="primary" :disabled="saving || !draft.title.trim()" @click="save">
          {{ saving ? t('management.storage.saving') : t('management.storage.save') }}
        </KBtn>
      </template>
    </KModal>
  </section>
</template>

<script setup lang="ts">
// The workspace password vault — the "Storage" management section. Three sights of one list:
//   * a manager/owner reads every secret, creates/edits/deletes, and answers access requests;
//   * a developer sees every TITLE (so the team knows which credentials exist) and, per row,
//     either an approved secret, a pending request, a declined mark, or a Request button.
// The screen owns view state only; every read and write goes through stores/passwords.ts,
// under the operator's own JWT, so RLS — not this file — is the authorization surface. What
// is drawn here is a courtesy that matches it, never a substitute for it.
import { computed, reactive, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import type { WorkspacePassword } from '@kermanych/cloud';
import KTable, { type KTableColumn } from 'components/kit/KTable.vue';
import KModal from 'components/kit/KModal.vue';
import KField from 'components/kit/KField.vue';
import KBtn from 'components/kit/KBtn.vue';
import KTag from 'components/kit/KTag.vue';
import KIconButton from 'components/kit/KIconButton.vue';
import { usePasswords } from 'stores/passwords';
import { useProjects } from 'stores/projects';
import { useOrchestrator } from 'stores/orchestrator';
import { useAuth } from 'stores/auth';

const props = defineProps<{ workspaceId: string; workspaceName: string }>();
const store = usePasswords();
const projects = useProjects();
const auth = useAuth();
const { notify } = useOrchestrator();
const { t } = useI18n();

// Refetch on open and whenever the sidebar switches workspace. Members come too: the request
// panel names people, and canManage reads the caller's own seat off the roster.
watch(
  () => props.workspaceId,
  (id) => {
    if (!id) return;
    void store.load(id);
    if (!projects.members[id]) void projects.loadMembers(id);
  },
  { immediate: true },
);

const canManage = computed(() => projects.canManageWorkspace(props.workspaceId));
const all = computed(() => store.byWorkspace[props.workspaceId] ?? []);

const query = ref('');
const rows = computed(() => {
  const q = query.value.trim().toLowerCase();
  return q ? all.value.filter((p) => p.title.toLowerCase().includes(q)) : all.value;
});

const columns = computed<KTableColumn[]>(() => [
  { key: 'title', label: t('management.storage.colTitle') },
  { key: 'status', label: t('management.storage.colStatus'), width: '160px' },
  { key: 'actions', label: '', width: '200px', align: 'right' },
]);

// The caller's own request row per password, so the button state is a lookup rather than a
// scan. A developer sees only their rows; a manager sees all, but reads their own here.
const myAccess = computed(() => {
  const uid = auth.user?.id;
  const map = new Map<string, string>();
  if (!uid) return map;
  for (const a of store.accessByWorkspace[props.workspaceId] ?? []) {
    if (a.requesterId === uid) map.set(a.passwordId, a.status);
  }
  return map;
});
function statusOf(passwordId: string): string | undefined {
  return myAccess.value.get(passwordId);
}

const pending = computed(() =>
  (store.accessByWorkspace[props.workspaceId] ?? []).filter((a) => a.status === 'pending'),
);

function memberName(userId: string): string {
  const m = (projects.members[props.workspaceId] ?? []).find((x) => x.userId === userId);
  return m?.profile?.displayName ?? m?.profile?.githubUsername ?? userId;
}
function passwordTitle(passwordId: string): string {
  return all.value.find((p) => p.id === passwordId)?.title ?? passwordId;
}

// ── request / decide ────────────────────────────────────────────────────────
const requesting = ref('');
const deciding = ref('');

async function request(row: WorkspacePassword): Promise<void> {
  requesting.value = row.id;
  try {
    await store.requestAccess(props.workspaceId, row.id);
    notify(t('management.storage.requestSent', { title: row.title }), 'info');
  } catch (e) {
    notify(t('management.storage.requestFailed', { error: errText(e) }), 'error');
  } finally {
    requesting.value = '';
  }
}

async function decide(req: { id: string; passwordId: string }, approve: boolean): Promise<void> {
  deciding.value = req.id;
  try {
    await store.decideAccess(props.workspaceId, req.id, approve);
  } catch (e) {
    const key = approve ? 'management.storage.approveFailed' : 'management.storage.declineFailed';
    notify(t(key, { error: errText(e) }), 'error');
  } finally {
    deciding.value = '';
  }
}

// ── view / reveal ─────────────────────────────────────────────────────────────
const viewOpen = ref(false);
const viewing = ref<WorkspacePassword | undefined>(undefined);
const showSecret = ref(false);
const copied = ref(false);
const viewSecret = computed(() => (viewing.value ? store.secretByPassword[viewing.value.id] : undefined));

async function openView(row: WorkspacePassword): Promise<void> {
  showSecret.value = false;
  copied.value = false;
  try {
    const secret = await store.reveal(row.id);
    if (!secret) {
      notify(t('management.storage.noAccess'), 'error');
      return;
    }
    viewing.value = row;
    viewOpen.value = true;
  } catch (e) {
    notify(t('management.storage.revealFailed', { error: errText(e) }), 'error');
  }
}
function closeView(open: boolean): void {
  if (open) return;
  viewOpen.value = false;
  viewing.value = undefined;
}

function mask(secret: string): string {
  return secret ? '•'.repeat(Math.min(secret.length, 24)) : '—';
}
async function copy(secret: string): Promise<void> {
  await navigator.clipboard.writeText(secret);
  copied.value = true;
}
async function download(filePath: string): Promise<void> {
  const url = await store.fileUrl(filePath);
  if (url) window.open(url, '_blank', 'noopener');
  else notify(t('management.storage.downloadFailed'), 'error');
}

// ── create / edit ─────────────────────────────────────────────────────────────
const editorOpen = ref(false);
const editorShowSecret = ref(false);
const editorError = ref<string | null>(null);
const saving = ref(false);
const fileInput = ref<HTMLInputElement | null>(null);

// `id` absent = create. `secretLoaded` records the original so a save only sends the halves
// that changed. `pickedFile` is a fresh upload; `removeFile` marks the existing one for
// detach; `existingFile` is the name/path already stored.
const draft = reactive<{ id?: string; title: string; secret: string }>({ title: '', secret: '' });
const pickedFile = ref<File | null>(null);
const removeExisting = ref(false);
const existingFile = reactive<{ path: string | undefined; name: string | undefined }>({
  path: undefined,
  name: undefined,
});
const originalTitle = ref('');
const originalSecret = ref('');

const hasFile = computed(() => !!pickedFile.value || (!!existingFile.path && !removeExisting.value));
const fileFieldLabel = computed(() => {
  if (pickedFile.value) return pickedFile.value.name;
  if (existingFile.path && !removeExisting.value) return existingFile.name ?? existingFile.path;
  return t('management.storage.noFile');
});

function resetDraft(): void {
  draft.title = '';
  draft.secret = '';
  delete draft.id;
  pickedFile.value = null;
  removeExisting.value = false;
  existingFile.path = undefined;
  existingFile.name = undefined;
  originalTitle.value = '';
  originalSecret.value = '';
  editorError.value = null;
  editorShowSecret.value = false;
  if (fileInput.value) fileInput.value.value = '';
}

function openCreate(): void {
  resetDraft();
  editorOpen.value = true;
}

async function openEdit(row: WorkspacePassword): Promise<void> {
  resetDraft();
  // A manager can always read the secret; load it so the form is prefilled with real values
  // rather than a masked placeholder that a blank save would then wipe.
  try {
    const secret = await store.reveal(row.id);
    draft.id = row.id;
    draft.title = row.title;
    draft.secret = secret?.secret ?? '';
    originalTitle.value = row.title;
    originalSecret.value = secret?.secret ?? '';
    existingFile.path = secret?.filePath;
    existingFile.name = secret?.fileName;
    editorOpen.value = true;
  } catch (e) {
    notify(t('management.storage.revealFailed', { error: errText(e) }), 'error');
  }
}

function closeEditor(open: boolean): void {
  if (open || saving.value) return;
  editorOpen.value = false;
  resetDraft();
}

function onPick(e: Event): void {
  const file = (e.target as HTMLInputElement).files?.[0] ?? null;
  if (file) {
    pickedFile.value = file;
    removeExisting.value = false;
  }
}
function clearDraftFile(): void {
  pickedFile.value = null;
  removeExisting.value = true;
  if (fileInput.value) fileInput.value.value = '';
}

async function save(): Promise<void> {
  const title = draft.title.trim();
  if (!title) return;
  saving.value = true;
  editorError.value = null;
  try {
    if (draft.id) await saveEdit(draft.id, title);
    else await store.create(props.workspaceId, { title, secret: draft.secret }, pickedFile.value);
    editorOpen.value = false;
    resetDraft();
  } catch (e) {
    editorError.value = errText(e);
  } finally {
    saving.value = false;
  }
}

// Only the halves that changed are sent: a title rename never rewrites the secret, and vice
// versa, so two managers editing different fields do not clobber each other.
async function saveEdit(id: string, title: string): Promise<void> {
  if (title !== originalTitle.value) await store.rename(props.workspaceId, id, title);
  if (draft.secret !== originalSecret.value) await store.saveSecret(id, draft.secret);
  if (pickedFile.value) await store.attachFile(id, pickedFile.value, existingFile.path);
  else if (removeExisting.value && existingFile.path) await store.removeFile(id, existingFile.path);
}

// ── delete ──────────────────────────────────────────────────────────────────
const deleting = ref('');
async function remove(row: WorkspacePassword): Promise<void> {
  if (!window.confirm(t('management.storage.deleteConfirm', { title: row.title }))) return;
  deleting.value = row.id;
  try {
    await store.remove(props.workspaceId, row.id);
    if (viewing.value?.id === row.id) closeView(false);
  } catch (e) {
    notify(t('management.storage.deleteFailed', { title: row.title, error: errText(e) }), 'error');
  } finally {
    deleting.value = '';
  }
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
</script>

<style scoped lang="scss">
.vault {
  display: flex;
  flex-direction: column;
  gap: var(--k-sp-4);
  width: 100%;
  padding: var(--k-sp-3) 0;
}

.vault__lead {
  margin: 0;
  font-family: var(--k-font-ui);
  font-size: var(--k-fs-base);
  line-height: 1.5;
  color: var(--k-muted);
}

.vault__lead-workspace {
  color: var(--k-text);
}

.vault__requests {
  display: flex;
  flex-direction: column;
  gap: var(--k-sp-2);
  padding: var(--k-sp-3);
  background: color-mix(in srgb, var(--k-warning) 10%, transparent);
  border-left: var(--k-rule-strong) solid var(--k-warning);
  border-radius: var(--k-r-lg);
}

.vault__requests-title {
  margin: 0;
  font-size: 10px;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: var(--k-faint);
}

.vault__request {
  display: flex;
  align-items: center;
  gap: var(--k-sp-2);
  font-size: var(--k-fs-sm);
}

.vault__request-who {
  color: var(--k-text);
}

.vault__request-what {
  color: var(--k-muted);
}

.vault__request-actions {
  display: flex;
  gap: var(--k-sp-2);
  margin-left: auto;
}

.vault__toolbar {
  display: flex;
  align-items: center;
  gap: var(--k-sp-2);
}

.vault__error {
  margin: 0;
  padding: var(--k-sp-3);
  font-size: var(--k-fs-sm);
  color: var(--k-text);
  background: color-mix(in srgb, var(--k-accent) 10%, transparent);
  border-left: var(--k-rule-strong) solid var(--k-accent);
}

.vault__blank {
  display: flex;
  flex-direction: column;
  gap: var(--k-sp-2);
  padding: var(--k-sp-6);
  background: color-mix(in srgb, var(--k-surface2) 30%, transparent);
  border: var(--k-rule-thin) dashed var(--k-line-strong);
  border-radius: var(--k-r-lg);
}

.vault__blank-eyebrow {
  font-size: var(--k-fs-xs);
  letter-spacing: 0.2em;
  color: var(--k-muted);
}

.vault__blank-text {
  margin: 0;
  font-size: var(--k-fs-md);
  color: var(--k-muted);
}

.vault__title {
  color: var(--k-text);
}

.vault__ok {
  color: var(--k-success);
}
.vault__wait {
  color: var(--k-warning);
}
.vault__no {
  color: var(--k-danger);
}

.vault__actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: var(--k-sp-2);
}

.vault__danger:focus-visible {
  color: var(--k-danger);
}

.vault__reveal,
.vault__form {
  display: flex;
  flex-direction: column;
  gap: var(--k-sp-2);
}

.vault__reveal-label {
  font-size: 10px;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: var(--k-faint);
}

.vault__reveal-row {
  display: flex;
  align-items: center;
  gap: var(--k-sp-2);
}

.vault__secret {
  flex: 1;
  padding: var(--k-sp-2);
  font-family: var(--k-font-mono);
  font-size: var(--k-fs-sm);
  color: var(--k-text);
  background: color-mix(in srgb, var(--k-surface2) 50%, transparent);
  border: var(--k-rule-thin) solid var(--k-line);
  border-radius: var(--k-r-sm);
  word-break: break-all;
}

.vault__copied {
  font-size: var(--k-fs-xs);
  color: var(--k-success);
}

.vault__file-name {
  flex: 1;
  font-size: var(--k-fs-sm);
  color: var(--k-muted);
  word-break: break-all;
}

.vault__file-field {
  display: flex;
  flex-direction: column;
  gap: var(--k-sp-2);
}

.vault__file-input {
  display: none;
}

.vault__link {
  align-self: flex-start;
  padding: 0;
  border: none;
  background: none;
  font-family: var(--k-font-mono);
  font-size: 10px;
  color: var(--k-accent);
  cursor: pointer;
}

.vault__form-error {
  margin: 0;
  font-size: var(--k-fs-sm);
  color: var(--k-danger);
}
</style>
