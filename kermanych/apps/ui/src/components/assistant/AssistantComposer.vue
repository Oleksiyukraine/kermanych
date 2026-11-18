<template>
  <!-- The composer pill both assistants type into (docs/specs/2026-11-04-cuk-control-console.md):
       the Менеджмент assistant (dock and window) and ЦУК. It owns what is typed but not yet sent —
       the draft, the pending files, the Хелпери picker — and hands a finished message to its host
       through `submit`; the host's store owns the conversation. -->
  <div class="acomp" :class="{ 'acomp--dense': dense }">
    <!-- OMP MISSING OR SIGNED OUT — both assistants run on omp whatever the provider
         (docs/specs/2026-11-05-remove-managed-claude-code.md, decision 8): the note names the fix
         before a send that could only fail, and sending stays off until a check says omp works.
         The verdict is the shared one (stores/omp-check.ts); an unknown answer blocks nothing. -->
    <div v-if="ompBlock" class="acomp__omp" role="alert">
      <p class="acomp__omp-text">{{ ompBlock }}</p>
      <button type="button" class="acomp__omp-recheck mono" @click="ompCheck.recheck()">
        {{ t('common.omp.recheck') }}
      </button>
    </div>
    <!-- Pending attachments, ABOVE the pill rather than inside it: in the dock the strip
         grows upward over the section like the transcript does, and the capsule below keeps
         its one-row shape. -->
    <div v-if="attachFiles.length || attachError" class="acomp__attach">
      <p v-if="attachError" class="acomp__attach-error mono">{{ attachError }}</p>
      <div v-if="attachFiles.length" class="acomp__attach-row">
        <span v-for="(f, i) in attachFiles" :key="`${f.name}-${i}`" class="acomp__attach-item">
          <img v-if="f.url" :src="f.url" class="acomp__attach-thumb" :alt="f.name" />
          <span class="acomp__attach-name">{{ f.name }}</span>
          <button
            type="button"
            class="acomp__attach-remove"
            :aria-label="t('management.assistant.removeFile', { name: f.name })"
            @click="removeAttachment(i)"
          >✕</button>
        </span>
      </div>
    </div>

    <!-- Dictation (docs/specs/2026-11-18-assistant-voice-dictation.md): the microphone's level,
         what it is doing, and the auto-send countdown with its way out — the same line as
         KComposer's, in the attachment strip's frost above the one-row pill. -->
    <div v-if="dictationState" class="acomp__dictation mono" role="status" aria-live="polite">
      <KSpinner v-if="dictationState.phase === 'starting'" :size="10" />
      <span v-else class="acomp__level" aria-hidden="true">
        <span class="acomp__level-fill" :style="{ transform: `scaleX(${dictationState.level})` }"></span>
      </span>
      <span class="acomp__dictation-state" :class="{ 'acomp__dictation-state--due': dictationState.countdown }">{{ dictationWords }}</span>
      <span v-if="dictationState.countdown" class="acomp__dictation-hint">{{ t('kit.composer.dictation.cancelHint') }}</span>
    </div>

    <form
      class="acomp__pill"
      :class="{ 'acomp__pill--grown': grown }"
      :aria-label="formLabel"
      @submit.prevent="submit"
      @drop.prevent="onAttachDrop"
      @dragover.prevent
    >
      <KHelperPicker :open="pickerOpen" @select="onHelper" @close="closePicker" />
      <textarea
        ref="fieldEl"
        v-model="draft"
        class="acomp__input"
        rows="1"
        :disabled="locked || !!ompBlock"
        :placeholder="placeholder"
        :aria-label="inputLabel"
        @keydown="onKeydown"
        @paste="onAttachPaste"
      ></textarea>
      <button
        v-tip="t('management.assistant.helpersTip')"
        class="acomp__tool mono"
        type="button"
        :aria-label="t('management.assistant.helpers')"
        :disabled="locked || !!ompBlock"
        @click="pickerOpen = !pickerOpen"
      >/</button>
      <button
        v-tip="attachTip"
        class="acomp__tool"
        type="button"
        :aria-label="attachTip"
        :disabled="locked || !!ompBlock"
        @click="attachInput?.click()"
      >📎</button>
      <input
        ref="attachInput"
        type="file"
        class="acomp__file"
        :accept="imagesOnly ? SUPPORTED_IMAGE_TYPES.join(',') : ATTACH_ACCEPT"
        multiple
        @change="onAttachPick"
      />
      <!-- 🎤 / ⌥D: local dictation into this field, as in «Синергія». Usable during a turn — the
           dictated text waits for the answer. `mousedown.prevent`: the field keeps its caret. -->
      <button
        v-tip="dictationState ? t('kit.composer.dictateStop') : t('kit.composer.dictateTip')"
        class="acomp__tool acomp__mic"
        :class="{ 'acomp__mic--on': dictationState }"
        type="button"
        :aria-label="dictationState ? t('kit.composer.dictateStop') : t('kit.composer.dictateTip')"
        :aria-pressed="!!dictationState"
        :aria-busy="dictationState?.phase === 'starting' || dictationState?.phase === 'stopping' || undefined"
        :disabled="!dictationState && !!ompBlock"
        @mousedown.prevent
        @click="toggleDictation"
      >
        <KSpinner v-if="dictationState?.phase === 'starting'" :size="12" />
        <KIcon v-else class="acomp__mic-icon" name="mic" />
      </button>
      <!-- The plan the turn is charged to. Both assistants run through the same `omp`, the
           same provider account and the same subscription as every agent, so a message
           here is a message debited there — the figure sits in the composer because
           that is where the spending decision is made. Absent entirely when no plan can
           be reported: no figure beats a zero nobody can stand behind. -->
      <span
        v-if="planChip"
        v-tip="planChip.hint"
        class="acomp__plan mono"
      >{{ planChip.short }} {{ planChip.percent }}</span>
      <!-- During a turn the send disc becomes «■»: it stops the turn (Esc does the same,
           docs/specs/2026-11-15-faster-assistant-answers.md, decisions 8–9). -->
      <button
        v-if="busy"
        v-tip="t('management.assistant.stop')"
        class="acomp__send acomp__send--stop"
        type="button"
        :disabled="stopping"
        :aria-busy="stopping || undefined"
        :aria-label="t('management.assistant.stopShort')"
        @click="emit('stop')"
      ><span class="acomp__glyph" aria-hidden="true">■</span></button>
      <button
        v-else
        v-tip="t('management.assistant.send')"
        class="acomp__send"
        :class="{ 'acomp__send--due': dictationState?.countdown }"
        type="submit"
        :disabled="!canSend"
        :aria-label="t('management.assistant.sendShort')"
      >
        <!-- The auto-send countdown: the ring empties until the message goes. -->
        <svg
          v-if="dictationState?.countdown"
          :key="dictationState.countdown.at"
          class="acomp__send-ring"
          viewBox="0 0 36 36"
          aria-hidden="true"
        >
          <circle cx="18" cy="18" r="16" pathLength="100" :style="{ animationDuration: `${dictationState.countdown.ms}ms` }" />
        </svg>
        <span class="acomp__glyph" aria-hidden="true">↑</span>
      </button>
    </form>
  </div>
</template>

<script setup lang="ts">
// Extracted from the Менеджмент assistant so ЦУК types into the very same pill: Enter sends,
// Shift+Enter breaks the line, `/` on an empty draft opens Хелпери, files arrive by paste, drop
// or 📎, 🎤 / ⌥D dictates, the field grows to six lines and then scrolls.
import { computed, nextTick, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { prependHelper } from '@kermanych/core';
import KHelperPicker from 'components/kit/KHelperPicker.vue';
import KIcon from 'components/kit/KIcon.vue';
import KSpinner from 'components/kit/KSpinner.vue';
import { percent, planWindow, renderWindow } from '../../lib/format';
import { until, renderTime } from '../../lib/time';
import { useNow } from '../../composables/useNow';
import { useSubscriptionUsage } from '../../composables/useSubscriptionUsage';
import { useFileAttach } from '../../composables/useFileAttach';
import { useComposerDictation, type ComposerDictationHost } from '../../composables/useComposerDictation';
import { useDictationWords } from '../../composables/useDictationWords';
import { ATTACH_ACCEPT, type AttachedFile } from '../../lib/files';
import { SUPPORTED_IMAGE_TYPES } from '../../lib/images';
import { useDraft } from '../../lib/drafts';
import { useOmpCheck } from 'stores/omp-check';

const props = defineProps<{
  // A turn is in flight: the send disc is «■», which emits `stop`.
  busy: boolean;
  // The stop request is on its way: the «■» is locked.
  stopping?: boolean;
  // Nothing may be typed or sent (a turn in flight, a reset in progress).
  locked: boolean;
  placeholder: string;
  inputLabel: string;
  formLabel: string;
  attachTip: string;
  // The host's model cannot open documents, only see images.
  imagesOnly?: boolean;
  // Over a whole page the dock's 74 % frost lets the page read through; the window is denser.
  dense?: boolean;
  // The conversation the typed text belongs to (lib/drafts.ts): kept per conversation across a
  // restart and a switch to another one. Absent: the text lives as long as the component.
  draftKey?: string | undefined;
}>();

const emit = defineEmits<{ submit: [text: string, files: AttachedFile[]]; stop: [] }>();

const { t } = useI18n();

const draft = ref('');
const fieldEl = ref<HTMLTextAreaElement | null>(null);
const typed = useDraft({ text: draft });
// Every change of the text re-fits the field: typing, a restored draft, a helper, a clear after
// sending, a dictated phrase.
watch(draft, () => void nextTick(autoGrow));
watch(
  () => props.draftKey,
  (key) => typed.bind(key ?? null, { text: '' }),
  { immediate: true },
);

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
  // includes the rendered placeholder in an empty textarea's scrollHeight, and a
  // placeholder long enough to wrap grew the empty pill to two lines on every clear.
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

// Attachments — collected by paste, drop or the 📎 pick; sent with the turn and cleared the
// moment it is on its way, like the draft.
const {
  files: attachFiles,
  error: attachError,
  onPaste: onAttachPaste,
  onDrop: onAttachDrop,
  remove: removeAttachment,
  clear: clearAttachments,
  addFiles: addAttachmentFiles,
} = useFileAttach({ imagesOnly: props.imagesOnly ?? false });
const attachInput = ref<HTMLInputElement | null>(null);

function onAttachPick(e: Event): void {
  const input = e.target as HTMLInputElement;
  if (input.files) void addAttachmentFiles(input.files);
  input.value = '';
}

// The blocking note's sentence, or '' while omp works or its state is unknown.
const ompCheck = useOmpCheck();
const ompBlock = computed(() => {
  if (ompCheck.code === 'omp_binary_missing') return t('common.omp.missing');
  if (ompCheck.code === 'omp_not_authenticated') return t('common.omp.signedOut');
  return '';
});

const canSend = computed(
  () => (draft.value.trim().length > 0 || attachFiles.value.length > 0) && !props.locked && !ompBlock.value,
);

function submit(): void {
  if (!canSend.value) return;
  const text = draft.value;
  const files = attachFiles.value;
  // Cleared before the host's await: the turn is already in the transcript, and a field that
  // keeps the sent text invites sending it twice.
  draft.value = '';
  clearAttachments();
  emit('submit', text, files);
}

// Put a ready-made question into the field and send it — ЦУК's example chips.
function send(text: string): void {
  draft.value = text;
  submit();
}

// Dictation (docs/specs/2026-11-18-assistant-voice-dictation.md): each phrase lands at the caret
// and the message sends itself after a pause, as in «Синергія». The assistants have no decision
// block, so nothing is ever answered there. While the composer cannot send (a turn in flight,
// omp blocked) the dictated text waits in the field and its countdown starts afterwards.
const dictationHost: ComposerDictationHost = {
  text: draft,
  field: () => fieldEl.value,
  send: submit,
  sendable: () => !props.locked && !ompBlock.value,
  request: () => undefined,
  answer: () => {},
  blockText: ref(''),
  blockField: () => null,
};
const { state: dictationState, toggle: toggleDictation } = useComposerDictation(() => dictationHost);
const dictationWords = useDictationWords(() => dictationState.value);

// Хелпери. The panel component is shared with KComposer; the caret handling is three lines.
const pickerOpen = ref(false);
function closePicker(): void {
  pickerOpen.value = false;
  fieldEl.value?.focus();
}
function onHelper(name: string): void {
  draft.value = prependHelper(draft.value, name);
}

// Enter sends; Shift+Enter inserts a newline. Enter mid-IME-composition is ignored, so
// committing a Ukrainian or CJK candidate does not fire the message. `/` on an empty draft
// opens the picker instead of typing the slash, exactly as in KComposer.
function onKeydown(e: KeyboardEvent): void {
  // ⌥D toggles dictation, as in KComposer. `code`, not `key`: on macOS ⌥D types «∂».
  if (e.altKey && !e.metaKey && !e.ctrlKey && !e.shiftKey && e.code === 'KeyD') {
    e.preventDefault();
    toggleDictation();
    return;
  }
  if (e.key === '/' && draft.value === '') {
    e.preventDefault();
    pickerOpen.value = true;
    return;
  }
  if (e.key !== 'Enter' || e.shiftKey || e.isComposing) return;
  e.preventDefault();
  submit();
}

function focus(): void {
  void nextTick(() => fieldEl.value?.focus());
}

// Put text into the field without sending it — «Обговорити в ЦУК» on a scheduled run's answer:
// the operator adds the question and sends it himself.
function setDraft(text: string): void {
  draft.value = text;
  focus();
}
defineExpose({ focus, send, setDraft });

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
    // The detail the one-number chip drops, plus the sentence that explains why an
    // assistant shows a provider plan at all.
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
.acomp {
  display: flex;
  flex-direction: column;
}

// ── omp missing or signed out — the blocking note above the pill ─────────────
// The attachment strip's frost, with the danger rule: it is the reason nothing can be sent.
.acomp__omp {
  display: flex;
  align-items: flex-start;
  gap: var(--k-sp-3);
  margin-bottom: var(--k-sp-2);
  padding: var(--k-sp-2) var(--k-sp-3);
  background: color-mix(in srgb, var(--k-surface) 74%, transparent);
  -webkit-backdrop-filter: blur(22px) saturate(150%);
  backdrop-filter: blur(22px) saturate(150%);
  border: var(--k-rule-thin) solid var(--k-danger);
  border-radius: var(--k-r-lg);
  box-shadow: var(--k-shadow-toast);
}

.acomp__omp-text {
  flex: 1;
  margin: 0;
  font-size: var(--k-fs-sm);
  line-height: 1.5;
  color: var(--k-text);
}

.acomp__omp-recheck {
  flex: none;
  padding: 3px var(--k-sp-2);
  background: transparent;
  border: var(--k-rule-thin) solid var(--k-line-strong);
  border-radius: var(--k-r-sm);
  color: var(--k-text);
  font-size: var(--k-fs-xs);
  cursor: pointer;
}

.acomp__omp-recheck:hover {
  border-color: var(--k-accent);
  color: var(--k-accent);
}

// ── Pending attachments — the strip above the pill ───────────────────────────
// Same frost recipe as the pill and the transcript (one glass object in parts), on the
// panel radius: this is a list, not a control.
.acomp__attach {
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

.acomp__attach-error {
  margin: 0;
  font-size: var(--k-fs-xs);
  color: var(--k-danger);
}

.acomp__attach-row {
  display: flex;
  flex-wrap: wrap;
  gap: var(--k-sp-2);
}

// One pending file: thumbnail (images) or bare name (documents), and the ✕ that drops it
// before sending.
.acomp__attach-item {
  display: inline-flex;
  align-items: center;
  gap: var(--k-sp-2);
  max-width: 240px;
  padding: 3px var(--k-sp-2);
  background: color-mix(in srgb, var(--k-surface2) 60%, transparent);
  border: var(--k-rule-thin) solid var(--k-line);
  border-radius: var(--k-r-sm);
}

.acomp__attach-thumb {
  flex: none;
  width: 24px;
  height: 24px;
  object-fit: cover;
  border-radius: 4px;
}

.acomp__attach-name {
  font-size: var(--k-fs-xs);
  color: var(--k-text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.acomp__attach-remove {
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

// The 📎's hidden <input type=file>, reached only through the button.
.acomp__file {
  display: none;
}

// ── Dictation — the quiet line above the pill ─────────────────────────────────
// The attachment strip's frost, one row: level, what the microphone does, the countdown.
.acomp__dictation {
  display: flex;
  align-items: center;
  gap: var(--k-sp-2);
  min-width: 0;
  margin-bottom: var(--k-sp-2);
  padding: var(--k-sp-1) var(--k-sp-3);
  font-size: var(--k-fs-xs);
  color: var(--k-muted);
  background: color-mix(in srgb, var(--k-surface) 74%, transparent);
  -webkit-backdrop-filter: blur(22px) saturate(150%);
  backdrop-filter: blur(22px) saturate(150%);
  border: var(--k-rule-thin) solid var(--k-line-strong);
  border-radius: var(--k-r-lg);
  box-shadow: var(--k-shadow-toast);
}

.acomp--dense .acomp__dictation {
  background: color-mix(in srgb, var(--k-surface) 94%, transparent);
}

.acomp__level {
  flex: none;
  width: 48px;
  height: 4px;
  border-radius: 2px;
  background: var(--k-line);
  overflow: hidden;
}

.acomp__level-fill {
  display: block;
  height: 100%;
  background: var(--k-accent);
  transform-origin: left center;
  transition: transform 120ms linear;
}

.acomp__dictation-state {
  white-space: nowrap;
}

.acomp__dictation-state--due {
  color: var(--k-accent);
}

.acomp__dictation-hint {
  color: var(--k-faint);
  white-space: nowrap;
}

.acomp__pill {
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

.acomp--dense .acomp__attach,
.acomp--dense .acomp__pill {
  background: color-mix(in srgb, var(--k-surface) 94%, transparent);
}

.acomp__pill--grown {
  border-radius: var(--k-r-lg);
}

.acomp__input {
  flex: 1;
  min-width: 0;
  // Centred against the row's tallest control (the 36px send disc) while the field is one
  // line high, so the placeholder and the first line of text sit on the pill's middle
  // instead of 3px below it. Once the field outgrows the disc it IS the tallest item and
  // this has no effect — the pill's `flex-end` then puts the controls on its last line.
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

// The Хелпери opener and the 📎. A bare slash, because that is the token it inserts and the
// key that opens the same panel from the keyboard.
.acomp__tool {
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

// 🎤: a tool button like 📎, lit in the accent while this field dictates.
.acomp__mic {
  display: inline-flex;
  align-items: center;
  justify-content: center;

  &[aria-busy='true'] {
    cursor: progress;
  }
}

.acomp__mic--on,
.acomp__mic--on:hover:not(:disabled) {
  border-color: var(--k-accent);
  color: var(--k-accent);
}

.acomp__mic-icon {
  --k-icon-size: var(--k-icon-sm);
}

// The plan chip. Mono because it is a figure, quiet because it is context for a decision
// rather than the decision — the tooltip carries the per-window detail.
.acomp__plan {
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

// The one loud element: a filled accent disc.
.acomp__send {
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

.acomp__glyph {
  display: inline-flex;
}

// The ring runs around the disc, so the disc is its containing block.
.acomp__send--due {
  position: relative;
}

// The auto-send countdown: a ring around the arrow that empties as the send nears.
.acomp__send-ring {
  position: absolute;
  inset: -3px;
  width: calc(100% + 6px);
  height: calc(100% + 6px);
  transform: rotate(-90deg);
  pointer-events: none;

  circle {
    fill: none;
    stroke: var(--k-accent);
    stroke-width: 2;
    stroke-dasharray: 100;
    stroke-dashoffset: 0;
    animation-name: acomp-ring;
    animation-timing-function: linear;
    animation-fill-mode: forwards;
  }
}

@keyframes acomp-ring {
  to {
    stroke-dashoffset: 100;
  }
}

// «■» is a smaller glyph than «↑» at the same size; the disc stays the same.
.acomp__send--stop {
  font-size: 13px;

  &[aria-busy='true'] {
    cursor: progress;
  }
}

@media (prefers-reduced-motion: reduce) {
  .acomp__level-fill {
    transition: none;
  }
}
</style>
