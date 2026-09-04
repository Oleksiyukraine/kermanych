<template>
  <main class="chat">
    <!-- No project bound → nothing to chat about yet. -->
    <div v-if="!store.selectedProjectId" class="chat__blank mono">
      {{ t('chat.page.blank') }}
    </div>

    <!-- The chat IS the agent panel: the exact same KPanel + KRequestBlock stack the Агенти
         page renders, so the two chats are one component. Only the page chrome differs — here
         it is full-width and standalone, there it sits in a resizable detail column. The
         chat-only header actions (promote ▶, backlog ⊕, new chat ✕) live inside KPanel,
         gated on `session.kind === 'chat'`. -->
    <KPanel
      v-else-if="chatSession"
      class="chat__panel"
      :session="chatSession"
      :promoting="promoting"
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
  </main>
</template>

<script setup lang="ts">
// v3 Чат — a standalone, full-width chat over one `kind: 'chat'` session per project. It
// reuses the most recent chat for the selected project (or creates one) and renders its
// transcript through the SAME KPanel + KRequestBlock stack as the Агенти page's chat, so
// the two are one component: log grouping, decision block, stall banner, live status, todo
// lane, my-message navigation and the composer's model/effort chips all come for free.
import { computed, onMounted, ref, watch } from 'vue';
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
import KPanel from 'components/kit/KPanel.vue';
import KRequestBlock from 'components/kit/KRequestBlock.vue';

const store = useOrchestrator();
const board = useBoard();
const auth = useAuth();
const projects = useProjects();
const router = useRouter();
const { t } = useI18n();

const chatId = ref<string | undefined>(undefined);
// Promotion spins up a worktree and respawns omp; the ▶ stays down until the server answers.
const promoting = ref(false);
// The composer's ↻ (rehydrate) stays down until the server answers.
const refreshing = ref(false);
// «розгорнути / стиснути все» is per-session detail state — reset on a chat switch so a
// stale command is not adopted by the newly opened session's rows.
const expandAll = ref<ExpandAllCommand>(EXPAND_ALL_NONE);

const BIND_HINT = computed(() => t('chat.page.bindHint'));
const selectedProject = computed(() => store.projects.find((p) => p.id === store.selectedProjectId));
const isBound = computed(() => !!selectedProject.value?.localRepoPath);
const chatSession = computed(() => store.sessions.find((s) => s.id === chatId.value));
// Guard against a double-create if the project changes mid-flight while a create is pending.
let ensuring = false;

const blocks = computed(() =>
  chatId.value ? buildChatBlocks(store.transcripts[chatId.value] ?? []) : [],
);

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

// Reuse the most recent chat session for the selected project, else create one. Then make
// sure its transcript is loaded so the log renders on first paint.
async function ensureChat(): Promise<void> {
  const pid = store.selectedProjectId;
  if (!pid) {
    chatId.value = undefined;
    return;
  }
  if (ensuring) return;
  ensuring = true;
  try {
    const existing = store.sessions
      .filter((s) => s.kind === 'chat' && s.projectId === pid)
      .sort(
        (a, b) => new Date(b.lastActivityAt).getTime() - new Date(a.lastActivityAt).getTime(),
      )[0];
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

// Discard the current chat and start a fresh one (single chat per project).
async function clearChat(): Promise<void> {
  const id = chatId.value;
  if (!id) return;
  if (!window.confirm(t('chat.page.confirmClear'))) return;
  try {
    await store.deleteSession(id);
    chatId.value = undefined;
    await ensureChat();
  } catch (e) {
    store.notify(e instanceof Error ? e.message : String(e), 'error');
  }
}

onMounted(() => void ensureChat());
watch(() => store.selectedProjectId, () => void ensureChat());
// A chat switch resets the detail toolbar so the new session's rows start neutral.
watch(chatId, () => {
  expandAll.value = EXPAND_ALL_NONE;
});
</script>

<style scoped lang="scss">
.chat {
  height: calc(100vh - 82px);
  overflow: hidden;
  padding: var(--k-sp-3);
  display: flex;
  flex-direction: column;
}

// The panel fills the page; `min-height: 0` lets its inner log scroll instead of the panel
// growing past the viewport.
.chat__panel {
  flex: 1;
  min-height: 0;
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
