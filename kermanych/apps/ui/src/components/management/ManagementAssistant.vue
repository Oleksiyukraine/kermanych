<template>
  <!-- The Менеджмент assistant: transcript and the composer pill. Two hosts render it: the
       Менеджмент tab docks it at the section pane's foot (`dock`), and the avatar's window
       shows it as the second panel of its accordion beside ЦУК (`overlay`,
       docs/specs/2026-11-04-cuk-control-console.md, decision 2). One conversation behind
       both — stores/management-chat.ts. In the window the header is always there: folded,
       it is the bar that expands this panel. -->
  <div class="asst" :class="[`asst--${variant}`, { 'asst--folded': folded }]">
    <section
      v-if="chat.hasConversation || variant === 'overlay'"
      class="asst__log"
      :aria-label="t('management.assistant.logLabel')"
    >
      <header class="asst__log-head">
        <!-- The title doubles as the collapse control: pressing it folds the transcript
             to this bar and back. It is a VIEW toggle only — the turn in flight lives in
             the store (`chat.send`), so folding the window never touches the request. The
             heartbeat moves up here while collapsed so a working assistant still says so
             with its transcript hidden. -->
        <button
          class="asst__log-toggle"
          type="button"
          :aria-expanded="!isFolded"
          :aria-label="isFolded ? t('management.assistant.expand') : t('management.assistant.collapse')"
          @click="toggleCollapsed"
        >
          <span
            class="asst__log-caret"
            :class="{ 'asst__log-caret--open': !isFolded }"
            aria-hidden="true"
          ></span>
          <span class="asst__log-title mono">{{ t('management.assistant.title') }}</span>
          <span v-if="isFolded && chat.busy" class="asst__log-busy mono" aria-live="polite">{{ t('management.assistant.busyShort') }}</span>
        </button>
        <button
          v-if="chat.hasConversation"
          v-tip="t('management.assistant.newChat')"
          class="asst__log-close mono"
          type="button"
          :disabled="chat.busy || chat.resetting"
          :aria-busy="chat.resetting || undefined"
          :aria-label="t('management.assistant.closeChat')"
          @click="newChat()"
        ><KSpinner v-if="chat.resetting" :size="10" /><template v-else>×</template></button>
      </header>
      <div v-show="!isFolded" ref="logEl" class="asst__log-body" @click="onLogClick">
        <p v-if="!chat.hasConversation" class="asst__empty">{{ t('management.assistant.empty') }}</p>
        <template v-for="e in chat.entries" :key="e.id">
          <KChatMessage v-if="e.kind === 'user'" role="user">
            <template v-if="e.text">{{ e.text }}</template>
            <!-- What travelled with the words: image attachments echo as thumbnails,
                 documents as named chips — the transcript must show what the model
                 was actually given, or «додай цей файл до тікета» reads as nonsense
                 a turn later. -->
            <span v-if="e.files?.length" class="asst__msg-files">
              <template v-for="f in e.files" :key="f.name">
                <img v-if="f.url" :src="f.url" class="asst__msg-thumb" :alt="f.name" />
                <span v-else class="asst__msg-doc mono">{{ f.name }}</span>
              </template>
            </span>
          </KChatMessage>
          <KChatMessage v-else-if="e.kind === 'assistant'" role="assistant">
            <div class="k-log__markdown" v-html="renderMarkdown(e.text)"></div>
          </KChatMessage>
          <!-- What the APP did about the turn, not what the model said about it. Mono
               and colour-coded because a refusal that reads like prose gets skimmed as
               part of the answer — and stating WHY a section cannot be changed is the
               feature here, not an aside. -->
          <p v-else class="asst__res mono" :class="`asst__res--${e.level}`">{{ e.text }}</p>
        </template>
        <!-- The turn in flight. A management turn can grep three repositories before
             it answers (the api allows four minutes), so the wait needs a heartbeat:
             without one the chat looks dead and the operator sends the question again.
             Same «Думаю…» idiom as the agent panel, with the seconds counting up
             because a static label held for two minutes reads as a hang. -->
        <p v-if="chat.busy" class="asst__think" aria-live="polite">{{ thinkingLabel }}</p>
      </div>
    </section>

    <AssistantComposer
      v-show="!folded"
      ref="composerEl"
      :busy="chat.busy"
      :locked="composerLocked"
      :dense="variant === 'overlay'"
      :placeholder="t('management.assistant.placeholder')"
      :input-label="t('management.assistant.inputLabel')"
      :form-label="t('management.assistant.title')"
      :attach-tip="t('management.assistant.attach')"
      @submit="submit"
    />
  </div>
</template>

<script setup lang="ts">
// The Менеджмент assistant's view: the store (stores/management-chat.ts) owns the conversation
// and the turn in flight; the shared composer (components/assistant/AssistantComposer.vue)
// owns what is typed but not yet sent; this component owns the fold of the transcript and the
// «Думає…» clock. `section` is the Менеджмент section the turn is asked from — the page passes
// its active child route, the window always «Огляд».
import { computed, nextTick, onUnmounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useI18n } from 'vue-i18n';
import { confirmAction } from '../../lib/confirm';
import { useManagementChat } from 'stores/management-chat';
import { useProjectDocs } from 'stores/project-docs';
import { useAssistantOverlay } from 'stores/assistant-overlay';
import KChatMessage from 'components/kit/KChatMessage.vue';
import KSpinner from 'components/kit/KSpinner.vue';
import AssistantComposer from 'components/assistant/AssistantComposer.vue';
import { useAsyncAction } from '../../composables/useAsyncAction';
import { renderMarkdown } from '../../lib/markdown';
import type { AttachedFile } from '../../lib/files';

const props = defineProps<{
  section: string;
  variant: 'dock' | 'overlay';
  // The window's accordion: this panel is the folded one — only its title bar shows.
  folded?: boolean;
}>();

// In the window the title bar does not fold the transcript in place: it hands the accordion
// to the other panel or takes it back (decision 2), which the host decides.
const emit = defineEmits<{ toggle: [] }>();

const { t } = useI18n();
const route = useRoute();
const router = useRouter();

const chat = useManagementChat();
const composerEl = ref<InstanceType<typeof AssistantComposer> | null>(null);
const logEl = ref<HTMLElement | null>(null);

// Documentation citations. The assistant cites each used fragment as a markdown link
// [шлях › heading](kdoc:folder|path|line); a click opens that file in the docs preview,
// switching to the Проєктна документація section first if the operator wandered off. The
// project is the one the docs screen has selected, which is also the one retrieval scoped to.
// From the window the same click leaves for that section, and the launcher closes the window
// on the way in.
const docs = useProjectDocs();
const overlay = useAssistantOverlay();
function onLogClick(ev: MouseEvent): void {
  if (!(ev.target instanceof HTMLElement)) return;
  const anchor = ev.target.closest('a');
  if (!anchor) return;
  const href = anchor.getAttribute('href') ?? '';
  if (!href.startsWith('kdoc:')) return;
  ev.preventDefault();
  const [folder, path] = decodeURIComponent(href.slice('kdoc:'.length)).split('|');
  const projectId = docs.activeProjectId;
  if (!folder || !path || !projectId) return;
  if (route.name !== 'management-docs') void router.push({ name: 'management-docs' });
  if (props.variant === 'overlay') overlay.close();
  void docs.openFile(projectId, folder, path);
}

// Folds the transcript to its header bar and back. Purely a VIEW state — the conversation and
// any turn in flight live in the store, so folding never aborts `chat.send`; the answer lands
// in the transcript whether it is on screen or not. Expanding re-pins the newest entry, since
// the body was display:none while folded and could not follow the log down. In the window the
// fold is the accordion's (`folded`), not this component's.
const collapsed = ref(false);
const isFolded = computed(() => (props.variant === 'overlay' ? !!props.folded : collapsed.value));
function toggleCollapsed(): void {
  if (props.variant === 'overlay') {
    emit('toggle');
    return;
  }
  collapsed.value = !collapsed.value;
  if (!collapsed.value) scrollLog();
}
watch(isFolded, (folded) => {
  if (!folded) scrollLog();
});

// Take the keyboard: unfold the transcript and put the caret in the field.
function focus(): void {
  if (props.variant === 'dock' && collapsed.value) toggleCollapsed();
  composerEl.value?.focus();
}
defineExpose({ focus });

// «Новий чат» keeps the composer locked until the api has dropped the old conversation
// (stores/management-chat.ts `resetting`); the store reports a failure in the log itself.
// It clears the conversation for good, so it asks first — unless there is none to lose. The
// question comes before the action: reading the dialog is not work in progress, so it neither
// lights the progress bar nor holds the button busy.
const resetChat = useAsyncAction(() => chat.reset());
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
const composerLocked = computed(() => chat.busy || chat.resetting);

// The section travels with the message: the store has no router of its own (Quasar builds
// one per app in a factory, and a store setup has no injection context to reach it), and the
// host already knows which section the turn is asked from. One source of truth.
function submit(text: string, files: AttachedFile[]): void {
  // Sending a new turn re-opens a folded transcript, the same way the first message opens
  // it: the operator is asking to watch this answer, not just to send it into a hidden log.
  collapsed.value = false;
  void chat.send(text, props.section, files);
}

// Keep the newest entry in view as the transcript grows — deep, because a turn appends to
// the same array rather than replacing it.
function scrollLog(): void {
  void nextTick(() => {
    const el = logEl.value;
    if (el) el.scrollTop = el.scrollHeight;
  });
}

watch(() => chat.entries, scrollLog, { deep: true });

// «Думає» — the heartbeat under the transcript while a turn is in flight. The seconds are
// counted by an interval that exists ONLY during a turn: a permanent one-second ticker would
// wake an idle tab (and the machine) forever to redraw a line that is not on screen.
const thinkingSec = ref(0);
let thinkTimer: ReturnType<typeof setInterval> | undefined;

// Silent for the first seconds — a fast answer must not flash a stopwatch — then the count
// appears and keeps the wait honest.
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
    // The «Думає…» line appends below the last entry, so the log has to follow it down.
    scrollLog();
  },
  // The window mounts while a turn may already be in flight (sent from the Менеджмент tab).
  { immediate: true },
);

onUnmounted(() => clearInterval(thinkTimer));
</script>

<style scoped lang="scss">
// ── Dock — the frosted capsule and the transcript above it ───────────────────
// On the Менеджмент tab the assistant does not sit IN the pane's column, it floats over it:
// absolutely positioned at the pane's foot so the section's own content passes behind the
// glass rather than being pushed above it. It is also the positioning context for the
// transcript (`bottom: 100%`), which is why the section keeps its geometry as the conversation
// grows — a chat that reflows the screen it is describing is unusable.
.asst--dock {
  position: absolute;
  // Centred on the pane's foot, not stretched across it: a capsule pulled to the
  // full width of a 1400px window reads as a toolbar, and its trailing controls
  // end up a screen away from the text they belong to. Capped at a comfortable
  // measure and centred, it stays a single object.
  left: 50%;
  transform: translateX(-50%);
  bottom: var(--k-sp-4);
  // The containing block is the pane's PADDING box, so the pane's own side padding has to
  // be subtracted here or the pill would run under its border on a narrow window.
  width: min(680px, calc(100% - var(--k-sp-5) * 2));
  z-index: 2;

  .asst__log {
    position: absolute;
    left: 0;
    right: 0;
    bottom: 100%;
    margin-bottom: var(--k-sp-2);
    max-height: min(46vh, 520px);
  }
}

// ── Window — one panel of the avatar window's accordion ──────────────────────
// Expanded, the panel takes the column's height left over by the folded one and the
// transcript scrolls inside it, so a long conversation never pushes the pill off screen.
// Folded, only the title bar is left: the bar that hands the accordion back to this panel.
.asst--overlay {
  display: flex;
  flex-direction: column;
  min-height: 0;
  flex: 1 1 auto;

  .asst__log {
    flex: 1 1 auto;
    min-height: 0;
    margin-bottom: var(--k-sp-2);
    // Over a whole page rather than a section's own canvas, the dock's 74% frost lets the
    // page's text read through the transcript; the window's glass is denser.
    background: color-mix(in srgb, var(--k-surface) 94%, transparent);
  }
}

.asst--overlay.asst--folded {
  flex: none;

  .asst__log {
    flex: none;
  }

  .asst__log-head {
    border-bottom: none;
  }
}

// An empty conversation in the window still has its panel; one quiet line says what goes here.
.asst__empty {
  margin: 0;
  color: var(--k-muted);
  font-size: var(--k-fs-sm);
}

// The same frost recipe as the pill — one glass object split in two, not two materials —
// but on `--k-r-lg`: a stadium is a shape for a control, and this is a panel of text.
.asst__log {
  display: flex;
  flex-direction: column;
  background: color-mix(in srgb, var(--k-surface) 74%, transparent);
  -webkit-backdrop-filter: blur(22px) saturate(150%);
  backdrop-filter: blur(22px) saturate(150%);
  border: var(--k-rule-thin) solid var(--k-line-strong);
  border-radius: var(--k-r-lg);
  box-shadow:
    var(--k-shadow-toast),
    inset 0 1px 0 color-mix(in srgb, #fff 8%, transparent);
  overflow: hidden;
}

.asst__log-head {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--k-sp-2);
  padding: var(--k-sp-2) var(--k-sp-2) var(--k-sp-2) var(--k-sp-3);
  border-bottom: var(--k-rule-thin) solid var(--k-line);
}

// The title is a button now: pressing anywhere along the bar folds the transcript. It stays
// visually a title — transparent, no chrome — so the affordance is the caret beside it and
// the pointer cursor, not a second boxed control competing with the × on the right.
.asst__log-toggle {
  flex: 1;
  min-width: 0;
  display: inline-flex;
  align-items: center;
  gap: var(--k-sp-2);
  appearance: none;
  border: none;
  padding: 0;
  background: transparent;
  cursor: pointer;
  text-align: left;

  &:hover .asst__log-title {
    color: var(--k-muted);
  }

  &:hover .asst__log-caret {
    color: var(--k-text);
  }
}

// Points down when the transcript is open, right when it is folded — the app's one
// disclosure idiom, shared with the workspace tree's fold marker. A transform, not two
// glyphs, so the turn is a rotation the eye tracks.
//
// DRAWN, not typed: as a ▾ glyph at 10px it was a faint hairline that read as punctuation
// beside the uppercase title, and `--k-font-ui` carries no geometric-shapes glyph, so the
// fallback face also hung it below the title's centre line. A clipped box has no baseline
// to drift and its ink IS its box — same 6x10 footprint as `.k-ws__caret`, at `--k-muted`
// so the control is legible before it is hovered.
.asst__log-caret {
  flex: none;
  width: 6px;
  height: 10px;
  background: currentColor;
  clip-path: polygon(0 0, 100% 50%, 0 100%);
  color: var(--k-muted);
  transition: transform 0.15s ease, color 0.12s;
}
.asst__log-caret--open {
  transform: rotate(90deg);
}

// The heartbeat, hoisted to the header while folded: with the transcript hidden this is the
// only place left to say a turn is still in flight, so a folded window never looks idle
// while the model works. Same muted pulse as `.asst__think` below.
.asst__log-busy {
  flex: none;
  margin-left: auto;
  font-size: var(--k-fs-xs);
  font-style: italic;
  color: var(--k-muted);
  animation: asst-think-pulse 1.4s ease-in-out infinite;
}

.asst__log-title {
  font-size: var(--k-fs-xs);
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: var(--k-faint);
}

.asst__log-close {
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

.asst__log-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: var(--k-sp-3);
  padding: var(--k-sp-3);
}

// The turn in flight. Italic, muted and gently pulsing — the app's one «working» idiom,
// shared with the agent panel's «Думаю…» (components/kit/KPanel.vue), so a wait reads the
// same wherever it happens. NOT mono: this is the assistant's own state, not the app
// reporting an outcome, and the mono rule belongs to `.asst__res`.
.asst__think {
  margin: 0;
  padding: 0 var(--k-sp-3);
  font-size: var(--k-fs-xs);
  font-style: italic;
  color: var(--k-muted);
  animation: asst-think-pulse 1.4s ease-in-out infinite;
}

@keyframes asst-think-pulse {
  0%,
  100% {
    opacity: 0.45;
  }
  50% {
    opacity: 1;
  }
}

// What the app did about a turn. A left rule and mono type, so a refusal cannot be skimmed
// as part of the answer above it: the whole point of the section table's `limitation` is
// that the operator READS why a section could not be changed.
.asst__res {
  margin: 0;
  padding: 6px var(--k-sp-3);
  font-size: var(--k-fs-xs);
  line-height: 1.5;
  border-left: 2px solid var(--k-line-strong);
  color: var(--k-muted);
}

// info is the quiet default above; warn and error borrow the register's own severity
// colours, so «не можу» and «зламалось» never read as the same event.
.asst__res--warn {
  color: var(--k-text);
  border-left-color: var(--k-accent);
  background: color-mix(in srgb, var(--k-accent) 8%, transparent);
}

.asst__res--error {
  color: var(--k-danger);
  border-left-color: var(--k-danger);
  background: color-mix(in srgb, var(--k-danger) 8%, transparent);
}

// The attachments a sent message carried, echoed inside its bubble.
.asst__msg-files {
  display: flex;
  flex-wrap: wrap;
  gap: var(--k-sp-2);
  margin-top: var(--k-sp-2);
}

.asst__msg-thumb {
  display: block;
  max-width: 160px;
  max-height: 120px;
  border-radius: var(--k-r-sm);
}

.asst__msg-doc {
  font-size: var(--k-fs-xs);
  padding: 2px var(--k-sp-2);
  border: var(--k-rule-thin) solid var(--k-line-strong);
  border-radius: var(--k-r-sm);
  color: var(--k-muted);
}
</style>
