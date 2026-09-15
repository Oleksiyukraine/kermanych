<template>
  <main class="chat">
    <!-- No project bound → nothing to chat about yet. -->
    <div v-if="!store.selectedProjectId" class="chat__blank mono">
      {{ t('chat.page.blank') }}
    </div>

    <!-- Two columns, mirroring the Агенти screen: the left rail is this project's chat
         HISTORY — one row per `kind: 'chat'` session — and the right column is the exact same
         KPanel + KRequestBlock stack the Агенти detail renders, so the two chats are one
         component. Switching a row swaps `chatId`; nothing is destroyed. The chat-only header
         actions (promote ▶, backlog ⊕, discard ✕) live inside KPanel, gated on
         `session.kind === 'chat'`. -->
    <div
      v-else
      ref="contentEl"
      class="chat__content"
      :class="{ 'chat__content--resizing': resizing }"
    >
      <!-- HISTORY — the threads of this project, newest first, archived ones hidden. -->
      <section class="chat__history" :style="{ width: historyWidth + 'px' }">
        <header class="chat__history-head">
          <div class="chat__history-title">
            <span class="chat__history-label">{{ t('chat.page.historyTitle') }}</span>
            <span class="chat__history-count mono">{{ threads.length }}</span>
          </div>
          <KBtn variant="primary" @click="newChat">{{ t('chat.page.newChat') }}</KBtn>
        </header>

        <div v-if="threads.length" class="chat__threads">
          <!-- `branch` is intentionally empty: a chat has none, and KSessionCard heads the
               card with `branch || title`, so anything passed here would hide the title. -->
          <KSessionCard
            v-for="s in threads"
            :key="s.id"
            :branch="''"
            :title="threadTitle(s)"
            :time="renderTime(t, relativeTime(s.lastActivityAt, now))"
            :status="s.status"
            :model="s.model"
            :usage="s.usage"
            :selected="s.id === chatId"
            removable
            :remove-title="t('chat.page.archiveThread', { title: threadTitle(s) })"
            @click="selectThread(s.id)"
            @remove="archiveThread(s.id)"
          />
        </div>
        <div v-else class="chat__history-empty mono">{{ t('chat.page.historyEmpty') }}</div>
      </section>

      <!-- RESIZER — drag the seam to widen / narrow the history rail. -->
      <div
        class="chat__resizer"
        role="separator"
        aria-orientation="vertical"
        :aria-label="t('chat.page.resizeAria')"
        :aria-valuenow="Math.round(historyWidth)"
        :aria-valuemin="MIN_HISTORY"
        tabindex="0"
        v-tip="t('chat.page.resizeTip')"
        @pointerdown="startResize"
        @keydown="onResizeKeydown"
      ></div>

      <!-- DETAIL — the selected thread's full panel. -->
      <aside class="chat__detail">
        <KPanel
          v-if="chatSession"
          class="chat__panel"
          :session="chatSession"
          :promoting="promoting"
          :refreshing="refreshing"
          :filing="filing"
          :clearing="clearing"
          :models="store.models"
          :placeholder="t('chat.page.placeholder')"
          @stop="onStop"
          @send="onSend"
          @answer="onAnswer"
          @editor="onEditor"
          @restart="onRestart"
          @refresh="onRefresh"
          @summary="onSummary"
          @newTask="onNewTask"
          @promoteAgent="promote"
          @promoteTask="toBacklog"
          @clear="clearChat"
          @expand-all="onExpandAll"
          @effort="onEffort"
          @set-model="onSetModel"
        >
          <template v-if="blocks.length">
            <KRequestBlock
              v-for="(block, i) in blocks"
              :key="chatSession.id + ':' + block.id"
              :block="block"
              :session-id="chatSession.id"
              :open="i === blocks.length - 1"
              :expand-all="expandAll"
            />
          </template>
          <div v-else class="chat__log-empty mono">{{ t('chat.page.empty') }}</div>
        </KPanel>
        <div v-else class="chat__detail-blank mono">{{ t('chat.page.detailBlank') }}</div>
      </aside>
    </div>
  </main>
</template>

<script setup lang="ts">
// v3 Чат — a two-column screen: the left rail lists this project's chat threads (one
// `kind: 'chat'` session each), the right column renders the selected thread through the
// SAME KPanel + KRequestBlock stack as the Агенти page's chat, so the two are one component.
// Log grouping, decision block, stall banner, live status, todo lane, my-message navigation
// and the composer's model/effort chips all come for free.
import { computed, nextTick, onMounted, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import { useI18n } from 'vue-i18n';
import { buildChatBlocks, taskNameFromText } from '@kermanych/core';
import type { ImageInput, RpcExtensionUIResponse, Session, ThinkingLevel } from '@kermanych/core';
import { useOrchestrator } from 'stores/orchestrator';
import { useBoard } from 'stores/board';
import { useAuth } from 'stores/auth';
import { useProjects } from 'stores/projects';
import type { MessageMode } from '../lib/api';
import { taskInsertFromDraft } from '../lib/tasks-view';
import { EXPAND_ALL_NONE, nextExpandAll, type ExpandAllCommand } from '../lib/expand-all';
import { relativeTime, renderTime } from '../lib/time';
import { useNow } from '../composables/useNow';
import { useResizableWidth } from '../composables/useResizableWidth';
import KPanel from 'components/kit/KPanel.vue';
import KRequestBlock from 'components/kit/KRequestBlock.vue';
import KSessionCard from 'components/kit/KSessionCard.vue';
import KBtn from 'components/kit/KBtn.vue';

const store = useOrchestrator();
const board = useBoard();
const auth = useAuth();
const projects = useProjects();
const router = useRouter();
const { t } = useI18n();
const now = useNow();

const chatId = ref<string | undefined>(undefined);
// Promotion spins up a worktree and respawns omp; the ▶ stays down until the server answers.
const promoting = ref(false);
// The composer's ↻ (rehydrate) stays down until the server answers.
const refreshing = ref(false);
// «В беклог» files a cloud card; the ⊕ stays down until the write returns.
const filing = ref(false);
// The panel ✕ archives the current thread; it stays down until the write returns.
const clearing = ref(false);
// «розгорнути / стиснути все» is per-session detail state — reset on a chat switch so a
// stale command is not adopted by the newly opened session's rows.
const expandAll = ref<ExpandAllCommand>(EXPAND_ALL_NONE);

const BIND_HINT = computed(() => t('chat.page.bindHint'));
const selectedProject = computed(() => store.projects.find((p) => p.id === store.selectedProjectId));
const isBound = computed(() => !!selectedProject.value?.localRepoPath);
const chatSession = computed(() => store.sessions.find((s) => s.id === chatId.value));
// Guard against a double-create if the project changes mid-flight while a create is pending.
let ensuring = false;

// This project's chat threads, newest activity first, archived ones hidden. The server
// already keys any number of `kind: 'chat'` sessions per project (supervisor createChat
// names them `чат N`); this rail is the surface that finally shows all of them.
const threads = computed(() =>
  store.sessions
    .filter((s) => s.kind === 'chat' && s.projectId === store.selectedProjectId && !s.archived)
    .sort((a, b) => new Date(b.lastActivityAt).getTime() - new Date(a.lastActivityAt).getTime()),
);

// A thread's row title: the first line of its opening ask (server stamps `task` on the first
// message) once there is one, else the server's `чат N` placeholder.
function threadTitle(s: Session): string {
  return taskNameFromText(s.task) || s.name;
}

// A thread nobody has spoken in yet. Uses the loaded transcript when present, else the
// server-stamped `task` as a proxy (empty until the first message) — enough to reuse a blank
// thread instead of stacking more of them.
function isEmptyThread(s: Session): boolean {
  const tr = store.transcripts[s.id];
  if (tr) return !tr.some((e) => e.kind === 'user_text' || e.kind === 'assistant_text');
  return !s.task.trim();
}

const blocks = computed(() =>
  chatId.value ? buildChatBlocks(store.transcripts[chatId.value] ?? []) : [],
);

// The history rail's width, mirroring the Агенти board/detail split: the left column carries
// the persisted width, the detail flexes into the rest, and a shrinking viewport can never
// drive either below its floor.
const MIN_HISTORY = 240;
const MIN_DETAIL = 360;
const contentEl = ref<HTMLElement | null>(null);
const {
  width: historyWidth,
  resizing,
  startResize,
  onKeydown: onResizeKeydown,
  refresh: refreshHistoryWidth,
} = useResizableWidth({
  storageKey: 'kermanych.chat.history-width',
  defaultWidth: 300,
  min: MIN_HISTORY,
  max: () => (contentEl.value ? contentEl.value.clientWidth - MIN_DETAIL : Number.POSITIVE_INFINITY),
});

// Which omp message mode the next message takes. A fresh chat starts its first turn with a
// prompt; a settled chat gets a follow-up; a live one is steered mid-turn. Same rule as the
// Агенти panel, so a chat and an agent read identically.
function nextMode(s: Session): MessageMode {
  const history = store.transcripts[s.id] ?? [];
  const hasTurn = history.some((e) => e.kind === 'user_text' || e.kind === 'assistant_text');
  return !hasTurn ? 'prompt' : s.status === 'done' ? 'follow_up' : 'steer';
}

async function onSend(text: string, images: ImageInput[]): Promise<void> {
  const s = chatSession.value;
  if (!s) return;
  try {
    await store.sendMessage(s.id, text, nextMode(s), images);
  } catch (e) {
    // A failed send (e.g. the omp child died and could not be respawned) must be visible,
    // not swallowed — otherwise the chat looks silently stuck.
    store.notify(e instanceof Error ? e.message : String(e), 'error');
  }
}

function onStop(): void {
  const s = chatSession.value;
  if (s) void store.stopSession(s.id);
}

function onAnswer(res: RpcExtensionUIResponse): void {
  const s = chatSession.value;
  if (s) void store.answerUi(s.id, res);
}

function onEditor(): void {
  const s = chatSession.value;
  if (s) void store.openEditor(s.id).catch(() => {});
}

async function onRestart(): Promise<void> {
  const s = chatSession.value;
  if (!s) return;
  try {
    await store.restartSession(s.id);
  } catch (e) {
    store.notify(e instanceof Error ? e.message : String(e), 'error');
  }
}

// Composer ↻ — wake a dormant chat so its history comes back. After an app restart the api
// has no omp child for the session, so the transcript reads empty; this respawns the child
// and reloads its transcript without sending anything.
async function onRefresh(): Promise<void> {
  const s = chatSession.value;
  if (!s || refreshing.value) return;
  refreshing.value = true;
  try {
    await store.resumeSession(s.id);
  } catch (e) {
    store.notify(e instanceof Error ? e.message : String(e), 'error');
  } finally {
    refreshing.value = false;
  }
}

// Composer ≡ — ask the chat itself to recap. The same canned operator message as the Агенти
// panel, so the summary reads the same wherever it is asked for.
async function onSummary(): Promise<void> {
  const s = chatSession.value;
  if (!s) return;
  try {
    await store.sendMessage(s.id, t('agents.prompt.summary'), nextMode(s));
  } catch (e) {
    store.notify(e instanceof Error ? e.message : String(e), 'error');
  }
}

function onExpandAll(on: boolean): void {
  expandAll.value = nextExpandAll(expandAll.value, on);
}

// The composer's effort chip. omp refuses a level its provider cannot run and the api reports
// that refusal rather than writing the row — so a failure surfaces, or the chip snaps back
// with no explanation.
async function onEffort(level: ThinkingLevel): Promise<void> {
  const s = chatSession.value;
  if (!s) return;
  try {
    await store.setEffort(s.id, level);
  } catch (e) {
    store.notify(e instanceof Error ? e.message : String(e), 'error');
  }
}

// The composer's model picker — mirror of onEffort.
async function onSetModel(patch: { model: string; provider?: string }): Promise<void> {
  const s = chatSession.value;
  if (!s) return;
  try {
    await store.setSessionModel(s.id, patch);
  } catch (e) {
    store.notify(e instanceof Error ? e.message : String(e), 'error');
  }
}

// A text selection in the transcript → a backlog card: the same «В беклог» path as the
// header ⊕, but seeded from the picked passage instead of the opening ask.
async function onNewTask(text: string): Promise<void> {
  const pid = store.selectedProjectId;
  const userId = auth.user?.id;
  const seed = text.trim();
  if (!pid || !userId || !seed) return;
  if (!projects.byId.has(pid)) {
    store.notify(t('chat.page.notifyNotCloudTask'), 'error');
    return;
  }
  try {
    const card = await board.createTask(
      taskInsertFromDraft(
        {
          name: taskNameFromText(seed),
          task: seed,
          model: chatSession.value?.model,
          prefix: 'feature',
          worktree: true,
          hidden: false,
        },
        pid,
        userId,
      ),
    );
    if (!card) return; // the store has already said why
    store.setBucket('tasks');
    void router.push({ name: 'agents' });
  } catch (e) {
    store.notify(e instanceof Error ? e.message : String(e), 'error');
  }
}

// Select an existing thread and make sure its transcript is loaded so the log renders.
function selectThread(id: string): void {
  chatId.value = id;
  if (store.transcripts[id] === undefined) void store.loadTranscript(id);
}

// Reuse the most recent non-archived chat for the selected project, else create one. Then
// make sure its transcript is loaded so the log renders on first paint.
async function ensureChat(): Promise<void> {
  const pid = store.selectedProjectId;
  if (!pid) {
    chatId.value = undefined;
    return;
  }
  if (ensuring) return;
  ensuring = true;
  try {
    const existing = threads.value[0];
    if (existing) {
      chatId.value = existing.id;
    } else {
      const chat = await store.createChat(pid);
      chatId.value = chat?.id;
    }
    const id = chatId.value;
    if (id && store.transcripts[id] === undefined) void store.loadTranscript(id);
  } catch (e) {
    store.notify(e instanceof Error ? e.message : String(e), 'error');
  } finally {
    ensuring = false;
  }
}

// «+ Новий» — open a fresh thread. A blank thread is reused rather than duplicated, so the
// rail does not fill with empty `чат N` rows nobody typed in.
async function newChat(): Promise<void> {
  const pid = store.selectedProjectId;
  if (!pid || ensuring) return;
  const blank = threads.value.find(isEmptyThread);
  if (blank) {
    selectThread(blank.id);
    return;
  }
  ensuring = true;
  try {
    const chat = await store.createChat(pid);
    if (chat) {
      chatId.value = chat.id;
      if (store.transcripts[chat.id] === undefined) void store.loadTranscript(chat.id);
    }
  } catch (e) {
    store.notify(e instanceof Error ? e.message : String(e), 'error');
  } finally {
    ensuring = false;
  }
}

// Archive a thread — a non-destructive hide, not a delete: the transcript and omp session
// survive, so a chat parked here is recoverable rather than gone. If it was the open one,
// advance to the next thread or spin up a fresh one so the detail column is never empty.
async function archiveThread(id: string): Promise<void> {
  try {
    await store.archiveSession(id);
  } catch (e) {
    store.notify(e instanceof Error ? e.message : String(e), 'error');
    return;
  }
  if (chatId.value === id) {
    const next = threads.value.find((s) => s.id !== id);
    if (next) {
      selectThread(next.id);
    } else {
      chatId.value = undefined;
      await newChat();
    }
  }
}

// Promotion grows a worktree and starts building, so it is agent work and needs a card —
// otherwise its status mirrors nowhere and the team never sees the run. The card is minted
// first and its id travels into the promotion, which stamps it on the row.
async function promote(): Promise<void> {
  // The button's `:disabled` is not a guarantee: keyboard and programmatic activation reach
  // here regardless, and a second run would mint a second card.
  if (promoting.value) return;
  const id = chatId.value;
  const pid = store.selectedProjectId;
  const userId = auth.user?.id;
  if (!id || !pid || !userId) return;
  const seed = chatSession.value?.task?.trim() ?? '';
  if (!projects.byId.has(pid)) {
    store.notify(t('chat.page.notifyNotCloudAgent'), 'error');
    return;
  }
  // Promotion grows a worktree, so without a local binding the card would be minted and then
  // refused server-side, orphaning it.
  if (!isBound.value) {
    store.notify(BIND_HINT.value, 'error');
    return;
  }
  promoting.value = true;
  try {
    const card = await board.createTask({
      projectId: pid,
      title: taskNameFromText(seed) || chatSession.value?.name || t('chat.page.defaultTaskName'),
      description: seed,
      ...(chatSession.value?.model ? { model: chatSession.value.model } : {}),
      prefix: 'feature',
      worktree: true,
      assigneeId: userId,
    });
    if (!card) return; // the store has already said why
    await store.promoteChat(id, card.id);
    store.setBucket('active');
    store.selectSession(id);
    void router.push({ name: 'agents' });
  } catch (e) {
    store.notify(e instanceof Error ? e.message : String(e), 'error');
  } finally {
    promoting.value = false;
  }
}

// «В беклог» files a CLOUD card assigned to me, so a thought parked in a chat is visible to
// the team exactly like anything else on the board. The card's name comes from the opening
// ask's first line and can be refined later from the Агенти backlog.
async function toBacklog(): Promise<void> {
  if (filing.value) return;
  const id = chatId.value;
  const pid = store.selectedProjectId;
  const userId = auth.user?.id;
  if (!id || !pid || !userId) return;
  const seed =
    (
      (store.transcripts[id] ?? []).find((e) => e.kind === 'user_text') as
        | { kind: 'user_text'; text: string }
        | undefined
    )?.text?.trim() ?? '';
  if (!seed) {
    store.notify(t('chat.page.notifyEmptyBacklog'), 'error');
    return;
  }
  if (!projects.byId.has(pid)) {
    store.notify(t('chat.page.notifyNotCloudTask'), 'error');
    return;
  }
  filing.value = true;
  try {
    const card = await board.createTask(
      taskInsertFromDraft(
        {
          name: taskNameFromText(seed),
          task: seed,
          model: chatSession.value?.model,
          prefix: 'feature',
          worktree: true,
          hidden: false,
        },
        pid,
        userId,
      ),
    );
    if (!card) return; // the store has already said why
    store.setBucket('tasks');
    void router.push({ name: 'agents' });
  } catch (e) {
    store.notify(e instanceof Error ? e.message : String(e), 'error');
  } finally {
    filing.value = false;
  }
}

// Panel ✕ — archive the open thread. Non-destructive (see archiveThread); the ✕ stays down
// until the write returns so a second click cannot race it.
async function clearChat(): Promise<void> {
  const id = chatId.value;
  if (!id || clearing.value) return;
  clearing.value = true;
  try {
    await archiveThread(id);
  } finally {
    clearing.value = false;
  }
}

onMounted(() => {
  void ensureChat();
  refreshHistoryWidth();
});
watch(
  () => store.selectedProjectId,
  () => {
    void ensureChat();
    void nextTick(refreshHistoryWidth);
  },
);
// A chat switch resets the detail toolbar so the new session's rows start neutral.
watch(chatId, () => {
  expandAll.value = EXPAND_ALL_NONE;
});
</script>

<style scoped lang="scss">
.chat {
  height: calc(100vh - 90px);
  overflow: hidden;
  padding: var(--k-sp-3);
  display: flex;
  flex-direction: column;
}

// The board/detail split, mirroring the Агенти screen: a fixed-width history rail, a
// draggable seam, and the detail column flexing into the rest.
.chat__content {
  flex: 1;
  min-height: 0;
  display: flex;
  gap: 0;
}

// While dragging, force the col-resize cursor everywhere and kill text selection so a fast
// drag doesn't highlight the rail or the log.
.chat__content--resizing,
.chat__content--resizing * {
  cursor: col-resize !important;
  user-select: none;
}

.chat__history {
  flex: none;
  min-width: 0;
  overflow-y: auto;
  padding-right: var(--k-sp-3);
}

.chat__history-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--k-sp-3);
  margin-bottom: var(--k-sp-3);
}

.chat__history-title {
  display: flex;
  align-items: baseline;
}

.chat__history-label {
  font-family: var(--k-font-ui);
  font-size: var(--k-fs-md);
  font-weight: var(--k-fw-semibold);
  color: var(--k-text);
}

.chat__history-count {
  margin-left: var(--k-sp-2);
  font-size: var(--k-fs-sm);
  color: var(--k-faint);
}

.chat__threads {
  display: flex;
  flex-direction: column;
  gap: var(--k-sp-2);
}

.chat__history-empty {
  padding: 24px 2px;
  font-size: var(--k-fs-sm);
  color: var(--k-muted);
}

// The draggable seam: a faint line by default, accent on hover / focus / active drag.
.chat__resizer {
  flex: none;
  width: 7px;
  position: relative;
  z-index: 3;
  padding: 0;
  border: none;
  background: transparent;
  cursor: col-resize;
  touch-action: none;
  user-select: none;
}

.chat__resizer::before {
  content: '';
  position: absolute;
  top: 0;
  bottom: 0;
  left: 50%;
  width: 1px;
  transform: translateX(-50%);
  background: var(--k-line);
  transition: background 0.12s;
}

.chat__resizer:hover::before,
.chat__resizer:focus-visible::before,
.chat__content--resizing .chat__resizer::before {
  background: var(--k-accent);
}

.chat__resizer:focus-visible {
  outline: none;
}

.chat__detail {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  padding-left: var(--k-sp-3);
}

// The panel fills the detail column; `min-height: 0` lets its inner log scroll instead of the
// panel growing past the viewport.
.chat__panel {
  flex: 1;
  min-height: 0;
}

.chat__detail-blank {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--k-faint);
  font-size: var(--k-fs-sm);
}

.chat__blank {
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--k-faint);
  font-size: var(--k-fs-sm);
}

.chat__log-empty {
  margin: auto;
  color: var(--k-faint);
  font-size: var(--k-fs-sm);
}
</style>
