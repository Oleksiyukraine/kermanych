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

        <div v-if="groupSessions.length" class="ws__grid">
          <button
            v-for="s in groupSessions"
            :key="s.id"
            type="button"
            class="ws__card"
            :class="{
              'ws__card--active': s.id === store.selectedSessionId,
              'ws__card--running': isRunning(s),
            }"
            @click="store.selectSession(s.id)"
          >
            <div class="ws__card-top">
              <KStatusDot :status="s.status" />
              <span class="ws__card-name">{{ s.name }}</span>
              <span class="ws__card-status mono">{{ statusWord(s) }}</span>
            </div>
            <div class="ws__card-meta">
              <KTag>⑂ {{ s.branch }}</KTag>
              <KTag v-if="ctxOf(s)">{{ ctxOf(s) }}</KTag>
            </div>
            <div class="ws__card-activity mono">{{ activityOf(s) || '—' }}</div>
          </button>
        </div>
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
        >
          <template v-if="entries.length">
            <KLogBlock v-for="(entry, i) in entries" :key="i" :entry="entry" />
          </template>
          <div v-else class="ws__log-empty mono">Журнал порожній.</div>
        </KPanel>
      </aside>
    </div>

    <!-- NEW-AGENT LAUNCHER — opened by the header signal or the inline button -->
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
  </main>
</template>

<script setup lang="ts">
import { computed, inject, nextTick, ref, watch } from 'vue';
import type { Ref } from 'vue';
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
import KBtn from 'components/kit/KBtn.vue';
import KField from 'components/kit/KField.vue';
import KModal from 'components/kit/KModal.vue';
import KAttachStrip from 'components/kit/KAttachStrip.vue';
import { useImageAttach } from '../composables/useImageAttach';

// The Workspace screen (design-system section 07): the board of session cards
// for the selected group + the full panel for the selected session, plus the
// new-agent launcher. All mutations go through the Pinia store.
const store = useOrchestrator();

// The header's "+ Новий агент" button (MainLayout) increments this signal; we
// open the launcher whenever it changes. Falls back to a local ref if a parent
// did not provide it (e.g. isolated tests).
const newAgentSignal = inject<Ref<number>>('kermanych.newAgentSignal', ref(0));

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

// Open the launcher when the header signal fires (requires a selected group).
watch(newAgentSignal, () => {
  if (store.selectedGroupId) openLauncher();
});

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

.ws__grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
  gap: 1px;
  background: var(--k-line);
  border: 1px solid var(--k-line);
}

// ── Session card ──────────────────────────────────────────────────────────
.ws__card {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 14px 14px 16px;
  background: var(--k-surface);
  border: none;
  border-radius: 0;
  text-align: left;
  cursor: pointer;
  transition: background 0.12s, box-shadow 0.12s;

  &:hover {
    background: var(--k-surface2);
  }

  &:focus-visible {
    outline: 1px solid var(--k-accent);
    outline-offset: -1px;
  }
}

// running — accent strip on the top edge, matching the active panel.
.ws__card--running {
  box-shadow: inset 0 2px 0 0 var(--k-accent);
}

// selected — surface2 fill + a 1px accent frame.
.ws__card--active {
  background: var(--k-surface2);
  box-shadow: inset 0 0 0 1px var(--k-accent);
}

.ws__card--active.ws__card--running {
  box-shadow: inset 0 0 0 1px var(--k-accent), inset 0 2px 0 0 var(--k-accent);
}

.ws__card-top {
  display: flex;
  align-items: center;
  gap: 9px;
  min-width: 0;
}

.ws__card-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: var(--k-font-ui);
  font-size: 14px;
  font-weight: 700;
  color: var(--k-text);
}

.ws__card-status {
  font-size: 11px;
  color: var(--k-muted);
  white-space: nowrap;
}

.ws__card-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.ws__card-activity {
  font-size: 11px;
  color: var(--k-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
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
