<template>
  <main class="chat">
    <!-- No project bound → nothing to chat about yet. -->
    <div v-if="!store.selectedProjectId" class="chat__blank mono">
      Обери проєкт ліворуч, щоб почати чат.
    </div>

    <template v-else>
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
        <div class="chat__readonly mono">Лише читання</div>
        <KComposer
          v-model="draft"
          :model="chatModel"
          placeholder="запитай або опиши, що потрібно зробити…"
          @send="onSend"
        />
      </div>
    </template>
  </main>
</template>

<script setup lang="ts">
// v3 Чат — a standalone, full-width chat over one `kind: 'chat'` session per project.
// It reuses the most recent chat for the selected project (or creates one), renders its
// transcript through the shared `buildChatBlocks` grouping, and sends via the store.
import { computed, nextTick, onMounted, reactive, ref, watch } from 'vue';
import { buildChatBlocks } from '@kermanych/core';
import type { ImageInput } from '@kermanych/core';
import { useOrchestrator } from 'stores/orchestrator';
import { renderMarkdown } from '../lib/markdown';
import { EXPAND_ALL_NONE } from '../lib/expand-all';
import KChatMessage from 'components/kit/KChatMessage.vue';
import KThoughtToggle from 'components/kit/KThoughtToggle.vue';
import KToolRow from 'components/kit/KToolRow.vue';
import KComposer from 'components/kit/KComposer.vue';

const store = useOrchestrator();

const draft = ref('');
const chatId = ref<string | undefined>(undefined);
const messagesEl = ref<HTMLElement | null>(null);
// Reasoning traces start collapsed; the set tracks the ones the operator opened.
const openThoughts = reactive(new Set<string>());
// Guard against a double-create if the project changes mid-flight while a create is pending.
let ensuring = false;

const blocks = computed(() =>
  chatId.value ? buildChatBlocks(store.transcripts[chatId.value] ?? []) : [],
);

const chatModel = computed(
  () => store.sessions.find((s) => s.id === chatId.value)?.model,
);

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
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}

.chat__blank {
  display: flex;
  flex: 1;
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

.chat__readonly {
  align-self: flex-start;
  padding: var(--k-sp-1) var(--k-sp-2);
  border-radius: var(--k-r-sm);
  background: var(--k-surface2);
  color: var(--k-faint);
  font-size: var(--k-fs-xs);
}
</style>
