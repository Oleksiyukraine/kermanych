<template>
  <main class="chat">
    <!-- No project bound → nothing to chat about yet. -->
    <div v-if="!store.selectedProjectId" class="chat__blank mono">
      {{ t('chat.page.blank') }}
    </div>

    <!-- Two columns, the exact pattern the Агенти screen uses: a left list rail and a right
         detail column whose consolidated bar owns the identity while the embedded KPanel runs
         `bare`. Here the list holds this project's chat THREADS (one `kind: 'chat'` session
         each) and the bar carries the chat-only actions (promote ▶, backlog ⊕, archive ✕). -->
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

      <!-- DETAIL — the selected thread. Consolidated bar (identity + actions) over a `bare`
           KPanel, exactly as the Агенти detail column is built. -->
      <aside class="chat__detail">
        <template v-if="chatSession">
          <div class="chat__detail-bar">
            <div class="chat__detail-id">
              <KStatusDot :status="chatSession.status" />
              <input
                v-if="renaming"
                ref="renameInput"
                v-model="renameDraft"
                class="chat__detail-rename"
                :aria-label="t('chat.page.renameAria')"
                @keydown.enter.prevent="commitRename"
                @keydown.esc.prevent="cancelRename"
                @blur="commitRename"
              />
              <span
                v-else
                class="chat__detail-name"
                v-tip="t('chat.page.renameHint')"
                @dblclick="startRename"
              >{{ threadTitle(chatSession) }}</span>
            </div>
            <div class="chat__detail-controls">
              <span class="chat__detail-status mono">{{ harnessLabel }} · {{ statusWord(chatSession) }}</span>
              <div class="chat__actions">
                <!-- `title` names the action even while disabled; the reason a disabled ▶ can't
                     act is the visible note strip under this bar. -->
                <KIconButton
                  :disabled="promoting"
                  :title="promoting ? t('kit.panel.promoting') : t('kit.panel.promoteAgent')"
                  @click="promote"
                >▶</KIconButton>
                <KIconButton
                  :disabled="filing"
                  :title="t('kit.panel.promoteTask')"
                  @click="toBacklog"
                >⊕</KIconButton>
                <KIconButton
                  v-if="running"
                  :title="t('kit.panel.stop')"
                  @click="onStop"
                >■</KIconButton>
                <KIconButton
                  :title="t('kit.panel.editor')"
                  @click="onEditor"
                >⧉</KIconButton>
                <KIconButton
                  :disabled="clearing"
                  :title="t('chat.page.closeSession')"
                  @click="clearChat"
                >✕</KIconButton>
              </div>
            </div>
          </div>
          <!-- Why the ▶ above is down, on its own strip so the reason a disabled control
               carries no reachable tooltip is still stated. -->
          <p v-if="promoteBlocked" class="chat__detail-note">{{ BIND_HINT }}</p>

          <!-- One-tab bar over the log, the same row the Агенти detail uses: a «Лог» tab
               with the density switch («Розгорнути всі» / «Згорнути всі») pinned to its right
               edge, so the two screens read as one system instead of a mono strip here and a
               tab row there. -->
          <KTabs v-model="detailTab" :tabs="detailTabs" class="chat__detail-tabs">
            <template #end>
              <button type="button" class="chat__log-ctl" @click="onExpandAll(true)">{{ t('agents.detail.expandAll') }}</button>
              <button type="button" class="chat__log-ctl" @click="onExpandAll(false)">{{ t('agents.detail.collapseAll') }}</button>
            </template>
          </KTabs>

          <div class="chat__tabpane">
            <KPanel
              class="chat__panel"
              :bare="true"
              :session="chatSession"
              :refreshing="refreshing"
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
          </div>
        </template>
        <div v-else class="chat__detail-blank mono">{{ t('chat.page.detailBlank') }}</div>
      </aside>
    </div>
  </main>
</template>

<script setup lang="ts">
// v3 Чат — the Агенти screen's two-column pattern applied to plain chats: the left rail lists
// this project's chat threads (one `kind: 'chat'` session each), the right column is a
// consolidated identity/action bar over the SAME KPanel + KRequestBlock stack the Агенти
// detail renders `bare`. Log grouping, decision block, stall banner, live status, todo lane,
// my-message navigation and the composer's model/effort/rehydrate chips all come for free.
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
import KStatusDot from 'components/kit/KStatusDot.vue';
import KIconButton from 'components/kit/KIconButton.vue';
import KBtn from 'components/kit/KBtn.vue';
import KTabs from 'components/kit/KTabs.vue';

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
// A session resume (on select, or the composer's ↻) is in flight; the ↻ stays down until the
// server answers so a second click cannot spawn a competing respawn.
const refreshing = ref(false);
// «В беклог» files a cloud card; the ⊕ stays down until the write returns.
const filing = ref(false);
// The panel ✕ archives the current thread; it stays down until the write returns.
const clearing = ref(false);
// «розгорнути / стиснути все» is per-session detail state — reset on a chat switch so a
// stale command is not adopted by the newly opened session's rows.
const expandAll = ref<ExpandAllCommand>(EXPAND_ALL_NONE);

// The detail column carries one view — the log — but presents it through the same tab row the
// Агенти detail uses, so the density switch keeps the identical home.
const detailTab = ref('log');
const detailTabs = computed(() => [{ value: 'log', label: t('agents.tabs.log') }]);

const BIND_HINT = computed(() => t('chat.page.bindHint'));
const selectedProject = computed(() => store.projects.find((p) => p.id === store.selectedProjectId));
const isBound = computed(() => !!selectedProject.value?.localRepoPath);
const chatSession = computed(() => store.sessions.find((s) => s.id === chatId.value));
// Promotion grows a worktree, so it is refused without a local binding; the strip states why.
const promoteBlocked = computed(() => !!chatSession.value && !isBound.value);
const harnessLabel = computed(() => chatSession.value?.runtime || 'omp');
const running = computed(
  () => chatSession.value?.status === 'thinking' || chatSession.value?.status === 'tool',
);
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
const DEFAULT_CHAT_NAME = /^чат \d+$/;
function threadTitle(s: Session): string {
  // A non-default name is the operator's own label (a rename) and wins; the default `чат N`
  // is uninformative, so those fall back to the opening message.
  const name = s.name?.trim() ?? '';
  if (name && !DEFAULT_CHAT_NAME.test(name)) return name;
  return taskNameFromText(s.task) || s.name;
}

// Inline rename of the open thread (double-click the bar name). Edits stay local until
// committed; Enter and blur commit, Esc discards. `renaming` also gates the blur handler so a
// commit on Enter does not fire a second save on the blur that follows.
const renaming = ref(false);
const renameDraft = ref('');
const renameInput = ref<HTMLInputElement | null>(null);

function startRename(): void {
  const s = chatSession.value;
  if (!s) return;
  renameDraft.value = threadTitle(s);
  renaming.value = true;
  void nextTick(() => renameInput.value?.select());
}

function cancelRename(): void {
  renaming.value = false;
}

async function commitRename(): Promise<void> {
  if (!renaming.value) return;
  renaming.value = false;
  const s = chatSession.value;
  const name = renameDraft.value.trim();
  if (!s || !name || name === threadTitle(s)) return;
  try {
    await store.renameSession(s.id, name);
  } catch (e) {
    store.notify(e instanceof Error ? e.message : String(e), 'error');
  }
}

// A thread nobody has spoken in yet. Uses the loaded transcript when present, else the
// server-stamped `task` as a proxy (empty until the first message) — enough to reuse a blank
// thread instead of stacking more of them, and to skip resuming a chat with no history.
function isEmptyThread(s: Session): boolean {
  const tr = store.transcripts[s.id];
  if (tr) return !tr.some((e) => e.kind === 'user_text' || e.kind === 'assistant_text');
  return !s.task.trim();
}

// Localized status word for the bar, mirroring the Агенти detail bar's `harness · status`.
function statusWord(s: Session): string {
  switch (s.status) {
    case 'thinking': return t('agents.statusWord.thinking');
    case 'tool': return t('agents.statusWord.tool');
    case 'waiting_input': return t('agents.statusWord.waiting');
    case 'done': return t('agents.statusWord.done');
    case 'in_review': return t('agents.statusWord.review');
    case 'error': return t('agents.statusWord.error');
    case 'queued': return t('agents.statusWord.queued');
    case 'stopped': return t('agents.statusWord.stopped');
    case 'merged': return t('agents.statusWord.merged');
    case 'conflict': return t('agents.statusWord.conflict');
    case 'backlog': return t('agents.statusWord.backlog');
    default: return s.status;
  }
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

// Wake a dormant chat so its history comes back. After an app restart — or simply a chat the
// api has idle-reaped — there is no omp child for the session, so the transcript serves only
// a "dormant" notice and the log reads empty; this respawns the child and reloads its
// transcript WITHOUT sending anything. Backs the composer's ↻.
async function resumeThread(id: string): Promise<void> {
  if (refreshing.value) return;
  refreshing.value = true;
  try {
    await store.resumeSession(id);
  } catch (e) {
    store.notify(e instanceof Error ? e.message : String(e), 'error');
  } finally {
    refreshing.value = false;
  }
}

// Composer ↻ — rehydrate the open chat.
async function onRefresh(): Promise<void> {
  const s = chatSession.value;
  if (s) await resumeThread(s.id);
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

// Open a thread and auto-resume it: a chat the api has idle-reaped reads as a dead "dormant"
// banner otherwise, and the operator expects a click — including switching between threads —
// to bring the conversation back rather than to make them send a message first. `resumeSession`
// is safe for a live child (the server's liveOrResume never respawns a running turn) and is
// de-duplicated per id, and it reloads the transcript, so no separate load is needed. Kept off
// the `refreshing` gate on purpose: that gate is the composer ↻'s, and sharing it made a second
// switch mid-resume silently skip.
async function selectThread(id: string): Promise<void> {
  chatId.value = id;
  try {
    await store.resumeSession(id);
  } catch (e) {
    store.notify(e instanceof Error ? e.message : String(e), 'error');
  }
}

// Reuse the most recent non-archived chat for the selected project, else create one — then
// open it (which resumes a dormant thread or loads a fresh one).
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
      await selectThread(existing.id);
    } else {
      const chat = await store.createChat(pid);
      chatId.value = chat?.id;
      if (chat && store.transcripts[chat.id] === undefined) void store.loadTranscript(chat.id);
    }
  } catch (e) {
    store.notify(e instanceof Error ? e.message : String(e), 'error');
  } finally {
    ensuring = false;
  }
}

// «+ Новий» — open a fresh thread. A blank thread is reused rather than duplicated, so the
// rail does not fill with empty `чат N` rows nobody typed in. A brand-new chat is live and
// has no history, so it is not resumed — its (empty) transcript is loaded instead.
async function newChat(): Promise<void> {
  const pid = store.selectedProjectId;
  if (!pid || ensuring) return;
  const blank = threads.value.find(isEmptyThread);
  if (blank) {
    await selectThread(blank.id);
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
      await selectThread(next.id);
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

// Bar ✕ — archive the open thread. Non-destructive (see archiveThread); the ✕ stays down
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
  renaming.value = false;
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
  background: var(--k-bg);
  border: 1px solid var(--k-line);
  border-radius: var(--k-r-lg);
  overflow: hidden;
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
  padding: var(--k-sp-4);
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
}

// Consolidated identity + actions bar over the bare panel, identical geometry to the Агенти
// detail bar so the two screens read as one system.
.chat__detail-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  min-height: 44px;
  padding: 0 6px 0 12px;
  background: var(--k-bg);
  border-bottom: 2px solid var(--k-line-strong);
  flex: none;
}

.chat__detail-id {
  display: flex;
  align-items: center;
  gap: var(--k-sp-2);
  min-width: 0;
}

// The thread's title — the bar's face, at full text colour, not the muted mono the harness
// label wears.
.chat__detail-name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: var(--k-font-ui);
  font-size: var(--k-fs-md);
  font-weight: var(--k-fw-semibold);
  color: var(--k-text);
}

// Inline rename field — replaces the name span while editing; an accent underline marks it
// editable, at the same size/weight as the name so the bar does not jump.
.chat__detail-rename {
  min-width: 0;
  flex: 0 1 auto;
  font-family: var(--k-font-ui);
  font-size: var(--k-fs-md);
  font-weight: var(--k-fw-semibold);
  color: var(--k-text);
  background: transparent;
  border: none;
  border-bottom: 1px solid var(--k-accent);
  padding: 0;
  outline: none;
}

.chat__detail-controls {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: none;
}

// Harness · status — «omp · готово». The one place the session's runtime is named now that
// the embedded panel is `bare`.
.chat__detail-status {
  font-size: 11px;
  color: var(--k-muted);
  white-space: nowrap;
}

.chat__actions {
  display: flex;
  flex-wrap: nowrap;
  gap: 6px;
}

// The reason a disabled ▶ can't act, on its own strip since a disabled control has no
// reachable tooltip.
.chat__detail-note {
  flex: none;
  margin: 0;
  padding: 5px 12px 0;
  font-size: 11px;
  line-height: 1.5;
  color: var(--k-muted);
}

// One-tab row over the log, mirroring the Агенти detail tab bar exactly (kit/KTabs plus the
// log-ctl density switch), so the two screens share the row instead of each inventing one.
.chat__detail-tabs {
  flex: none;
  padding: 0 12px;
}

.chat__log-ctl {
  padding: 0;
  border: none;
  background: transparent;
  font-family: var(--k-font-ui);
  font-size: var(--k-fs-xs);
  color: var(--k-muted);
  cursor: pointer;
  transition: color 0.12s;

  &:hover { color: var(--k-text); }
  &:focus-visible { outline: 1px solid var(--k-accent); outline-offset: 2px; }
}

// The pane that holds the log; flexes into the rest of the column so the panel's own log
// scrolls instead of the column growing.
.chat__tabpane {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

// The panel fills the pane; `min-height: 0` lets its inner log scroll. Bare, so it flows flat
// on the surface with no box border, like the Агенти embedded panel.
.chat__tabpane .chat__panel {
  flex: 1;
  min-height: 0;
  border: none;
  border-radius: 0;
  background: transparent;
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
