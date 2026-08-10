<template>
  <main class="ws">
    <!-- No project selected — the rail invites a choice. -->
    <div v-if="!store.selectedGroupId" class="ws__blank">
      <div class="ws__blank-eyebrow mono">КЕРМАНИЧ</div>
      <p class="ws__blank-text">Виберіть проєкт у лівій панелі, щоб побачити його агентів.</p>
    </div>

    <div v-else class="ws__content">
      <!-- BOARD — one card per session in the selected group -->
      <section class="ws__board">
        <header class="ws__board-head">
          <div class="ws__board-title">
            <div class="ws__eyebrow mono">РОБОЧИЙ ПРОСТІР</div>
            <h1 class="ws__heading">{{ selectedGroup?.name ?? 'Проєкт' }}</h1>
          </div>
          <KBtn variant="primary" @click="openLauncher">+ Новий агент</KBtn>
        </header>

        <KTable
          v-if="groupSessions.length"
          class="ws__table"
          :columns="agentColumns"
          :rows="groupSessions"
          :row-key="(s) => s.id"
          :selected-key="store.selectedSessionId"
          :row-class="(s) => (isRunning(s) ? 'ws__row--running' : undefined)"
          clickable
          @row-click="store.selectSession($event.id)"
        >
          <template #cell-status="{ row }">
            <span class="ws__cell-status">
              <KStatusDot :status="row.status" />
              <span class="ws__cell-status-word mono">{{ statusWord(row) }}</span>
            </span>
          </template>
          <template #cell-name="{ row }">
            <span class="ws__cell-name">{{ row.name }}</span>
          </template>
          <template #cell-branch="{ row }">
            <KTag>⑂ {{ row.branch }}</KTag>
          </template>
          <template #cell-ctx="{ row }">
            {{ ctxOf(row) ?? '—' }}
          </template>
          <template #cell-activity="{ row }">
            <span class="ws__cell-activity mono">{{ activityOf(row) || '—' }}</span>
          </template>
          <template #cell-actions="{ row }">
            <div class="ws__cell-actions">
              <button
                type="button"
                class="ws__card-icon"
                :class="{ 'ws__card-icon--on': store.previews[row.id] }"
                :title="store.previews[row.id] ? 'Зупинити превʼю' : 'Превʼю гілки в браузері'"
                @click.stop="togglePreview(row)"
              >{{ store.previews[row.id] ? '◼' : '▶' }}</button>
              <button
                v-if="row.status !== 'merged'"
                type="button"
                class="ws__card-icon"
                title="Завершити (merge гілки в проєкт)"
                @click.stop="openFinish(row)"
              >✓</button>
            </div>
          </template>
        </KTable>
        <div v-else class="ws__empty mono">
          Ще немає агентів. Запусти першого через «+ Новий агент».
        </div>
      </section>

      <!-- DETAIL — the full panel for the selected session -->
      <aside v-if="selectedSession" class="ws__detail">
        <div class="ws__detail-bar">
          <span class="ws__detail-label mono">{{ selectedSession.name }}</span>
          <button
            type="button"
            class="ws__close"
            title="Закрити"
            @click="store.selectSession(undefined)"
          >✕</button>
        </div>
        <KPanel
          class="ws__panel"
          :session="selectedSession"
          v-bind="selectedGroup ? { group: selectedGroup } : {}"
          @stop="onStop"
          @delete="onDelete"
          @send="onSend"
          @answer="onAnswer"
          @finish="onFinish"
          @editor="onEditor"
        >
          <template v-if="entries.length">
            <KLogBlock v-for="(entry, i) in entries" :key="i" :entry="entry" />
          </template>
          <div v-else class="ws__log-empty mono">Журнал порожній.</div>
        </KPanel>
      </aside>
    </div>

    <!-- NEW-AGENT LAUNCHER — opened by the inline button -->
    <KModal v-model="launcherOpen" title="Новий агент">
      <div class="ws__form">
        <KField v-model="draftName" label="Назва" placeholder="refactor-auth" />
        <label class="ws__field">
          <span class="ws__field-label">Завдання</span>
          <textarea
            ref="taskInput"
            v-model="draftTask"
            class="ws__textarea mono"
            rows="5"
            placeholder="Опиши завдання для агента…"
            @paste="onLaunchPaste"
            @drop.prevent="onLaunchDrop"
            @dragover.prevent
          />
        </label>
        <div class="ws__attach-row">
          <button type="button" class="ws__attach-btn" @click="launchFileInput?.click()">
            📎 Додати зображення
          </button>
          <input
            ref="launchFileInput"
            type="file"
            accept="image/png,image/jpeg,image/gif,image/webp"
            multiple
            class="ws__file"
            @change="onLaunchFilePick"
          />
        </div>
        <KAttachStrip v-if="launchImages.length" :images="launchImages" @remove="removeLaunchImage" />
        <p v-if="launchError" class="ws__error" role="alert">{{ launchError }}</p>
        <KField
          v-model="draftModel"
          label="Модель (необовʼязково)"
          placeholder="opus-5"
        />
        <p v-if="launcherError" class="ws__error" role="alert">{{ launcherError }}</p>
      </div>
      <template #controls>
        <KBtn variant="ghost" @click="launcherOpen = false">Скасувати</KBtn>
        <KBtn variant="primary" :disabled="!canLaunch" @click="submitLauncher">
          Запустити
        </KBtn>
      </template>
    </KModal>

    <!-- PREVIEW CONFIG — how to run this project's app for a live branch preview -->
    <KModal v-model="previewCfgOpen" title="Налаштувати превʼю">
      <div class="ws__form">
        <label class="ws__field">
          <span class="ws__field-label">Команда web (з $PORT)</span>
          <textarea v-model="draftWebCmd" class="ws__textarea mono" rows="2" />
        </label>
        <label class="ws__field">
          <span class="ws__field-label">Команда api (опційно; отримує PORT)</span>
          <textarea v-model="draftApiCmd" class="ws__textarea mono" rows="2" />
        </label>
        <p class="ws__hint mono">
          Запускається в worktree. web відкриється на автопорті; якщо задано api —
          підніметься першим, а web вкажеться на нього через VITE_API_BASE.
        </p>
      </div>
      <template #controls>
        <KBtn variant="ghost" @click="previewCfgOpen = false">Скасувати</KBtn>
        <KBtn variant="primary" :disabled="!draftWebCmd.trim()" @click="submitPreviewConfig">
          Запустити превʼю
        </KBtn>
      </template>
    </KModal>

    <!-- FINISH — merge the session branch into the project branch, retire the worktree -->
    <KModal
      :model-value="finishOpen"
      @update:model-value="onFinishOpen"
      title="Завершити сесію"
      persistent
    >
      <div class="ws__form">
        <div v-show="finishFiles.length">
          <p class="ws__error" role="alert">
            Конфлікт при злитті — розвʼяжи його у worktree, потім «Влити» ще раз.
          </p>
          <p class="ws__hint mono">Файли з конфліктом:</p>
          <ul class="ws__conflict mono">
            <li v-for="f in finishFiles" :key="f">{{ f }}</li>
          </ul>
          <p class="ws__hint mono">
            Відкрий у редакторі, прибери маркери конфлікту, закоміть — тоді «Влити».
          </p>
        </div>
        <div v-show="!finishFiles.length">
          <p v-if="finishData">
            Влити <code class="mono">{{ finishData.branch }}</code> →
            <code class="mono">{{ finishData.target }}</code>
          </p>
          <p v-if="finishData" class="ws__hint mono">
            {{ finishData.ahead }} комітів{{ finishData.dirty ? ' + незакоммічені зміни (авто-коміт)' : '' }};
            worktree буде прибрано, сесія лишиться як «влито».
          </p>
          <p v-else class="ws__hint mono">Готую…</p>
        </div>
        <p v-if="finishError" class="ws__error" role="alert">{{ finishError }}</p>
      </div>
      <template #controls>
        <KBtn variant="ghost" @click="finishOpen = false">Закрити</KBtn>
        <KBtn v-show="finishFiles.length" variant="secondary" @click="openEditorForFinish">Відкрити в редакторі</KBtn>
        <KBtn
          variant="primary"
          :disabled="finishBusy || (!finishData && !finishFiles.length)"
          @click="submitFinish"
        >{{ finishFiles.length ? 'Спробувати ще' : 'Влити' }}</KBtn>
      </template>
    </KModal>
  </main>
</template>

<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import type {
  ImageInput,
  Session,
  TranscriptEntry,
  RpcExtensionUIResponse,
} from '@kermanych/core';
import { useOrchestrator } from 'stores/orchestrator';
import type { MessageMode } from '../lib/api';
import KPanel from 'components/kit/KPanel.vue';
import KLogBlock from 'components/kit/KLogBlock.vue';
import KStatusDot from 'components/kit/KStatusDot.vue';
import KTag from 'components/kit/KTag.vue';
import KTable, { type KTableColumn } from 'components/kit/KTable.vue';
import KBtn from 'components/kit/KBtn.vue';
import KField from 'components/kit/KField.vue';
import KModal from 'components/kit/KModal.vue';
import KAttachStrip from 'components/kit/KAttachStrip.vue';
import { useImageAttach } from '../composables/useImageAttach';

// The Workspace screen (design-system section 07): the board of session cards
// for the selected group + the full panel for the selected session, plus the
// new-agent launcher. All mutations go through the Pinia store.
const store = useOrchestrator();

const groupSessions = computed(() =>
  store.sessions.filter((s) => s.groupId === store.selectedGroupId),
);
const selectedGroup = computed(() =>
  store.groups.find((g) => g.id === store.selectedGroupId),
);
const selectedSession = computed(() =>
  store.sessions.find((s) => s.id === store.selectedSessionId),
);
const entries = computed<TranscriptEntry[]>(() =>
  store.selectedSessionId
    ? store.transcripts[store.selectedSessionId] ?? []
    : [],
);

// Columns for the agents table. `status`, `ctx`, `activity`, and `actions` are
// rendered by scoped slots; `name`/`branch` also carry custom cells.
const agentColumns: KTableColumn[] = [
  { key: 'status', label: 'Статус', width: '132px' },
  { key: 'name', label: 'Агент' },
  { key: 'branch', label: 'Гілка', width: '170px' },
  { key: 'ctx', label: 'Контекст', align: 'right', width: '96px', mono: true },
  { key: 'activity', label: 'Активність' },
  { key: 'actions', label: '', align: 'right', width: '84px' },
];

function isRunning(s: Session): boolean {
  return s.status === 'thinking' || s.status === 'tool';
}

// ctx% is already 0–100 as reported by omp — render verbatim, never ×100.
function ctxOf(s: Session): string | undefined {
  return s.contextPercent != null ? `${s.contextPercent.toFixed(0)}%` : undefined;
}

// Card sub-line: the live tool, else the in-progress todo, else the status.
function activityOf(s: Session): string {
  if (s.currentTool) return s.currentTool;
  for (const phase of s.todoPhases ?? []) {
    const task = phase.tasks.find((t) => t.status === 'in_progress');
    if (task) return task.content;
  }
  return '';
}

function statusWord(s: Session): string {
  switch (s.status) {
    case 'thinking':
      return 'думає';
    case 'tool':
      return 'інструмент';
    case 'waiting_input':
      return 'чекає';
    case 'done':
      return 'готово';
    case 'error':
      return 'помилка';
    case 'queued':
      return 'у черзі';
    case 'stopped':
      return 'зупинено';
    case 'merged':
      return 'влито';
    case 'conflict':
      return 'конфлікт';
    default:
      return s.status;
  }
}

// Lazy-load the transcript the first time a session is opened.
watch(
  () => store.selectedSessionId,
  (id) => {
    if (id && store.transcripts[id] === undefined) {
      void store.loadTranscript(id);
    }
  },
  { immediate: true },
);

// ── New-agent launcher ────────────────────────────────────────────────────
const launcherOpen = ref(false);
const draftName = ref('');
const draftTask = ref('');
const draftModel = ref('');
const taskInput = ref<HTMLTextAreaElement | null>(null);
const launcherError = ref<string | null>(null);
const {
  images: launchImages,
  error: launchError,
  onPaste: onLaunchPaste,
  onDrop: onLaunchDrop,
  remove: removeLaunchImage,
  clear: clearLaunchImages,
  addFiles: addLaunchFiles,
} = useImageAttach();
const launchFileInput = ref<HTMLInputElement | null>(null);

function onLaunchFilePick(e: Event): void {
  const input = e.target as HTMLInputElement;
  if (input.files) void addLaunchFiles(input.files);
  input.value = '';
}

const canLaunch = computed(
  () =>
    !!store.selectedGroupId &&
    draftName.value.trim() !== '' &&
    draftTask.value.trim() !== '',
);

function openLauncher(): void {
  draftName.value = '';
  draftTask.value = '';
  draftModel.value = '';
  launcherError.value = null;
  clearLaunchImages();
  launcherOpen.value = true;
  void nextTick(() => taskInput.value?.focus());
}

async function submitLauncher(): Promise<void> {
  const groupId = store.selectedGroupId;
  if (!groupId || !canLaunch.value) return;
  const model = draftModel.value.trim() || undefined;
  launcherError.value = null;
  try {
    const session = await store.createSession(
      groupId,
      draftName.value.trim(),
      draftTask.value.trim(),
      model,
      launchImages.value.map((i) => ({ data: i.data, mimeType: i.mimeType })),
    );
    launcherOpen.value = false;
    clearLaunchImages();
    if (session?.id) store.selectSession(session.id);
  } catch (e) {
    // Keep the launcher open so the task/name are not lost; show the reason.
    launcherError.value = e instanceof Error ? e.message : String(e);
  }
}

// ── Detail panel emits → store actions ───────────────────────────────────
function onSend(text: string, images: ImageInput[]): void {
  const s = selectedSession.value;
  if (!s) return;
  // Done → a fresh follow-up turn; otherwise steer the in-flight turn.
  const mode: MessageMode = s.status === 'done' ? 'follow_up' : 'steer';
  void store.sendMessage(s.id, text, mode, images);
}

function onStop(): void {
  const s = selectedSession.value;
  if (s) void store.stopSession(s.id);
}

async function onDelete(): Promise<void> {
  const s = selectedSession.value;
  if (!s) return;
  if (!window.confirm(`Видалити агента «${s.name}»?`)) return;
  await store.deleteSession(s.id);
  if (store.selectedSessionId === s.id) store.selectSession(undefined);
}

function onAnswer(res: RpcExtensionUIResponse): void {
  const s = selectedSession.value;
  if (s) void store.answerUi(s.id, res);
}

// ── Finish (merge session branch → project branch, retire worktree) ────────
const finishOpen = ref(false);
const finishFor = ref<Session | null>(null);
const finishData = ref<{ branch: string; target: string; ahead: number; dirty: boolean; conflicts: string[] } | null>(null);
const finishConflict = ref<string[] | null>(null);
const finishError = ref<string | null>(null);
const finishBusy = ref(false);

// Files to resolve: from a just-attempted merge, else the worktree's current state.
const finishFiles = computed(() => finishConflict.value ?? finishData.value?.conflicts ?? []);

async function openFinish(s: Session): Promise<void> {
  finishFor.value = s;
  finishData.value = null;
  finishConflict.value = null;
  finishError.value = null;
  finishBusy.value = false;
  finishOpen.value = true;
  try {
    finishData.value = await store.finishInfo(s.id);
  } catch (e) {
    finishError.value = e instanceof Error ? e.message : String(e);
  }
}

function onFinish(): void {
  const s = selectedSession.value;
  if (s) void openFinish(s);
}

function onEditor(): void {
  const s = selectedSession.value;
  if (s) void store.openEditor(s.id).catch(() => {});
}

async function openEditorForFinish(): Promise<void> {
  const s = finishFor.value;
  if (!s) return;
  try {
    await store.openEditor(s.id);
  } catch (e) {
    finishError.value = e instanceof Error ? e.message : String(e);
  }
}

async function submitFinish(): Promise<void> {
  const s = finishFor.value;
  if (!s) return;
  finishBusy.value = true;
  finishError.value = null;
  try {
    const res = await store.finishSession(s.id);
    if ('conflict' in res && res.conflict) {
      // Conflict — target pulled into the worktree; keep the modal open to resolve.
      finishConflict.value = res.files;
    } else {
      finishOpen.value = false;
    }
  } catch (e) {
    // Dirty project tree or still-unresolved worktree conflict — surface git's message.
    finishError.value = e instanceof Error ? e.message : String(e);
  } finally {
    finishBusy.value = false;
  }
}

function onFinishOpen(v: boolean): void {
  // Only explicit buttons close the finish modal. Ignore QDialog's own dismissals
  // (it can emit a close on the post-merge re-render) while a finish is in flight or
  // a conflict is still unresolved.
  if (v) {
    finishOpen.value = true;
    return;
  }
  if (finishBusy.value || finishFiles.value.length) return;
  finishOpen.value = false;
}

// ── Live preview (per-session worktree app on a free port) ─────────────────
const LOADING_HTML =
  '<p style="font:14px system-ui;padding:24px;color:#888">Піднімаю превʼю гілки… (перший раз довше — встановлення залежностей).</p>';
const DEFAULT_WEB_CMD = 'cd kermanych && pnpm --filter @kermanych/ui dev';
// Fresh worktrees carry no build output (dist is gitignored), so build the shared
// core and the api before starting it — otherwise `node dist/main.js` is MODULE_NOT_FOUND.
const DEFAULT_API_CMD =
  'cd kermanych && pnpm install && pnpm --filter @kermanych/core build && pnpm --filter @kermanych/api build && pnpm --filter @kermanych/api start';
const previewCfgOpen = ref(false);
const previewCfgSession = ref<Session | null>(null);
const draftWebCmd = ref('');
const draftApiCmd = ref('');

async function launchInto(win: Window | null, s: Session): Promise<void> {
  try {
    const res = await store.startPreview(s.id);
    if (res.needsCommand) {
      win?.close();
      openPreviewConfig(s);
      return;
    }
    if (res.url && win) win.location.href = res.url;
    else win?.close();
  } catch (e) {
    win?.close();
    window.alert(`Превʼю не запустилось: ${e instanceof Error ? e.message : String(e)}`);
    openPreviewConfig(s, true); // reopen prefilled with working defaults so the user can fix it
  }
}

async function togglePreview(s: Session): Promise<void> {
  if (store.previews[s.id]) {
    await store.stopPreview(s.id);
    return;
  }
  const g = store.groups.find((x) => x.id === s.groupId);
  if (!g?.previewCommand) {
    openPreviewConfig(s);
    return;
  }
  const win = window.open('', '_blank');
  win?.document.write(LOADING_HTML);
  await launchInto(win, s);
}

function openPreviewConfig(s: Session, forceDefaults = false): void {
  previewCfgSession.value = s;
  const g = store.groups.find((x) => x.id === s.groupId);
  draftWebCmd.value = (forceDefaults ? '' : g?.previewCommand ?? '') || DEFAULT_WEB_CMD;
  draftApiCmd.value = (forceDefaults ? '' : g?.apiCommand ?? '') || DEFAULT_API_CMD;
  previewCfgOpen.value = true;
}

async function submitPreviewConfig(): Promise<void> {
  const s = previewCfgSession.value;
  if (!s) return;
  const win = window.open('', '_blank');
  win?.document.write(LOADING_HTML);
  previewCfgOpen.value = false;
  try {
    const patch: { previewCommand: string; apiCommand?: string } = {
      previewCommand: draftWebCmd.value.trim(),
    };
    const apiCmd = draftApiCmd.value.trim();
    if (apiCmd) patch.apiCommand = apiCmd;
    await store.updateGroup(s.groupId, patch);
  } catch (e) {
    win?.close();
    window.alert(`Не вдалось зберегти: ${e instanceof Error ? e.message : String(e)}`);
    return;
  }
  await launchInto(win, s);
}
</script>

<style scoped lang="scss">
// Fixed header (48px) + footer (30px) are overlaid by the Quasar layout; the
// workspace fills exactly the space between them.
.ws {
  height: calc(100vh - 78px);
  overflow: hidden;
}

// ── Blank / no-project state ──────────────────────────────────────────────
.ws__blank {
  height: 100%;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  justify-content: center;
  gap: 10px;
  padding: 0 40px;
}

.ws__blank-eyebrow {
  font-size: 11px;
  letter-spacing: 0.2em;
  color: var(--k-muted);
}

.ws__blank-text {
  margin: 0;
  font-family: var(--k-font-ui);
  font-size: 15px;
  color: var(--k-muted);
}

// ── Board + detail split ──────────────────────────────────────────────────
.ws__content {
  display: flex;
  height: 100%;
  min-height: 0;
}

.ws__board {
  flex: 1;
  min-width: 0;
  overflow-y: auto;
  padding: 22px 24px 28px;
}

.ws__board-head {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 20px;
  margin-bottom: 20px;
}

.ws__eyebrow {
  font-size: 11px;
  letter-spacing: 0.2em;
  color: var(--k-muted);
}

.ws__heading {
  margin: 4px 0 0;
  text-align: left;
  font-family: var(--k-font-ui);
  font-size: 22px;
  font-weight: 800;
  letter-spacing: -0.01em;
  color: var(--k-text);
}

// ── Agents table ──────────────────────────────────────────────────────────
.ws__cell-status {
  display: inline-flex;
  align-items: center;
  gap: 8px;
}

.ws__cell-status-word {
  font-size: 11px;
  color: var(--k-muted);
  white-space: nowrap;
}

.ws__cell-name {
  font-family: var(--k-font-ui);
  font-size: 14px;
  font-weight: 700;
  color: var(--k-text);
}

.ws__cell-activity {
  display: inline-block;
  max-width: 320px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12px;
  color: var(--k-muted);
  vertical-align: middle;
}

.ws__cell-actions {
  display: inline-flex;
  gap: 4px;
  justify-content: flex-end;
}

// running — accent strip on the row's leading edge (mirrors the card).
.ws__table :deep(tr.ws__row--running td:first-child) {
  box-shadow: inset 2px 0 0 0 var(--k-accent);
}

.ws__card-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  padding: 0;
  border: 1px solid var(--k-line);
  background: transparent;
  color: var(--k-muted);
  font-size: 10px;
  line-height: 1;
  cursor: pointer;
  border-radius: 0;
}

.ws__card-icon:hover {
  border-color: var(--k-text);
  color: var(--k-text);
}

.ws__card-icon--on {
  border-color: var(--k-accent);
  color: var(--k-accent);
}

.ws__hint {
  margin: 0;
  font-size: 11px;
  line-height: 1.5;
  color: var(--k-muted);
}

.ws__empty {
  padding: 24px 2px;
  font-size: 13px;
  color: var(--k-muted);
}

// ── Detail column ─────────────────────────────────────────────────────────
.ws__detail {
  flex: none;
  width: 560px;
  max-width: 48vw;
  display: flex;
  flex-direction: column;
  min-height: 0;
  border-left: 2px solid var(--k-line-strong);
}

.ws__detail-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  height: 34px;
  padding: 0 6px 0 14px;
  background: var(--k-bg);
  border-bottom: 2px solid var(--k-line-strong);
  flex: none;
}

.ws__detail-label {
  font-size: 12px;
  color: var(--k-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ws__close {
  width: 24px;
  height: 24px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: none;
  background: transparent;
  color: var(--k-muted);
  font-size: 13px;
  cursor: pointer;

  &:hover {
    color: var(--k-text);
  }

  &:focus-visible {
    outline: 1px solid var(--k-accent);
    outline-offset: -1px;
  }
}

.ws__panel {
  flex: 1;
  min-height: 0;
}

.ws__log-empty {
  font-size: 12px;
  color: var(--k-muted);
}

// ── Launcher form ─────────────────────────────────────────────────────────
.ws__form {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.ws__field {
  display: flex;
  flex-direction: column;
  gap: 6px;
  font-family: var(--k-font-ui);
}

.ws__field-label {
  text-align: left;
  font-size: 13px;
  color: var(--k-text);
}

.ws__textarea {
  font-family: var(--k-font-mono);
  font-size: 13px;
  line-height: 1.5;
  color: var(--k-text);
  background: var(--k-surface);
  border: 1px solid var(--k-line-strong);
  padding: 9px 11px;
  border-radius: 0;
  outline: none;
  resize: vertical;
  transition: border-color 0.12s, box-shadow 0.12s;

  &::placeholder {
    color: var(--k-muted);
  }

  &:focus {
    border-color: var(--k-accent);
    box-shadow: inset 0 0 0 1px var(--k-accent);
  }
}

.ws__error {
  margin: 0;
  font-size: 12.5px;
  line-height: 1.5;
  color: var(--k-accent);
}

.ws__attach-row {
  display: flex;
}

.ws__attach-btn {
  padding: 6px 10px;
  background: var(--k-surface2);
  border: 1px solid var(--k-line-strong);
  color: var(--k-text);
  font-family: var(--k-font-ui);
  font-size: 12px;
  cursor: pointer;
  border-radius: 0;
}

.ws__attach-btn:hover {
  border-color: var(--k-text);
}

.ws__file {
  display: none;
}
</style>
