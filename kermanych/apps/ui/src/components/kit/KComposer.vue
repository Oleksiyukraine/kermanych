<template>
  <div
    class="k-composer"
    :class="{ 'k-composer--focused': focused, 'k-composer--disabled': disabled }"
  >
    <!-- Anchored to the composer's own box, not to the form: the panel has to sit above the
         whole control, attachment strip included. It prevents Enter itself, so mounting it
         inside a form is safe too — ManagementPage does exactly that. -->
    <KHelperPicker :open="pickerOpen" :commands="DEFAULT_COMMANDS" @select="onHelper" @close="closePicker" />
    <!-- The «@» file panel: the session's own tree, opened by `@` at a word start or by the
         @ button. Only when the host names a tree to read (`files`). -->
    <KFilePicker
      v-if="files"
      :open="mention.open.value"
      :source="files"
      @select="mention.select"
      @close="mention.close"
    />
    <KAttachStrip
      v-if="attachImages.length"
      class="k-composer__attach"
      :images="attachImages"
      @remove="removeImage"
    />
    <p v-if="attachError" class="k-composer__attach-error mono">{{ attachError }}</p>
    <form
      class="k-composer__form"
      @submit.prevent="submit"
      @drop.prevent="onImageDrop"
      @dragover.prevent
    >
      <div class="k-composer__input">
        <span class="k-composer__prompt" aria-hidden="true">❯</span>
        <textarea
          ref="fieldEl"
          class="k-composer__field mono"
          :value="modelValue"
          :placeholder="placeholder ?? t('kit.composer.placeholder')"
          :disabled="disabled"
          rows="1"
          @focus="focused = true"
          @blur="focused = false"
          @paste="onImagePaste"
          @input="onInput"
          @keydown="onComposerKeydown"
        ></textarea>
      </div>

      <!-- Composer dictation (docs/specs/2026-11-14-local-voice-dictation.md): a slim line while
           it runs — the microphone's level, what it is doing, and the auto-send countdown with
           its way out (decisions 3 and 6). -->
      <div v-if="dictation" class="k-composer__dictation mono" role="status" aria-live="polite">
        <KSpinner v-if="dictation.phase === 'starting'" :size="10" />
        <span v-else class="k-composer__level" aria-hidden="true">
          <span class="k-composer__level-fill" :style="{ transform: `scaleX(${dictation.level})` }"></span>
        </span>
        <span class="k-composer__dictation-state" :class="{ 'k-composer__dictation-state--due': dictation.countdown }">{{ dictationWords }}</span>
        <span v-if="dictation.countdown" class="k-composer__dictation-hint">{{ t('kit.composer.dictation.cancelHint') }}</span>
      </div>

      <!-- v3 controls row: attach + the session's own facts (model, reasoning effort,
           isolation) on the left, spend + session actions + the accent send FAB on the right.
           Model and effort are live controls, so each carries a caret; isolation is a reading
           — it is fixed when omp is spawned — so it is flat, a mark and a word. -->
      <div class="k-composer__controls">
        <button
          type="button"
          class="k-composer__attach-btn mono"
          v-tip="t('kit.composer.helpersTip')"
          :aria-label="t('kit.composer.helpers')"
          :disabled="disabled"
          @click="pickerOpen = !pickerOpen"
        >/</button>
        <button
          v-if="files"
          type="button"
          class="k-composer__attach-btn mono"
          v-tip="t('kit.composer.filesTip')"
          :aria-label="t('kit.composer.files')"
          :disabled="disabled"
          @click="mention.toggle"
        >@</button>
        <button
          type="button"
          class="k-composer__attach-btn"
          v-tip="t('kit.composer.addImage')"
          :aria-label="t('kit.composer.addImage')"
          :disabled="disabled"
          @click="fileInput?.click()"
        >📎</button>
        <!-- 🎤 (docs/specs/2026-11-14-local-voice-dictation.md, decision 2): dictation into this
             composer, or where the host offers it (`voiceModes`) the Live conversation too — the
             click starts the remembered mode, ▾ picks one. Lit while either runs here.
             `mousedown.prevent`: the field keeps its caret, so a phrase lands where it was. -->
        <span v-if="voice" ref="voiceEl" class="k-composer__voice">
          <button
            type="button"
            class="k-composer__attach-btn"
            :class="{ 'k-composer__attach-btn--on': voiceActive || !!dictation }"
            v-tip="voiceTip"
            :aria-label="voiceTip"
            :aria-pressed="voiceActive || !!dictation"
            :aria-busy="dictation?.phase === 'starting' || dictation?.phase === 'stopping' || undefined"
            @mousedown.prevent
            @click="emit('voice')"
          >
            <KSpinner v-if="dictation?.phase === 'starting'" :size="12" />
            <KIcon v-else class="k-composer__voice-icon" name="mic" />
          </button>
          <button
            v-if="voiceModes"
            type="button"
            class="k-composer__attach-btn k-composer__voice-caret"
            v-tip="t('kit.composer.voiceModes')"
            :aria-label="t('kit.composer.voiceModes')"
            aria-haspopup="menu"
            :aria-expanded="modeMenuOpen"
            @mousedown.prevent
            @click="toggleModeMenu"
          ><span class="k-composer__caret" aria-hidden="true"></span></button>
        </span>
        <KChipSelect
          v-if="model && modelChipOptions.length"
          :model-value="model"
          :options="modelChipOptions"
          :title="t('kit.composer.model')"
          :disabled="disabled"
          :loading="modelLoading"
          @update:model-value="onModelPick"
        />
        <span v-else-if="model" class="k-composer__chip" v-tip="t('kit.composer.model')">
          <KModelMark class="k-composer__chip-mark" :model="model" />
          <span class="mono">{{ model }}</span>
        </span>
        <KChipSelect
          v-if="effort"
          :model-value="effort"
          :options="effortChoices"
          icon="⚡"
          :title="t('kit.composer.effort')"
          :disabled="disabled"
          :loading="effortLoading"
          @update:model-value="(level) => emit('effort', level)"
        />
        <span v-if="worktree" class="k-composer__chip" v-tip="t('kit.composer.worktree')">
          <KIcon class="k-composer__chip-icon" name="worktree" />
        </span>
        <span class="k-composer__spacer"></span>
        <span v-if="stats" class="k-composer__stats mono">{{ stats }}</span>
        <slot name="actions" />
        <button
          type="submit"
          class="k-composer__send"
          :class="{ 'k-composer__send--due': dictation?.countdown }"
          :aria-label="t('kit.composer.send')"
          :aria-busy="reading > 0 || undefined"
          :disabled="disabled || !canSend || reading > 0"
        >
          <!-- The auto-send countdown: the ring empties until the message goes (decision 3). -->
          <svg
            v-if="dictation?.countdown"
            :key="dictation.countdown.at"
            class="k-composer__send-ring"
            viewBox="0 0 36 36"
            aria-hidden="true"
          >
            <circle cx="18" cy="18" r="16" pathLength="100" :style="{ animationDuration: `${dictation.countdown.ms}ms` }" />
          </svg>
          ↑
        </button>
      </div>

      <input
        ref="fileInput"
        type="file"
        accept="image/png,image/jpeg,image/gif,image/webp"
        multiple
        class="k-composer__file"
        @change="onFilePick"
      />
    </form>

    <!-- The 🎤 mode menu. Under <body>, `position: fixed`, like KChipSelect's: the panel's
         panes scroll and would crop an in-flow menu. -->
    <Teleport to="body">
      <div
        v-if="modeMenuOpen"
        ref="modeMenuEl"
        class="k-composer__mode-menu"
        role="menu"
        :aria-label="t('kit.composer.voiceModes')"
      >
        <button
          v-for="m in VOICE_MODES"
          :key="m"
          type="button"
          class="k-composer__mode-item"
          :class="{ 'k-composer__mode-item--active': m === voiceMode }"
          role="menuitemradio"
          :aria-checked="m === voiceMode"
          @click="pickMode(m)"
        >{{ t(`voice.mode.${m}`) }}</button>
      </div>
    </Teleport>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { DEFAULT_COMMANDS, prependCommand, prependHelper, type ImageInput, type ModelOption, type ThinkingLevel, type Usage } from '@kermanych/core';
import KAttachStrip from './KAttachStrip.vue';
import KChipSelect from './KChipSelect.vue';
import KModelMark from './KModelMark.vue';
import KIcon from './KIcon.vue';
import KHelperPicker from './KHelperPicker.vue';
import KFilePicker from './KFilePicker.vue';
import KTag from './KTag.vue';
import KSpinner from './KSpinner.vue';
import { useImageAttach } from '../../composables/useImageAttach';
import { useFileMention } from '../../composables/useFileMention';
import { EFFORT_OPTIONS } from '../../lib/effort';
import { modelOptions } from '../../lib/models';
import { tokens, usageTokens, usd } from '../../lib/format';
import { placeMenu } from '../../lib/menu';
import type { ComposerDictationState } from '../../composables/useComposerDictation';
import type { VoiceMode } from '../../composables/useVoicePanel';

const { t } = useI18n();

// The ladder's labels are catalog keys (lib/effort); map them through `t` in a computed so the
// chip menu re-reads on a locale change instead of freezing the words at setup.
const effortChoices = computed(() => EFFORT_OPTIONS.map((o) => ({ value: o.value, label: t(o.labelKey) })));

// The composer atom: a mono textarea that grows with content up to a cap, plus a
// v3 controls row — what this session is running as (model, reasoning effort, isolation),
// how full its context is, what it has spent, and the accent send FAB. Attach images via
// paste, drag-drop, or the 📎 file-pick. `modelValue` is owned by the host so the same
// primitive drives both the panel and the «Дослідження» panel. The chips are equally host-owned:
// this component reads the session's facts and reports an effort pick; it never talks to
// the store itself.

const props = withDefaults(
  defineProps<{
    modelValue: string;
    placeholder?: string | undefined;
    disabled?: boolean | undefined;
    model?: string | undefined;
    // The omp catalog for this machine (empty when unreadable): with it the model chip is a
    // picker, without it it degrades to a read-only label.
    models?: readonly ModelOption[] | undefined;
    // omp's reasoning effort for this session, as the api last read it back. Absent means the
    // level is not known yet (a child that has not answered its first state poll), and the chip
    // stays away rather than naming a level the agent may not be running at.
    effort?: ThinkingLevel | undefined;
    // A model / effort pick being saved: the chip spins and is blocked until it settles.
    modelLoading?: boolean | undefined;
    effortLoading?: boolean | undefined;
    worktree?: boolean;
    // How full the model's context window is, in percent, as omp reports it. Read straight
    // from the session rather than derived from `usage`: cached reads and summarisation move
    // the two figures independently.
    context?: number | undefined;
    // What the session has spent, lifetime, as the api counted it. The whole shape rather
    // than a token total: the row prints tokens AND money, and summing them here keeps every
    // caller from re-deriving the same two figures.
    usage?: Usage | undefined;
    // The tree a file mention reads — the session's. Absent: no @ button, and `@` is plain text.
    files?: { kind: 'session' | 'project'; id: string } | null | undefined;
    // The host can start voice with this session: shows the 🎤 button.
    voice?: boolean | undefined;
    // This session's voice conversation is running: the button is lit.
    voiceActive?: boolean | undefined;
    // The host offers Live beside dictation: 🎤 gets the ▾ mode menu (decision 2 of
    // docs/specs/2026-11-14-local-voice-dictation.md). Without it 🎤 only dictates.
    voiceModes?: boolean | undefined;
    // The mode the 🎤 click starts — the one used last.
    voiceMode?: VoiceMode | undefined;
    // Dictation into this composer while it runs (composables/useComposerDictation), else null.
    dictation?: ComposerDictationState | null | undefined;
  }>(),
  {
    disabled: false,
    worktree: false,
    models: () => [],
    modelLoading: false,
    effortLoading: false,
    voice: false,
    voiceActive: false,
    voiceModes: false,
    voiceMode: 'dictation',
    dictation: null,
  },
);

const emit = defineEmits<{
  'update:modelValue': [value: string];
  send: [text: string, images: ImageInput[]];
  effort: [level: ThinkingLevel];
  setModel: [patch: { model: string; provider?: string }];
  // The 🎤 click: the host stops what runs here or starts `voiceMode`.
  voice: [];
  // A pick in the ▾ menu.
  voiceMode: [mode: VoiceMode];
  // ⌥D in the field: toggles dictation whatever the mode (decision 13).
  dictate: [];
}>();

// ── 🎤 ────────────────────────────────────────────────────────────────────────
const VOICE_MODES: readonly VoiceMode[] = ['dictation', 'live'];

const voiceTip = computed(() => {
  if (props.dictation) return t('kit.composer.dictateStop');
  if (props.voiceActive) return t('kit.composer.voiceEnd');
  return props.voiceMode === 'live' ? t('kit.composer.voiceTip') : t('kit.composer.dictateTip');
});

const voiceEl = ref<HTMLElement | null>(null);
const modeMenuEl = ref<HTMLElement | null>(null);
const modeMenuOpen = ref(false);

async function toggleModeMenu(): Promise<void> {
  if (modeMenuOpen.value) return closeModeMenu();
  modeMenuOpen.value = true;
  document.addEventListener('pointerdown', onDocPointerDown);
  document.addEventListener('keydown', onDocKeydown);
  await nextTick();
  const r = voiceEl.value?.getBoundingClientRect();
  const m = modeMenuEl.value;
  if (!r || !m) return;
  // Opens upward: the composer sits at the bottom of its pane.
  const at = placeMenu(r, { width: m.offsetWidth, height: m.offsetHeight }, { width: window.innerWidth, height: window.innerHeight }, 'top');
  m.style.left = `${at.left}px`;
  m.style.top = `${at.top}px`;
  m.style.maxHeight = `${at.maxHeight}px`;
}
function closeModeMenu(): void {
  modeMenuOpen.value = false;
  document.removeEventListener('pointerdown', onDocPointerDown);
  document.removeEventListener('keydown', onDocKeydown);
}
// The menu is teleported: a pointer inside it is not inside the button.
function onDocPointerDown(e: PointerEvent): void {
  const target = e.target as Node;
  if (!voiceEl.value?.contains(target) && !modeMenuEl.value?.contains(target)) closeModeMenu();
}
function onDocKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape') closeModeMenu();
}
function pickMode(mode: VoiceMode): void {
  closeModeMenu();
  emit('voiceMode', mode);
}
onBeforeUnmount(closeModeMenu);

// The dictation line's words, and the countdown's whole seconds. The clock ticks only while a
// countdown runs.
const now = ref(Date.now());
let clock: ReturnType<typeof setInterval> | undefined;
watch(
  () => props.dictation?.countdown?.at,
  (at) => {
    clearInterval(clock);
    clock = undefined;
    now.value = Date.now();
    if (at) clock = setInterval(() => (now.value = Date.now()), 100);
  },
  { immediate: true },
);
onBeforeUnmount(() => clearInterval(clock));
const dictationWords = computed(() => {
  const d = props.dictation;
  if (!d) return '';
  if (d.countdown) {
    const n = Math.max(1, Math.ceil((d.countdown.at - now.value) / 1000));
    return t(d.countdown.answer ? 'kit.composer.dictation.answerIn' : 'kit.composer.dictation.sendIn', { n });
  }
  if (d.phase === 'starting') return t('kit.composer.dictation.starting');
  if (d.phase === 'stopping' || d.recognising) return t('kit.composer.dictation.recognising');
  return t('kit.composer.dictation.listening');
});

const focused = ref(false);

const modelChipOptions = computed(() => modelOptions(props.models));

// The provider rides along so the api's set_model can address the model without a catalogue
// round-trip; props.models is the catalogue the chip was built from.
function onModelPick(id: string): void {
  const provider = props.models?.find((m) => m.id === id)?.provider;
  emit('setModel', provider ? { model: id, provider } : { model: id });
}

// Composer textarea: grows with content up to a cap, then scrolls, so
// Shift+Enter newlines stay visible instead of being clipped by the input row.
const fieldEl = ref<HTMLTextAreaElement | null>(null);
const MAX_COMPOSER_HEIGHT = 160;
function autoGrow(): void {
  const el = fieldEl.value;
  if (!el) return;
  // Empty field: back to the one-line floor without measuring — Chrome counts the rendered
  // placeholder into an empty textarea's scrollHeight, so a wrapping placeholder would hold
  // the cleared field at the placeholder's height (ManagementPage hit exactly that).
  if (props.modelValue === '') {
    el.style.height = '';
    return;
  }
  el.style.height = 'auto';
  el.style.height = `${Math.min(el.scrollHeight, MAX_COMPOSER_HEIGHT)}px`;
}
// The host owns the value, so external resets (e.g. clearing after send) must
// re-run the grow pass to shrink the field back to a single line.
watch(() => props.modelValue, () => void nextTick(autoGrow));

function onInput(e: Event): void {
  emit('update:modelValue', (e.target as HTMLTextAreaElement).value);
  autoGrow();
}

// Хелпери: `/` on an empty draft opens the picker instead of typing the slash, the way `:` opens
// an emoji picker in a messenger. Only on an EMPTY draft — mid-sentence a slash is a path, and
// the token would expand nowhere anyway (`prependHelper` explains why).
const pickerOpen = ref(false);
function closePicker(): void {
  pickerOpen.value = false;
  fieldEl.value?.focus();
}
// A pick from the panel prepends its token. A command (`/compact`) and a helper (`/el10`) both
// land at the front of the draft, but each has its own no-double-prepend guard, so route by
// which list the name belongs to.
const commandNames = new Set(DEFAULT_COMMANDS.map((c) => c.name));
function onHelper(name: string): void {
  const next = commandNames.has(name)
    ? prependCommand(props.modelValue, name)
    : prependHelper(props.modelValue, name);
  emit('update:modelValue', next);
}

// Файли: `@` at a word start (or the @ button) opens the session's tree; the pick lands as an
// `@path` token at the caret (useFileMention).
const mention = useFileMention({
  el: () => fieldEl.value,
  value: () => props.modelValue,
  set: (v) => emit('update:modelValue', v),
  enabled: () => !!props.files && !props.disabled,
});

// Enter sends; Shift+Enter inserts a newline. Enter mid-IME-composition is
// ignored so committing a candidate doesn't fire the message.
function onComposerKeydown(e: KeyboardEvent): void {
  if (props.disabled) return;
  // ⌥D toggles dictation, as in the task popups. `code`, not `key`: on macOS ⌥D types «∂».
  if (props.voice && e.altKey && !e.metaKey && !e.ctrlKey && !e.shiftKey && e.code === 'KeyD') {
    e.preventDefault();
    emit('dictate');
    return;
  }
  if (e.key === '/' && props.modelValue === '') {
    e.preventDefault();
    pickerOpen.value = true;
    return;
  }
  mention.onKeydown(e);
  if (e.defaultPrevented) return;
  if (e.key !== 'Enter' || e.shiftKey || e.isComposing) return;
  e.preventDefault();
  submit();
}

const {
  images: attachImages,
  error: attachError,
  reading,
  onPaste: onImagePaste,
  onDrop: onImageDrop,
  remove: removeImage,
  clear: clearImages,
  addFiles: addImageFiles,
} = useImageAttach();
const fileInput = ref<HTMLInputElement | null>(null);

function onFilePick(e: Event): void {
  const input = e.target as HTMLInputElement;
  if (input.files) void addImageFiles(input.files);
  input.value = '';
}

// A failed send hands its images back (KPanel.restoreDraft): rebuilt as thumbnails from the
// same base64 bytes that went out.
function restoreImages(list: readonly ImageInput[]): void {
  attachImages.value = [
    ...attachImages.value,
    ...list.map((i, n) => ({ ...i, url: `data:${i.mimeType};base64,${i.data}`, name: `image-${n + 1}` })),
  ];
}
// `submit` and `field`: composer dictation (KPanel's dictation host) sends the dictated message
// the same way Enter does and inserts each phrase at the caret.
defineExpose({ restoreImages, submit, field: () => fieldEl.value });

const canSend = computed(() => props.modelValue.trim().length > 0 || attachImages.value.length > 0);

// The session's numbers, one readout at the end of the row:
// `контекст 14% · 6.2M токенів · $5.09`. Every piece is either true or absent, and each is
// dropped independently, so a fresh session prints `контекст 0%` alone and a cache-only one
// prints its tokens without a `· $0.00` nobody can stand behind. No usage at all — never
// counted — prints nothing rather than a `0` claiming a free agent. Tokens are spelled out
// rather than abbreviated to the card strip's `ток` because there is room here.
//
// Sub-half-percent context is still context loaded; `toFixed(0)` would call it 0%. An exact
// 0 is not rounded from anything — the supervisor assigns omp's raw reading or nothing, with
// no `?? 0` anywhere — so it keeps `0%`; flooring that too would be the mirror-image lie,
// hiding a true zero behind a `<`. Do not "tidy" this guard.
const stats = computed(() => {
  const pc = props.context;
  const u = props.usage;
  return [
    pc == null ? '' : t('kit.composer.contextPct', { pc: pc > 0 && pc < 0.5 ? '<1' : pc.toFixed(0) }),
    ...(u ? [t('kit.composer.tokens', { count: tokens(usageTokens(u)) }), usd(u.cost)] : []),
  ]
    .filter(Boolean)
    .join(' · ');
});

function submit(): void {
  if (props.disabled || reading.value > 0) return;
  const text = props.modelValue.trim();
  if (!text && !attachImages.value.length) return;
  emit('send', text, attachImages.value.map((i) => ({ data: i.data, mimeType: i.mimeType })));
  emit('update:modelValue', '');
  clearImages();
  void nextTick(autoGrow);
}
</script>

<style scoped lang="scss">
.k-composer {
  // The Хелпери panel is anchored to this box, above it.
  position: relative;
  display: flex;
  flex-direction: column;
  padding: var(--k-sp-2) var(--k-sp-3) var(--k-sp-3);
  gap: var(--k-sp-2);
}

.k-composer__attach {
  padding-top: var(--k-sp-1);
}

.k-composer__attach-error {
  font-size: var(--k-fs-xs);
  color: var(--k-accent);
}

.k-composer__form {
  display: flex;
  flex-direction: column;
  gap: var(--k-sp-2);
  border: 1px solid var(--k-line-strong);
  border-radius: var(--k-r);
  background: var(--k-bg);
  box-shadow: var(--k-sheen), var(--k-shadow-card);
  padding: var(--k-sp-2) var(--k-sp-3);
  transition: border-color 0.12s, box-shadow 0.12s;
}

// accent border + glow = keyboard focus lives in this composer.
.k-composer--focused .k-composer__form {
  border-color: var(--k-accent);
  box-shadow: var(--k-sheen), var(--k-shadow-card), var(--k-glow-focus);
}

.k-composer--disabled .k-composer__form {
  opacity: 0.6;
}

.k-composer__input {
  display: flex;
  align-items: flex-start;
  gap: var(--k-sp-2);
}

.k-composer__prompt {
  font-family: var(--k-font-mono);
  font-size: var(--k-fs-md);
  line-height: 1.5;
  color: var(--k-muted);
  transition: color 0.12s;
}
.k-composer--focused .k-composer__prompt {
  color: var(--k-accent);
}

.k-composer__field {
  flex: 1 1 auto;
  font-size: var(--k-fs-sm);
  color: var(--k-text);
  background: transparent;
  border: none;
  outline: none;
  padding: 0;
  line-height: 1.5;
  resize: none;
  max-height: 160px;
  overflow-y: auto;

  &::placeholder {
    color: var(--k-muted);
  }
}

.k-composer__controls {
  display: flex;
  align-items: center;
  gap: var(--k-sp-2);
}

.k-composer__spacer {
  flex: 1 1 auto;
}

.k-composer__attach-btn {
  flex: none;
  padding: 0 2px;
  background: transparent;
  border: none;
  color: var(--k-muted);
  font-size: var(--k-fs-md);
  line-height: 1;
  cursor: pointer;
  transition: color 0.12s;

  &:hover:not(:disabled) {
    color: var(--k-text);
  }
  &:disabled {
    cursor: default;
    opacity: 0.5;
  }
}
.k-composer__attach-btn--on,
.k-composer__attach-btn--on:hover:not(:disabled) {
  color: var(--k-accent);
}
.k-composer__voice-icon {
  --k-icon-size: var(--k-icon-md);
}

// Session facts — flat, borderless chips: these are readings, so they get no hover, no caret
// and no frame. The effort KChipSelect beside them repeats this metric (5/8 padding, ui font
// at --k-fs-sm) so the row reads as one set rather than a control wedged between two labels.
.k-composer__chip {
  flex: none;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 5px 8px;
  font-family: var(--k-font-ui);
  font-size: var(--k-fs-sm);
  line-height: 1;
  color: var(--k-muted);
  white-space: nowrap;
}

// The isolation mark: a drawn KIcon, so its size is a box and not a font-size. `md` against
// the chip's 12px mono text — a stroked line mark at the type's own size reads lighter than
// the type, which is exactly how the old `⑂` disappeared. It steps down from KIcon's `lg`
// default because the mark is inline in a dense chip row here, not standing alone in a rail.
.k-composer__chip-icon {
  --k-icon-size: var(--k-icon-md);
}

// The model is the one fact worth a colour: it is what the operator changes screens to check.
// The vendor mark inherits it through `fill: currentColor`. No `--k-mark-size` here: KModelMark
// already defaults to `sm`, one step under the stroked mark beside it, which is the gap a
// filled logo needs to stop out-shouting it. Overriding would only restate the default.
.k-composer__chip-mark {
  color: var(--k-accent);
}

// Context / tokens / spend — the session's numbers, quietest type in the row: they are
// watched by glance, not read, so they sit a step below the chips they follow.
.k-composer__stats {
  font-size: var(--k-fs-sm);
  color: var(--k-faint);
  white-space: nowrap;
}

.k-composer__file {
  display: none;
}

// send FAB — the composer's single accent moment: a filled vermilion circle.
.k-composer__send {
  flex: none;
  width: 32px;
  height: 32px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: var(--k-accent);
  color: var(--k-on-accent);
  border: none;
  border-radius: var(--k-r-pill);
  font-size: var(--k-fs-md);
  line-height: 1;
  cursor: pointer;
  transition: background 0.12s;

  &:hover:not(:disabled) {
    background: var(--k-accent-hover);
  }
  &:disabled {
    opacity: 0.4;
    cursor: default;
  }
}

// The ring runs inside the FAB, so the button is its containing block.
.k-composer__send--due {
  position: relative;
}
// The auto-send countdown: a ring around the arrow that empties as the send nears.
.k-composer__send-ring {
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
    animation-name: k-composer-ring;
    animation-timing-function: linear;
    animation-fill-mode: forwards;
  }
}
@keyframes k-composer-ring {
  to {
    stroke-dashoffset: 100;
  }
}

// 🎤 and its ▾: one control in two halves, like a split button shrunk to the row's icons.
.k-composer__voice {
  flex: none;
  display: inline-flex;
  align-items: center;
}
.k-composer__voice-caret {
  padding: 0 2px 0 0;
}
.k-composer__caret {
  display: block;
  width: 7px;
  height: 4px;
  background: currentColor;
  clip-path: polygon(0 0, 100% 0, 50% 100%);
}

// The dictation line: quiet, one row, under the text it fills.
.k-composer__dictation {
  display: flex;
  align-items: center;
  gap: var(--k-sp-2);
  min-width: 0;
  font-size: var(--k-fs-xs);
  color: var(--k-muted);
}
.k-composer__level {
  flex: none;
  width: 48px;
  height: 4px;
  border-radius: 2px;
  background: var(--k-line);
  overflow: hidden;
}
.k-composer__level-fill {
  display: block;
  height: 100%;
  background: var(--k-accent);
  transform-origin: left center;
  transition: transform 120ms linear;
}
.k-composer__dictation-state {
  white-space: nowrap;
}
.k-composer__dictation-state--due {
  color: var(--k-accent);
}
.k-composer__dictation-hint {
  color: var(--k-faint);
  white-space: nowrap;
}

// The 🎤 mode menu — KChipSelect's floating surface, z-index band included.
.k-composer__mode-menu {
  position: fixed;
  top: 0;
  left: 0;
  z-index: 6500;
  box-sizing: border-box;
  max-width: min(calc(100vw - 16px), 360px);
  display: flex;
  flex-direction: column;
  padding: var(--k-sp-1);
  background: var(--k-grad-raise), var(--k-surface);
  border: 1px solid var(--k-line-strong);
  border-radius: var(--k-r);
  box-shadow: var(--k-sheen), var(--k-shadow-pop);
}
.k-composer__mode-item {
  padding: 6px 8px;
  background: transparent;
  border: none;
  border-radius: var(--k-r-sm);
  color: var(--k-muted);
  font-family: var(--k-font-ui);
  font-size: var(--k-fs-sm);
  line-height: 1.2;
  text-align: left;
  white-space: nowrap;
  cursor: pointer;
  transition: background 0.12s, color 0.12s;

  &:hover {
    background: var(--k-surface2);
    color: var(--k-text);
  }
  &:focus-visible {
    outline: 1px solid var(--k-accent);
    outline-offset: -1px;
  }
}
.k-composer__mode-item--active {
  color: var(--k-text);
}

@media (prefers-reduced-motion: reduce) {
  .k-composer__level-fill {
    transition: none;
  }
}
</style>
