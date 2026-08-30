<template>
  <main class="chat">
    <!-- No project bound → nothing to chat about yet. -->
    <div v-if="!store.selectedProjectId" class="chat__blank mono">
      Обери проєкт ліворуч, щоб почати чат.
    </div>

    <div v-else class="chat__card">
      <!-- header — chat title + chat→task / backlog / new-chat actions -->
      <header class="chat__head">
        <div class="chat__head-title">
          <KStatusDot v-if="chatSession" :status="chatSession.status" />
          <span>Чат</span>
        </div>
        <div class="chat__head-actions">
          <KIconButton
            :disabled="!isBound || promoting || !chatId"
            :title="promoting ? 'Готую worktree…' : !isBound ? BIND_HINT : 'Почати імплементацію обговореного (worktree + повний доступ)'"
            @click="promote"
          >▶</KIconButton>
          <KIconButton
            :disabled="!chatId"
            title="Зберегти як задачу в беклог"
            @click="toBacklog"
          >⊕</KIconButton>
          <KIconButton
            :disabled="!chatId"
            title="Новий чат (видалити поточний)"
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
                  :label="'Думав …'"
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
                >{{ item.entry.text }}</div>
              </template>
            </template>
          </template>
        </template>
        <div v-else class="chat__empty mono">Порожній чат. Напиши перше повідомлення.</div>
      </div>

      <!-- composer pinned to the bottom -->
      <div class="chat__composer">
        <KComposer
          v-model="draft"
          :model="chatSession?.model"
          :effort="chatSession?.effort"
          :context="chatSession?.contextPercent"
          :usage="chatSession?.usage"
          placeholder="запитай або опиши, що потрібно зробити…"
          @send="onSend"
          @effort="onEffort"
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
import { buildChatBlocks, taskNameFromText } from '@kermanych/core';
import type { ImageInput, ThinkingLevel } from '@kermanych/core';
import { useOrchestrator } from 'stores/orchestrator';
import { renderMarkdown } from '../lib/markdown';
import { EXPAND_ALL_NONE } from '../lib/expand-all';
import KChatMessage from 'components/kit/KChatMessage.vue';
import KThoughtToggle from 'components/kit/KThoughtToggle.vue';
import KToolRow from 'components/kit/KToolRow.vue';
import KComposer from 'components/kit/KComposer.vue';
import KStatusDot from 'components/kit/KStatusDot.vue';
import KIconButton from 'components/kit/KIconButton.vue';

const store = useOrchestrator();

const draft = ref('');
const chatId = ref<string | undefined>(undefined);
const messagesEl = ref<HTMLElement | null>(null);

const router = useRouter();
const BIND_HINT = 'Прив’яжіть локальну теку репозиторію';
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

// Promote the chat into a real task: omp gets a worktree + full tools, and we jump to the
// Агенти view where the now-running agent lives.
async function promote(): Promise<void> {
  const id = chatId.value;
  if (!id || promoting.value || !isBound.value) return;
  promoting.value = true;
  try {
    await store.promoteChat(id);
    store.setBucket('active');
    store.selectSession(id);
    void router.push({ name: 'agents' });
  } catch (e) {
    store.notify(e instanceof Error ? e.message : String(e), 'error');
  } finally {
    promoting.value = false;
  }
}

// Park the chat's opening ask as a backlog task (name from its first line); it can be
// refined later from the Агенти backlog.
async function toBacklog(): Promise<void> {
  const id = chatId.value;
  const pid = store.selectedProjectId;
  if (!id || !pid) return;
  const seed =
    (
      (store.transcripts[id] ?? []).find((e) => e.kind === 'user_text') as
        | { kind: 'user_text'; text: string }
        | undefined
    )?.text?.trim() ?? '';
  if (!seed) {
    store.notify('Порожній чат — нема що зберігати в беклог.', 'error');
    return;
  }
  try {
    await store.createSession(
      pid, taskNameFromText(seed), seed, chatSession.value?.model, [], true, 'feature', true, undefined, undefined,
    );
    store.setBucket('tasks');
    store.notify('Збережено в беклог.');
  } catch (e) {
    store.notify(e instanceof Error ? e.message : String(e), 'error');
  }
}

// Discard the current chat and start a fresh one (single chat per project).
async function clearChat(): Promise<void> {
  const id = chatId.value;
  if (!id) return;
  if (!window.confirm('Видалити поточний чат і почати новий?')) return;
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
