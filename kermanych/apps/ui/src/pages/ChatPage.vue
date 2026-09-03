<template>
  <main class="chat">
    <!-- No project bound → nothing to chat about yet. -->
    <div v-if="!store.selectedProjectId" class="chat__blank mono">
      {{ t('chat.page.blank') }}
    </div>

    <div v-else class="chat__card">
      <!-- header — chat title + chat→task / backlog / new-chat actions -->
      <header class="chat__head">
        <div class="chat__head-title">
          <KStatusDot v-if="chatSession" :status="chatSession.status" />
          <span>{{ t('chat.page.title') }}</span>
        </div>
        <div class="chat__head-actions">
          <KIconButton
            :disabled="!isBound || promoting || !chatId"
            :title="promoting ? t('chat.page.promoting') : !isBound ? BIND_HINT : t('chat.page.promoteTip')"
            @click="promote"
          >▶</KIconButton>
          <KIconButton
            :disabled="!chatId"
            :title="t('chat.page.toBacklogTip')"
            @click="toBacklog"
          >⊕</KIconButton>
          <KIconButton
            :disabled="!chatId"
            :title="t('chat.page.clearTip')"
            @click="clearChat"
          >✕</KIconButton>
        </div>
      </header>
      <!-- scrollable transcript -->
      <div ref="messagesEl" class="chat__messages">
        <template v-if="blocks.length">
          <template v-for="block in blocks" :key="block.id">
            <KChatMessage v-if="block.request" role="user">{{ block.request.text }}</KChatMessage>

            <template v-for="(item, i) in block.items" :key="block.id + ':' + i">
              <template v-if="item.kind === 'group'">
                <KToolRow
                  v-for="m in item.members"
                  :key="m.id"
                  :entry="m"
                  :session-id="chatId ?? ''"
                  :expand-all="EXPAND_ALL_NONE"
                />
              </template>

              <template v-else-if="item.kind === 'entry'">
                <KChatMessage v-if="item.entry.kind === 'assistant_text'" role="assistant">
                  <div class="k-log__markdown" v-html="renderMarkdown(item.entry.text)"></div>
                </KChatMessage>

                <KThoughtToggle
                  v-else-if="item.entry.kind === 'assistant_thinking'"
                  :label="t('chat.page.thought')"
                  :open="openThoughts.has(item.entry.id)"
                  @toggle="toggleThought(item.entry.id)"
                >
                  <div class="k-log__markdown" v-html="renderMarkdown(item.entry.text)"></div>
                </KThoughtToggle>

                <KToolRow
                  v-else-if="item.entry.kind === 'tool'"
                  :entry="item.entry"
                  :session-id="chatId ?? ''"
                  :expand-all="EXPAND_ALL_NONE"
                />

                <div
                  v-else-if="item.entry.kind === 'notice'"
                  class="chat__notice mono"
                  :class="`chat__notice--${item.entry.level}`"
                >{{ noticeText(item.entry) }}</div>
              </template>
            </template>
          </template>
        </template>
        <div v-else class="chat__empty mono">{{ t('chat.page.empty') }}</div>
      </div>

      <!-- composer pinned to the bottom -->
      <div class="chat__composer">
        <KComposer
          v-model="draft"
          :model="chatSession?.model"
          :models="store.models"
          :effort="chatSession?.effort"
          :context="chatSession?.contextPercent"
          :usage="chatSession?.usage"
          :placeholder="t('chat.page.placeholder')"
          @send="onSend"
          @effort="onEffort"
          @set-model="onSetModel"
        />
      </div>
    </div>
  </main>
</template>

<script setup lang="ts">
// v3 Чат — a standalone, full-width chat over one `kind: 'chat'` session per project.
// It reuses the most recent chat for the selected project (or creates one), renders its
// transcript through the shared `buildChatBlocks` grouping, and sends via the store.
import { computed, nextTick, onMounted, reactive, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import { useI18n } from 'vue-i18n';
import { buildChatBlocks, taskNameFromText } from '@kermanych/core';
import type { ImageInput, ThinkingLevel, TranscriptEntry } from '@kermanych/core';
import { localizeNotice } from '../lib/i18n-coded';
import { useOrchestrator } from 'stores/orchestrator';
import { useBoard } from 'stores/board';
import { useAuth } from 'stores/auth';
import { useProjects } from 'stores/projects';
import { renderMarkdown } from '../lib/markdown';
import { taskInsertFromDraft } from '../lib/tasks-view';
import { EXPAND_ALL_NONE } from '../lib/expand-all';
import KChatMessage from 'components/kit/KChatMessage.vue';
import KThoughtToggle from 'components/kit/KThoughtToggle.vue';
import KToolRow from 'components/kit/KToolRow.vue';
import KComposer from 'components/kit/KComposer.vue';
import KStatusDot from 'components/kit/KStatusDot.vue';
import KIconButton from 'components/kit/KIconButton.vue';

const store = useOrchestrator();
const board = useBoard();
const auth = useAuth();
const projects = useProjects();
const { t, te } = useI18n();

// A transcript notice: server Ukrainian `text`, re-rendered from `code`+`params` when the
// build knows the code (falls back to `text` otherwise). See lib/i18n-coded.ts.
const noticeText = (entry: Extract<TranscriptEntry, { kind: 'notice' }>): string =>
  localizeNotice({ t, te }, entry);

const draft = ref('');
const chatId = ref<string | undefined>(undefined);
const messagesEl = ref<HTMLElement | null>(null);

const router = useRouter();
const BIND_HINT = computed(() => t('chat.page.bindHint'));
// Promotion spins up a worktree, so it is blocked until the project is bound.
const promoting = ref(false);
const selectedProject = computed(() => store.projects.find((p) => p.id === store.selectedProjectId));
const isBound = computed(() => !!selectedProject.value?.localRepoPath);
const chatSession = computed(() => store.sessions.find((s) => s.id === chatId.value));
// Reasoning traces start collapsed; the set tracks the ones the operator opened.
const openThoughts = reactive(new Set<string>());
// Guard against a double-create if the project changes mid-flight while a create is pending.
let ensuring = false;

const blocks = computed(() =>
  chatId.value ? buildChatBlocks(store.transcripts[chatId.value] ?? []) : [],
);

// The composer's effort chip. A chat thinks as hard as it is told to, same as an agent; the
// api answers with the saved row, so a refusal from omp must surface rather than pass silently.
async function onEffort(level: ThinkingLevel): Promise<void> {
  const id = chatId.value;
  if (!id) return;
  try {
    await store.setEffort(id, level);
  } catch (e) {
    store.notify(e instanceof Error ? e.message : String(e), 'error');
  }
}

// The composer's model picker on the chat — mirror of onEffort.
async function onSetModel(patch: { model: string; provider?: string }): Promise<void> {
  const id = chatId.value;
  if (!id) return;
  try {
    await store.setSessionModel(id, patch);
  } catch (e) {
    store.notify(e instanceof Error ? e.message : String(e), 'error');
  }
}

function toggleThought(id: string): void {
  if (openThoughts.has(id)) openThoughts.delete(id);
  else openThoughts.add(id);
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

async function onSend(text: string, images: ImageInput[]): Promise<void> {
  const id = chatId.value;
  if (!id) return;
  try {
    await store.sendMessage(id, text, 'prompt', images);
  } catch (e) {
    store.notify(e instanceof Error ? e.message : String(e), 'error');
  }
}

// Promotion grows a worktree and starts building, so it is agent work and needs a card —
// otherwise its status mirrors nowhere and the team never sees the run. The card is minted
// first and its id travels into the promotion, which stamps it on the row.
async function promote(): Promise<void> {
  // The button's `:disabled` is not a guarantee: keyboard and programmatic activation
  // reach here regardless, and a second run would mint a second card.
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
  // The other half of what the disabled button says: promotion grows a worktree, so without
  // a local binding the card would be minted and then refused server-side, orphaning it.
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

// Keep the newest turn in view as the transcript grows.
watch(
  () => (chatId.value ? store.transcripts[chatId.value] : undefined),
  () =>
    void nextTick(() => {
      const el = messagesEl.value;
      if (el) el.scrollTop = el.scrollHeight;
    }),
  { deep: true },
);
</script>

<style scoped lang="scss">
.chat {
  height: calc(100vh - 82px);
  overflow: hidden;
  padding: var(--k-sp-3);
}

.chat__card {
  height: 100%;
  display: flex;
  flex-direction: column;
  min-height: 0;
  background: var(--k-bg);
  border: 1px solid var(--k-line);
  border-radius: var(--k-r-lg);
  overflow: hidden;
}

.chat__blank {
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--k-faint);
  font-size: var(--k-fs-sm);
}

.chat__messages {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: var(--k-sp-4);
  padding: var(--k-sp-5);
}

.chat__empty {
  margin: auto;
  color: var(--k-faint);
  font-size: var(--k-fs-sm);
}

.chat__notice {
  color: var(--k-muted);
  font-size: var(--k-fs-sm);
}

.chat__notice--warn {
  color: var(--k-warning);
}

.chat__notice--error {
  color: var(--k-danger);
}

.chat__composer {
  display: flex;
  flex-direction: column;
  gap: var(--k-sp-2);
  padding: var(--k-sp-4) var(--k-sp-5);
  border-top: 1px solid var(--k-line-strong);
}

.chat__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--k-sp-3);
  flex: none;
  padding: var(--k-sp-3) var(--k-sp-5);
  border-bottom: 2px solid var(--k-line-strong);
}

.chat__head-title {
  display: flex;
  align-items: center;
  gap: var(--k-sp-2);
  font-family: var(--k-font-ui);
  font-size: var(--k-fs-md);
  font-weight: var(--k-fw-semibold);
  color: var(--k-text);
}

.chat__head-actions {
  display: flex;
  align-items: center;
  gap: var(--k-sp-1);
}
</style>
