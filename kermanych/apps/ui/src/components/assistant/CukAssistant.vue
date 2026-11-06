<template>
  <!-- ЦУК — «Центр управління Керманича» (docs/specs/2026-11-04-cuk-control-console.md): the first
       panel of the avatar window's accordion. Expanded it is a console with a transcript that
       never collapses to nothing (decision 7: an empty ЦУК greets and offers examples); folded it
       is the title bar that hands the accordion back. The conversation is stores/cuk-chat.ts. -->
  <div class="cuk" :class="{ 'cuk--folded': folded }">
    <section class="cuk__log" :aria-label="t('cuk.logLabel')">
      <header class="cuk__head">
        <button
          class="cuk__toggle"
          type="button"
          :aria-expanded="!folded"
          :aria-label="folded ? t('cuk.expand') : t('cuk.fold')"
          :disabled="!foldable"
          @click="emit('toggle')"
        >
          <span v-if="foldable" class="cuk__caret" :class="{ 'cuk__caret--open': !folded }" aria-hidden="true"></span>
          <span class="cuk__title mono">{{ t('cuk.title') }}</span>
          <span v-if="folded && chat.busy" class="cuk__busy mono" aria-live="polite">{{ t('management.assistant.busyShort') }}</span>
        </button>
        <button
          v-if="chat.hasConversation"
          v-tip="t('management.assistant.newChat')"
          class="cuk__close mono"
          type="button"
          :disabled="chat.busy || chat.resetting"
          :aria-busy="chat.resetting || undefined"
          :aria-label="t('management.assistant.closeChat')"
          @click="newChat()"
        ><KSpinner v-if="chat.resetting" :size="10" /><template v-else>×</template></button>
      </header>

      <div v-show="!folded" ref="logEl" class="cuk__body">
        <div v-if="!chat.hasConversation" class="cuk__hello">
          <p class="cuk__hello-text">{{ t('cuk.hello') }}</p>
          <div class="cuk__examples">
            <button
              v-for="ex in examples"
              :key="ex"
              class="cuk__example"
              type="button"
              :disabled="chat.busy || chat.resetting || ompCheck.blocked"
              @click="composerEl?.send(ex)"
            >{{ ex }}</button>
          </div>
        </div>

        <template v-for="e in chat.entries" :key="e.id">
          <KChatMessage v-if="e.kind === 'user'" role="user">
            <template v-if="e.text">{{ e.text }}</template>
            <span v-if="e.files?.length" class="cuk__files">
              <img v-for="f in e.files" :key="f.name" :src="f.url" class="cuk__thumb" :alt="f.name" />
            </span>
          </KChatMessage>
          <KChatMessage v-else-if="e.kind === 'assistant'" role="assistant">
            <div class="k-log__markdown" v-html="renderMarkdown(e.text)"></div>
          </KChatMessage>
          <CukActionCard
            v-else-if="e.kind === 'card'"
            :action="e.action"
            :state="e.state"
            @confirm="(a) => chat.confirm(e.id, a)"
            @cancel="chat.cancel(e.id)"
          />
          <!-- What the APP did — mono and colour-coded, so it never reads as the model's prose. -->
          <p v-else class="cuk__res mono" :class="`cuk__res--${e.level}`">
            {{ e.text }}
            <button v-if="e.session" class="cuk__res-link" type="button" @click="chat.openSession(e.session)">
              {{ t('cuk.openSession') }}
            </button>
            <!-- An at-once schedule action (scheduled-tasks decision 7): one step back. -->
            <button
              v-if="e.undo === 'ready'"
              class="cuk__res-link"
              type="button"
              :disabled="undo.busyFor(e.id)"
              :aria-busy="undo.busyFor(e.id) || undefined"
              @click="undo.run(e.id)"
            >{{ t('cuk.result.undo') }}</button>
            <span v-else-if="e.undo === 'done'" class="cuk__res-undone">{{ t('cuk.result.undone') }}</span>
          </p>
        </template>
        <p v-if="chat.busy" class="cuk__think" aria-live="polite">{{ thinkingLabel }}</p>
      </div>
    </section>

    <AssistantComposer
      v-show="!folded"
      ref="composerEl"
      images-only
      dense
      :busy="chat.busy"
      :locked="chat.busy || chat.resetting"
      :placeholder="t('cuk.placeholder')"
      :input-label="t('cuk.inputLabel')"
      :form-label="t('cuk.title')"
      :attach-tip="t('cuk.attach')"
      @submit="(text, files) => chat.send(text, files)"
    />
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onUnmounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { useCukChat } from 'stores/cuk-chat';
import { useOmpCheck } from 'stores/omp-check';
import KChatMessage from 'components/kit/KChatMessage.vue';
import KSpinner from 'components/kit/KSpinner.vue';
import AssistantComposer from './AssistantComposer.vue';
import CukActionCard from './CukActionCard.vue';
import { confirmAction } from '../../lib/confirm';
import { useAsyncAction, useKeyedAction } from '../../composables/useAsyncAction';
import { renderMarkdown } from '../../lib/markdown';

defineProps<{
  folded?: boolean;
  // There is a second panel to hand the accordion to (decision 9: only managers have one).
  foldable?: boolean;
}>();
const emit = defineEmits<{ toggle: [] }>();

const { t } = useI18n();
const chat = useCukChat();
// omp missing or signed out: the composer shows why, and the example chips cannot send either.
const ompCheck = useOmpCheck();
const composerEl = ref<InstanceType<typeof AssistantComposer> | null>(null);
const logEl = ref<HTMLElement | null>(null);

const examples = computed(() => [t('cuk.examples.waiting'), t('cuk.examples.launch'), t('cuk.examples.settings')]);

function focus(): void {
  composerEl.value?.focus();
}
defineExpose({ focus });

const resetChat = useAsyncAction(() => chat.reset());
const undo = useKeyedAction((id: string) => chat.undo(id));

// «Обговорити в ЦУК» from a scheduled run's answer: the text lands in the draft, not sent.
watch(
  () => chat.draftRequest,
  (req) => {
    if (req) composerEl.value?.setDraft(req.text);
  },
);
async function newChat(): Promise<void> {
  if (resetChat.busy.value) return;
  if (chat.hasConversation) {
    const ok = await confirmAction({
      title: t('confirmations.newChat.title'),
      message: t('confirmations.newChat.message'),
      confirmLabel: t('confirmations.label.clear'),
    });
    if (!ok) return;
  }
  await resetChat.run();
}

function scrollLog(): void {
  void nextTick(() => {
    const el = logEl.value;
    if (el) el.scrollTop = el.scrollHeight;
  });
}
watch(() => chat.entries, scrollLog, { deep: true });

// «Думає…» with a clock that exists only during a turn — the Менеджмент assistant's idiom.
const thinkingSec = ref(0);
let thinkTimer: ReturnType<typeof setInterval> | undefined;
const thinkingLabel = computed(() =>
  thinkingSec.value < 3 ? t('management.assistant.thinking') : t('management.assistant.thinkingSec', { sec: thinkingSec.value }),
);
watch(
  () => chat.busy,
  (busy) => {
    clearInterval(thinkTimer);
    thinkTimer = undefined;
    thinkingSec.value = 0;
    if (!busy) return;
    const startedAt = Date.now();
    thinkTimer = setInterval(() => (thinkingSec.value = Math.round((Date.now() - startedAt) / 1000)), 1000);
    scrollLog();
  },
  { immediate: true },
);
onUnmounted(() => clearInterval(thinkTimer));
</script>

<style scoped lang="scss">
.cuk {
  display: flex;
  flex-direction: column;
  min-height: 0;
  flex: 1 1 auto;
}

.cuk--folded {
  flex: none;
}

// The window's dense glass, the Менеджмент panel's recipe.
.cuk__log {
  flex: 1 1 auto;
  min-height: 0;
  display: flex;
  flex-direction: column;
  margin-bottom: var(--k-sp-2);
  background: color-mix(in srgb, var(--k-surface) 94%, transparent);
  -webkit-backdrop-filter: blur(22px) saturate(150%);
  backdrop-filter: blur(22px) saturate(150%);
  border: var(--k-rule-thin) solid var(--k-line-strong);
  border-radius: var(--k-r-lg);
  box-shadow:
    var(--k-shadow-toast),
    inset 0 1px 0 color-mix(in srgb, #fff 8%, transparent);
  overflow: hidden;
}

.cuk--folded .cuk__log {
  flex: none;
  margin-bottom: var(--k-sp-2);
}

.cuk__head {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--k-sp-2);
  padding: var(--k-sp-2) var(--k-sp-2) var(--k-sp-2) var(--k-sp-3);
  border-bottom: var(--k-rule-thin) solid var(--k-line);
}

.cuk--folded .cuk__head {
  border-bottom: none;
}

.cuk__toggle {
  flex: 1;
  min-width: 0;
  min-height: 22px;
  display: inline-flex;
  align-items: center;
  gap: var(--k-sp-2);
  appearance: none;
  border: none;
  padding: 0;
  background: transparent;
  cursor: pointer;
  text-align: left;

  &:disabled {
    cursor: default;
  }

  &:not(:disabled):hover .cuk__caret {
    color: var(--k-text);
  }
}

// The Менеджмент panel's drawn caret, so both bars fold the same way.
.cuk__caret {
  flex: none;
  width: 6px;
  height: 10px;
  background: currentColor;
  clip-path: polygon(0 0, 100% 50%, 0 100%);
  color: var(--k-muted);
  transition: transform 0.15s ease, color 0.12s;
}

.cuk__caret--open {
  transform: rotate(90deg);
}

// The console's name in the accent: it is the panel the window is FOR.
.cuk__title {
  font-size: var(--k-fs-xs);
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: var(--k-accent);
}

.cuk__busy {
  flex: none;
  margin-left: auto;
  font-size: var(--k-fs-xs);
  font-style: italic;
  color: var(--k-muted);
  animation: cuk-pulse 1.4s ease-in-out infinite;
}

.cuk__close {
  flex: none;
  width: 22px;
  height: 22px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  appearance: none;
  border: none;
  border-radius: var(--k-r-sm);
  background: transparent;
  color: var(--k-muted);
  font-size: 15px;
  line-height: 1;

  &:disabled {
    cursor: not-allowed;
    opacity: 0.72;
  }

  &:not(:disabled):hover {
    color: var(--k-text);
    background: color-mix(in srgb, var(--k-surface2) 70%, transparent);
  }
}

.cuk__body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: var(--k-sp-3);
  padding: var(--k-sp-3);
}

// The empty console: a greeting and three questions it answers, each one click from asked.
.cuk__hello {
  margin: auto 0;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: var(--k-sp-3);
  max-width: 560px;
  padding: var(--k-sp-3);
}

.cuk__hello-text {
  margin: 0;
  font-size: var(--k-fs-md);
  line-height: 1.55;
  color: var(--k-text);
}

.cuk__examples {
  display: flex;
  flex-wrap: wrap;
  gap: var(--k-sp-2);
}

.cuk__example {
  appearance: none;
  padding: 6px var(--k-sp-3);
  border: var(--k-rule-thin) solid var(--k-line-strong);
  border-radius: var(--k-r-pill);
  background: transparent;
  color: var(--k-muted);
  font-family: var(--k-font-ui);
  font-size: var(--k-fs-sm);
  cursor: pointer;
  transition: border-color 0.12s, color 0.12s;

  &:hover:not(:disabled) {
    border-color: var(--k-accent);
    color: var(--k-text);
  }

  &:disabled {
    cursor: not-allowed;
    opacity: 0.5;
  }
}

.cuk__files {
  display: flex;
  flex-wrap: wrap;
  gap: var(--k-sp-2);
  margin-top: var(--k-sp-2);
}

.cuk__thumb {
  display: block;
  max-width: 160px;
  max-height: 120px;
  border-radius: var(--k-r-sm);
}

.cuk__res {
  margin: 0;
  padding: 6px var(--k-sp-3);
  font-size: var(--k-fs-xs);
  line-height: 1.5;
  border-left: 2px solid var(--k-line-strong);
  color: var(--k-muted);
}

.cuk__res--warn {
  color: var(--k-text);
  border-left-color: var(--k-accent);
  background: color-mix(in srgb, var(--k-accent) 8%, transparent);
}

.cuk__res--error {
  color: var(--k-danger);
  border-left-color: var(--k-danger);
  background: color-mix(in srgb, var(--k-danger) 8%, transparent);
}

.cuk__res-link {
  appearance: none;
  margin-left: var(--k-sp-2);
  padding: 0;
  border: none;
  background: transparent;
  color: var(--k-accent);
  font: inherit;
  cursor: pointer;

  &:hover {
    text-decoration: underline;
  }

  &:disabled {
    cursor: progress;
    opacity: 0.6;
  }
}

.cuk__res-undone {
  margin-left: var(--k-sp-2);
  color: var(--k-muted);
}

.cuk__think {
  margin: 0;
  padding: 0 var(--k-sp-3);
  font-size: var(--k-fs-xs);
  font-style: italic;
  color: var(--k-muted);
  animation: cuk-pulse 1.4s ease-in-out infinite;
}

@keyframes cuk-pulse {
  0%,
  100% {
    opacity: 0.45;
  }
  50% {
    opacity: 1;
  }
}

@media (prefers-reduced-motion: reduce) {
  .cuk__busy,
  .cuk__think {
    animation: none;
  }
}
</style>
