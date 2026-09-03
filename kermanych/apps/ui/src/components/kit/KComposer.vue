<template>
  <div
    class="k-composer"
    :class="{ 'k-composer--focused': focused, 'k-composer--disabled': disabled }"
  >
    <!-- Anchored to the composer's own box, not to the form: the panel has to sit above the
         whole control, attachment strip included. It prevents Enter itself, so mounting it
         inside a form is safe too — ManagementPage does exactly that. -->
    <KHelperPicker :open="pickerOpen" @select="onHelper" @close="closePicker" />
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

      <!-- v3 controls row: attach + the session's own facts (model, reasoning effort,
           isolation) on the left, spend + session actions + the accent send FAB on the right.
           The model and worktree chips are readings, not controls — both are fixed when omp is
           spawned — so only effort carries a caret. -->
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
          type="button"
          class="k-composer__attach-btn"
          v-tip="t('kit.composer.addImage')"
          :aria-label="t('kit.composer.addImage')"
          :disabled="disabled"
          @click="fileInput?.click()"
        >📎</button>
        <KChipSelect
          v-if="model && modelChipOptions.length"
          :model-value="model"
          :options="modelChipOptions"
          :title="t('kit.composer.model')"
          :disabled="disabled"
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
          @update:model-value="(level) => emit('effort', level)"
        />
        <span v-if="worktree" class="k-composer__chip" v-tip="t('kit.composer.worktree')">
          <span class="k-composer__chip-icon" aria-hidden="true">⑂</span>
          <span class="mono">worktree</span>
        </span>
        <span class="k-composer__spacer"></span>
        <span v-if="stats" class="k-composer__stats mono">{{ stats }}</span>
        <slot name="actions" />
        <button
          type="submit"
          class="k-composer__send"
          :aria-label="t('kit.composer.send')"
          :disabled="disabled || !canSend"
        >↑</button>
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
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { prependHelper, type ImageInput, type ModelOption, type ThinkingLevel, type Usage } from '@kermanych/core';
import KAttachStrip from './KAttachStrip.vue';
import KChipSelect from './KChipSelect.vue';
import KModelMark from './KModelMark.vue';
import KHelperPicker from './KHelperPicker.vue';
import KTag from './KTag.vue';
import { useImageAttach } from '../../composables/useImageAttach';
import { EFFORT_OPTIONS } from '../../lib/effort';
import { modelOptions } from '../../lib/models';
import { tokens, usageTokens, usd } from '../../lib/format';

const { t } = useI18n();

// The ladder's labels are catalog keys (lib/effort); map them through `t` in a computed so the
// chip menu re-reads on a locale change instead of freezing the words at setup.
const effortChoices = computed(() => EFFORT_OPTIONS.map((o) => ({ value: o.value, label: t(o.labelKey) })));

// The composer atom: a mono textarea that grows with content up to a cap, plus a
// v3 controls row — what this session is running as (model, reasoning effort, isolation),
// how full its context is, what it has spent, and the accent send FAB. Attach images via
// paste, drag-drop, or the 📎 file-pick. `modelValue` is owned by the host so the same
// primitive drives both the panel and the Чат screen. The chips are equally host-owned:
// this component reads the session's facts and reports an effort pick; it never talks to
// the store itself.

const props = withDefaults(
  defineProps<{
    modelValue: string;
    placeholder?: string | undefined;
    disabled?: boolean;
    model?: string | undefined;
    // The omp catalog for this machine (empty when unreadable): with it the model chip is a
    // picker, without it it degrades to a read-only label.
    models?: readonly ModelOption[] | undefined;
    // omp's reasoning effort for this session, as the api last read it back. Absent means the
    // level is not known yet (a child that has not answered its first state poll), and the chip
    // stays away rather than naming a level the agent may not be running at.
    effort?: ThinkingLevel | undefined;
    worktree?: boolean;
    // How full the model's context window is, in percent, as omp reports it. Read straight
    // from the session rather than derived from `usage`: cached reads and summarisation move
    // the two figures independently.
    context?: number | undefined;
    // What the session has spent, lifetime, as the api counted it. The whole shape rather
    // than a token total: the row prints tokens AND money, and summing them here keeps every
    // caller from re-deriving the same two figures.
    usage?: Usage | undefined;
  }>(),
  { disabled: false, worktree: false, models: () => [] },
);

const emit = defineEmits<{
  'update:modelValue': [value: string];
  send: [text: string, images: ImageInput[]];
  effort: [level: ThinkingLevel];
  setModel: [patch: { model: string; provider?: string }];
}>();

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
function onHelper(name: string): void {
  emit('update:modelValue', prependHelper(props.modelValue, name));
}

// Enter sends; Shift+Enter inserts a newline. Enter mid-IME-composition is
// ignored so committing a candidate doesn't fire the message.
function onComposerKeydown(e: KeyboardEvent): void {
  if (props.disabled) return;
  if (e.key === '/' && props.modelValue === '') {
    e.preventDefault();
    pickerOpen.value = true;
    return;
  }
  if (e.key !== 'Enter' || e.shiftKey || e.isComposing) return;
  e.preventDefault();
  submit();
}

const {
  images: attachImages,
  error: attachError,
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
  if (props.disabled) return;
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
  padding: var(--k-sp-2) var(--k-sp-3);
  transition: border-color 0.12s;
}

// red border = keyboard focus lives in this composer.
.k-composer--focused .k-composer__form {
  border-color: var(--k-accent);
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

.k-composer__chip-icon {
  font-size: var(--k-fs-base);
  line-height: 1;
}

// The model is the one fact worth a colour: it is what the operator changes screens to check.
// The vendor mark inherits it through `fill: currentColor`, and sits a hair below the cap
// height of the id beside it — a filled logo matched to the type size reads heavier than it.
.k-composer__chip-mark {
  color: var(--k-accent);
  --k-mark-size: 12px;
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
</style>
