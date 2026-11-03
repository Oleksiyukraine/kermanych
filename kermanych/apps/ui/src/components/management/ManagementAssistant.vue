<template>
  <!-- The Менеджмент assistant: transcript, pending attachments and the composer pill. Two hosts
       render it (docs/specs/2026-11-03-assistant-overlay.md): the Менеджмент tab docks it at the
       section pane's foot (`dock`), the shell's launcher shows it in the centred overlay
       (`overlay`). One conversation behind both — stores/management-chat.ts. -->
  <div class="asst" :class="`asst--${variant}`">
    <section
      v-if="chat.hasConversation"
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
          :aria-expanded="!collapsed"
          :aria-label="collapsed ? t('management.assistant.expand') : t('management.assistant.collapse')"
          @click="toggleCollapsed"
        >
          <span
            class="asst__log-caret"
            :class="{ 'asst__log-caret--open': !collapsed }"
            aria-hidden="true"
          ></span>
          <span class="asst__log-title mono">{{ t('management.assistant.title') }}</span>
          <span v-if="collapsed && chat.busy" class="asst__log-busy mono" aria-live="polite">{{ t('management.assistant.busyShort') }}</span>
        </button>
        <button
          v-tip="t('management.assistant.newChat')"
          class="asst__log-close mono"
          type="button"
          :disabled="chat.busy || chat.resetting"
          :aria-busy="chat.resetting || undefined"
          :aria-label="t('management.assistant.closeChat')"
          @click="newChat()"
        ><KSpinner v-if="chat.resetting" :size="10" /><template v-else>×</template></button>
      </header>
      <div v-show="!collapsed" ref="logEl" class="asst__log-body" @click="onLogClick">
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

    <!-- Pending attachments, ABOVE the pill rather than inside it: in the dock the strip
         grows upward over the section like the transcript does, and the capsule below keeps
         its one-row shape. -->
    <div v-if="attachFiles.length || attachError" class="asst__attach">
      <p v-if="attachError" class="asst__attach-error mono">{{ attachError }}</p>
      <div v-if="attachFiles.length" class="asst__attach-row">
        <span v-for="(f, i) in attachFiles" :key="`${f.name}-${i}`" class="asst__attach-item">
          <img v-if="f.url" :src="f.url" class="asst__attach-thumb" :alt="f.name" />
          <span class="asst__attach-name">{{ f.name }}</span>
          <button
            type="button"
            class="asst__attach-remove"
            :aria-label="t('management.assistant.removeFile', { name: f.name })"
            @click="removeAttachment(i)"
          >✕</button>
        </span>
      </div>
    </div>

    <form
      class="asst__composer"
      :class="{ 'asst__composer--grown': grown }"
      :aria-label="t('management.assistant.title')"
      @submit.prevent="submit"
      @drop.prevent="onAttachDrop"
      @dragover.prevent
    >
      <KHelperPicker :open="pickerOpen" @select="onHelper" @close="closePicker" />
      <textarea
        ref="fieldEl"
        v-model="draft"
        class="asst__c-input"
        rows="1"
        :disabled="composerLocked"
        :placeholder="t('management.assistant.placeholder')"
        :aria-label="t('management.assistant.inputLabel')"
        @input="autoGrow"
        @keydown="onKeydown"
        @paste="onAttachPaste"
      ></textarea>
      <button
        v-tip="t('management.assistant.helpersTip')"
        class="asst__c-helpers mono"
        type="button"
        :aria-label="t('management.assistant.helpers')"
        :disabled="composerLocked"
        @click="pickerOpen = !pickerOpen"
      >/</button>
      <button
        v-tip="t('management.assistant.attach')"
        class="asst__c-helpers"
        type="button"
        :aria-label="t('management.assistant.attach')"
        :disabled="composerLocked"
        @click="attachInput?.click()"
      >📎</button>
      <input
        ref="attachInput"
        type="file"
        class="asst__c-file"
        :accept="ATTACH_ACCEPT"
        multiple
        @change="onAttachPick"
      />
      <!-- The plan the turn is charged to. This chat runs through the same `omp`, the
           same provider account and the same subscription as every agent, so a message
           here is a message debited there — the figure sits in the composer because
           that is where the spending decision is made. Absent entirely when no plan can
           be reported: no figure beats a zero nobody can stand behind. -->
      <span
        v-if="planChip"
        v-tip="planChip.hint"
        class="asst__c-plan mono"
      >{{ planChip.short }} {{ planChip.percent }}</span>
      <button
        v-tip="chat.busy ? t('management.assistant.busy') : t('management.assistant.send')"
        class="asst__c-send"
        type="submit"
        :disabled="!canSend"
        :aria-busy="chat.busy"
        :aria-label="chat.busy ? t('management.assistant.busy') : t('management.assistant.sendShort')"
      ><span
        class="asst__c-glyph"
        :class="{ 'asst__c-glyph--busy': chat.busy }"
        aria-hidden="true"
      >↑</span></button>
    </form>
  </div>
</template>

<script setup lang="ts">
// The Менеджмент assistant's view: the store (stores/management-chat.ts) owns the conversation
// and the turn in flight; this component owns what is typed but not yet sent (draft, files),
// the fold of the transcript and the «Думає…» clock. `section` is the Менеджмент section the
// turn is asked from — the page passes its active child route, the overlay always «Огляд».
import { computed, nextTick, onUnmounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useI18n } from 'vue-i18n';
import { prependHelper } from '@kermanych/core';
import { confirmAction } from '../../lib/confirm';
import { useManagementChat } from 'stores/management-chat';
import { useProjectDocs } from 'stores/project-docs';
import { useAssistantOverlay } from 'stores/assistant-overlay';
import KChatMessage from 'components/kit/KChatMessage.vue';
import KHelperPicker from 'components/kit/KHelperPicker.vue';
import KSpinner from 'components/kit/KSpinner.vue';
import { useAsyncAction } from '../../composables/useAsyncAction';
import { renderMarkdown } from '../../lib/markdown';
import { percent, planWindow, renderWindow } from '../../lib/format';
import { until, renderTime } from '../../lib/time';
import { useNow } from '../../composables/useNow';
import { useSubscriptionUsage } from '../../composables/useSubscriptionUsage';
import { useFileAttach } from '../../composables/useFileAttach';
import { ATTACH_ACCEPT } from '../../lib/files';

const props = defineProps<{
  section: string;
  variant: 'dock' | 'overlay';
}>();

const { t } = useI18n();
const route = useRoute();
const router = useRouter();

const chat = useManagementChat();
const draft = ref('');
const fieldEl = ref<HTMLTextAreaElement | null>(null);
const logEl = ref<HTMLElement | null>(null);

// Documentation citations. The assistant cites each used fragment as a markdown link
// [шлях › heading](kdoc:folder|path|line); a click opens that file in the docs preview,
// switching to the Проєктна документація section first if the operator wandered off. The
// project is the one the docs screen has selected, which is also the one retrieval scoped to.
// From the overlay the same click leaves for that section, and the launcher closes the overlay
// on the way in (decision 8).
const docs = useProjectDocs();
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
  void docs.openFile(projectId, folder, path);
}

// Folds the transcript to its header bar and back. Purely a VIEW state held on the
// component — the conversation and any turn in flight live in the store, so folding the
// window never aborts `chat.send`; the model keeps working and the answer lands in the
// transcript whether it is on screen or not. Expanding re-pins the newest entry, since the
// body was display:none while folded and could not follow the log down.
const collapsed = ref(false);
function toggleCollapsed(): void {
  collapsed.value = !collapsed.value;
  if (!collapsed.value) scrollLog();
}

// Take the keyboard: unfold the transcript and put the caret in the field. The overlay calls it
// on open; on the Менеджмент tab a summons (⌘K, the circle) lands here instead of opening the
// overlay over the dock (decision 7).
function focus(): void {
  if (collapsed.value) toggleCollapsed();
  void nextTick(() => fieldEl.value?.focus());
}
defineExpose({ focus });

if (props.variant === 'dock') {
  const overlay = useAssistantOverlay();
  watch(() => overlay.summons, focus);
}

// The field grows with the text and then scrolls, so Shift+Enter newlines stay visible
// instead of being clipped by a one-line input. 132px ≈ six lines of the pill's type.
const MAX_FIELD_PX = 132;
// A stadium is the right shape for one line and the wrong one for three: at full pill
// radius the corners of a grown field eat the ends of its middle rows.
const grown = ref(false);

function autoGrow(): void {
  const el = fieldEl.value;
  if (!el) return;
  // An EMPTY field goes straight back to its one-line floor without measuring. Chrome
  // includes the rendered placeholder in an empty textarea's scrollHeight, and this
  // field's placeholder is long enough to wrap — measured, every clear (send, delete-all)
  // grew the empty pill to the placeholder's two lines.
  if (draft.value === '') {
    el.style.height = '';
    grown.value = false;
    return;
  }
  el.style.height = 'auto';
  el.style.height = `${Math.min(el.scrollHeight, MAX_FIELD_PX)}px`;
  // Measured against the field's OWN line-height rather than a pixel constant, so a theme
  // that changes the type scale cannot desynchronise the shape from the content.
  grown.value = el.scrollHeight > parseFloat(getComputedStyle(el).lineHeight) * 1.5;
}

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
const canSend = computed(() => (draft.value.trim().length > 0 || attachFiles.value.length > 0) && !composerLocked.value);

// Attachments — images the model sees natively plus the documents (PDF, Excel, Word,
// Pages, Markdown) the api lands on disk for the read tool. Collected by paste, drop or the 📎
// pick; sent with the turn and cleared the moment it is on its way, like the draft.
const {
  files: attachFiles,
  error: attachError,
  onPaste: onAttachPaste,
  onDrop: onAttachDrop,
  remove: removeAttachment,
  clear: clearAttachments,
  addFiles: addAttachmentFiles,
} = useFileAttach();
const attachInput = ref<HTMLInputElement | null>(null);

function onAttachPick(e: Event): void {
  const input = e.target as HTMLInputElement;
  if (input.files) void addAttachmentFiles(input.files);
  input.value = '';
}

// The section travels with the message: the store has no router of its own (Quasar builds
// one per app in a factory, and a store setup has no injection context to reach it), and the
// host already knows which section the turn is asked from. One source of truth.
function submit(): void {
  if (!canSend.value) return;
  const text = draft.value;
  const files = attachFiles.value;
  // Cleared before the await: the turn is already in the transcript, and a field that keeps
  // the sent text invites sending it twice.
  draft.value = '';
  clearAttachments();
  void nextTick(autoGrow);
  // Sending a new turn re-opens a folded transcript, the same way the first message opens
  // it: the operator is asking to watch this answer, not just to send it into a hidden log.
  collapsed.value = false;
  void chat.send(text, props.section, files);
}

// Хелпери. This component has its own textarea rather than KComposer, so the picker is wired
// twice — the panel component is shared, the caret handling is three lines either side.
const pickerOpen = ref(false);
function closePicker(): void {
  pickerOpen.value = false;
  fieldEl.value?.focus();
}
function onHelper(name: string): void {
  draft.value = prependHelper(draft.value, name);
  void nextTick(autoGrow);
}

// Enter sends; Shift+Enter inserts a newline. Enter mid-IME-composition is ignored, so
// committing a Ukrainian or CJK candidate does not fire the message. `/` on an empty draft
// opens the picker instead of typing the slash, exactly as in KComposer.
function onKeydown(e: KeyboardEvent): void {
  if (e.key === '/' && draft.value === '') {
    e.preventDefault();
    pickerOpen.value = true;
    return;
  }
  if (e.key !== 'Enter' || e.shiftKey || e.isComposing) return;
  e.preventDefault();
  submit();
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
  // The overlay mounts while a turn may already be in flight (sent from the Менеджмент tab).
  { immediate: true },
);

onUnmounted(() => clearInterval(thinkTimer));

// PLAN SPEND — the same figure the sidebar shows, folded to the single tightest window.
// The composer has room for one number, and the number that matters before spending a turn
// is the window closest to its ceiling. `providers` empty means nothing can be reported (no
// omp on PATH, no authenticated plan), and then the chip is absent rather than zero.
const { usage: planUsage } = useSubscriptionUsage();
const planNow = useNow(30_000);

const planChip = computed(() => {
  const providers = planUsage.value?.providers ?? [];
  const windows = providers.flatMap((p) => p.windows);
  const tightest = windows.reduce<(typeof windows)[number] | undefined>(
    (worst, w) => (worst && worst.usedPercent >= w.usedPercent ? worst : w),
    undefined,
  );
  if (!tightest) return undefined;
  return {
    short: renderWindow(t, planWindow(tightest.id)),
    percent: percent(tightest.usedPercent),
    // The detail the one-number chip drops, plus the sentence that explains why a
    // management chat shows a provider plan at all.
    hint: [
      t('management.plan.note'),
      ...providers.flatMap((p) => [
        p.provider[0]!.toUpperCase() + p.provider.slice(1),
        ...(p.accounts > 1 ? [t('management.plan.accounts', { count: p.accounts })] : []),
        ...p.windows.map(
          (w) =>
            `${w.label}: ${percent(w.usedPercent)}` +
            (w.resetsAt ? ` — ${t('management.plan.resetsIn', { time: renderTime(t, until(w.resetsAt, planNow.value)) })}` : ''),
        ),
      ]),
    ].join(' · '),
  };
});
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

// ── Overlay — the same three glass pieces stacked in flow ────────────────────
// The overlay's dialog sets the size; here the transcript takes whatever height is left over
// the composer and scrolls inside it, so a long conversation never pushes the pill off screen.
.asst--overlay {
  display: flex;
  flex-direction: column;
  min-height: 0;
  flex: 0 1 auto;

  .asst__log {
    flex: 0 1 auto;
    min-height: 0;
    margin-bottom: var(--k-sp-2);
  }

  .asst__attach,
  .asst__composer {
    flex: none;
  }

  // Over a whole page rather than a section's own canvas, the dock's 74% frost lets the
  // page's text read through the transcript; the overlay's glass is denser.
  .asst__log,
  .asst__attach,
  .asst__composer {
    background: color-mix(in srgb, var(--k-surface) 94%, transparent);
  }
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

// ── Pending attachments — the strip above the pill ───────────────────────────
// Same frost recipe as the pill and the log (one glass object in three parts), on the
// panel radius: this is a list, not a control.
.asst__attach {
  display: flex;
  flex-direction: column;
  gap: var(--k-sp-2);
  margin-bottom: var(--k-sp-2);
  padding: var(--k-sp-2) var(--k-sp-3);
  background: color-mix(in srgb, var(--k-surface) 74%, transparent);
  -webkit-backdrop-filter: blur(22px) saturate(150%);
  backdrop-filter: blur(22px) saturate(150%);
  border: var(--k-rule-thin) solid var(--k-line-strong);
  border-radius: var(--k-r-lg);
  box-shadow:
    var(--k-shadow-toast),
    inset 0 1px 0 color-mix(in srgb, #fff 8%, transparent);
}

.asst__attach-error {
  margin: 0;
  font-size: var(--k-fs-xs);
  color: var(--k-danger);
}

.asst__attach-row {
  display: flex;
  flex-wrap: wrap;
  gap: var(--k-sp-2);
}

// One pending file: thumbnail (images) or bare name (documents), and the ✕ that drops it
// before sending.
.asst__attach-item {
  display: inline-flex;
  align-items: center;
  gap: var(--k-sp-2);
  max-width: 240px;
  padding: 3px var(--k-sp-2);
  background: color-mix(in srgb, var(--k-surface2) 60%, transparent);
  border: var(--k-rule-thin) solid var(--k-line);
  border-radius: var(--k-r-sm);
}

.asst__attach-thumb {
  flex: none;
  width: 24px;
  height: 24px;
  object-fit: cover;
  border-radius: 4px;
}

.asst__attach-name {
  font-size: var(--k-fs-xs);
  color: var(--k-text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.asst__attach-remove {
  flex: none;
  width: 16px;
  height: 16px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  appearance: none;
  border: none;
  padding: 0;
  background: transparent;
  color: var(--k-muted);
  // Glyph-only control: the icon scale's floor, sized to the 16px box above.
  font-size: var(--k-icon-xs);
  line-height: 1;
  cursor: pointer;

  &:hover {
    color: var(--k-text);
  }
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

// The 📎's hidden <input type=file>, reached only through the button.
.asst__c-file {
  display: none;
}

.asst__composer {
  // The Хелпери panel is anchored to this pill, above it.
  position: relative;
  display: flex;
  // Bottom-aligned, not centred: once the field grows to three lines the controls belong on
  // the baseline of the last one, the way they sit on the only line of a single-line pill.
  align-items: flex-end;
  gap: var(--k-sp-2);
  // Left pad set optically against the stadium's own radius now that no icon sits inside
  // the curve: at 12px the text started inside the corner's sweep.
  padding: 7px 7px 7px var(--k-sp-5);
  // Frosted, not see-through: a heavy blur under a mostly-opaque surface tint,
  // so text stays readable while the glow behind still bleeds through the edges.
  background: color-mix(in srgb, var(--k-surface) 74%, transparent);
  -webkit-backdrop-filter: blur(22px) saturate(150%);
  backdrop-filter: blur(22px) saturate(150%);
  border: var(--k-rule-thin) solid var(--k-line-strong);
  border-radius: var(--k-r-pill);
  // Cast + the 1px top highlight that sells a glass edge under a light source.
  box-shadow:
    var(--k-shadow-toast),
    inset 0 1px 0 color-mix(in srgb, #fff 8%, transparent);
  transition: border-radius 0.16s ease;
}

.asst__composer--grown {
  border-radius: var(--k-r-lg);
}

.asst__c-input {
  flex: 1;
  min-width: 0;
  // Centred against the row's tallest control (the 36px send disc) while the field is one
  // line high, so the placeholder and the first line of text sit on the pill's middle
  // instead of 3px below it. Once the field outgrows the disc it IS the tallest item and
  // this has no effect — the composer's `flex-end` then puts the controls on its last line.
  align-self: center;
  // The height is written by autoGrow(); this is the floor it starts from and returns to.
  height: 30px;
  max-height: 132px;
  padding: 5px 0;
  appearance: none;
  resize: none;
  overflow-y: auto;
  border: none;
  background: transparent;
  font-family: var(--k-font-ui);
  font-size: var(--k-fs-md);
  line-height: 20px;
  letter-spacing: -0.01em;
  color: var(--k-text);

  &:focus {
    outline: none;
  }

  // Disabled while a turn is in flight: the field keeps its place in the pill and only
  // stops taking text, so nothing moves when the answer lands.
  &:disabled {
    cursor: not-allowed;
    color: var(--k-muted);
  }

  &::placeholder {
    color: var(--k-faint);
  }

  &::selection {
    background: color-mix(in srgb, var(--k-accent) 28%, transparent);
  }
}

// The Хелпери opener. A bare slash, because that is the token it inserts and the key that
// opens the same panel from the keyboard.
.asst__c-helpers {
  flex: none;
  align-self: center;
  width: 26px;
  height: 26px;
  padding: 0;
  border: var(--k-rule-thin) solid var(--k-line);
  border-radius: var(--k-r-pill);
  background: transparent;
  color: var(--k-muted);
  font-size: var(--k-fs-sm);
  line-height: 1;
  cursor: pointer;
  transition: border-color 0.12s, color 0.12s;

  &:hover:not(:disabled) {
    border-color: var(--k-text);
    color: var(--k-text);
  }

  &:disabled {
    cursor: not-allowed;
    opacity: 0.5;
  }
}

// The plan chip. Mono because it is a figure, quiet because it is context for a decision
// rather than the decision — the tooltip carries the per-window detail.
.asst__c-plan {
  flex: none;
  align-self: center;
  padding: 3px var(--k-sp-2);
  font-size: var(--k-fs-xs);
  line-height: 1.4;
  color: var(--k-muted);
  background: color-mix(in srgb, var(--k-surface2) 60%, transparent);
  border: var(--k-rule-thin) solid var(--k-line);
  border-radius: var(--k-r-pill);
  white-space: nowrap;
}

// The one loud element, exactly as in the reference: a filled accent disc.
.asst__c-send {
  flex: none;
  width: 36px;
  height: 36px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  appearance: none;
  border: none;
  border-radius: var(--k-r-pill);
  background: var(--k-accent);
  color: var(--k-on-accent);
  font-size: 19px;
  font-weight: var(--k-fw-semibold);
  line-height: 1;
  box-shadow: 0 4px 16px -4px color-mix(in srgb, var(--k-accent) 75%, transparent);

  // Not dimmed: `opacity` on an accent disc washes it to salmon over the light
  // canvas. The disabled state is carried by the cursor and by the arrow inside,
  // so the disc keeps the exact hue it has when it works.
  &:disabled {
    cursor: not-allowed;
  }
}

// The in-flight signal, on the GLYPH rather than the disc, for the reason above: the arrow
// breathes while the model is answering. The house pulse (see KToolRow, KStatusDot), which
// keeps «working» reading the same everywhere in the app.
.asst__c-glyph {
  display: inline-flex;
}

.asst__c-glyph--busy {
  animation: asst-send-pulse 1.4s ease-in-out infinite;
}

@keyframes asst-send-pulse {
  0%,
  100% {
    opacity: 0.4;
  }
  50% {
    opacity: 1;
  }
}
</style>
