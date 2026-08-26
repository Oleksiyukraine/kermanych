<template>
  <div
    class="k-composer"
    :class="{ 'k-composer--focused': focused, 'k-composer--disabled': disabled }"
  >
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
          :placeholder="placeholder"
          :disabled="disabled"
          rows="1"
          @focus="focused = true"
          @blur="focused = false"
          @paste="onImagePaste"
          @input="onInput"
          @keydown="onComposerKeydown"
        ></textarea>
      </div>

      <!-- v3 controls row: attach + machine-text chips + token count on the left,
           session actions + the accent send FAB on the right. -->
      <div class="k-composer__controls">
        <button
          type="button"
          class="k-composer__attach-btn"
          v-tip="'Додати зображення'"
          aria-label="Додати зображення"
          :disabled="disabled"
          @click="fileInput?.click()"
        >📎</button>
        <KTag v-if="model" class="k-composer__chip">{{ model }}</KTag>
        <KTag v-if="worktree" class="k-composer__chip">⎇ worktree</KTag>
        <span v-if="tokenCount != null" class="k-composer__tokens mono">{{ tokenLabel }}</span>
        <span class="k-composer__spacer"></span>
        <slot name="actions" />
        <button
          type="submit"
          class="k-composer__send"
          aria-label="Надіслати"
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
import type { ImageInput } from '@kermanych/core';
import KAttachStrip from './KAttachStrip.vue';
import KTag from './KTag.vue';
import { useImageAttach } from '../../composables/useImageAttach';
import { tokens } from '../../lib/format';

// The composer atom: a mono textarea that grows with content up to a cap, plus a
// v3 controls row (model + worktree chips, token count, accent send FAB). Attach
// images via paste, drag-drop, or the 📎 file-pick. `modelValue` is owned by the
// host so the same primitive drives both the panel and future Агенти/Чат screens.
const props = withDefaults(
  defineProps<{
    modelValue: string;
    placeholder?: string | undefined;
    disabled?: boolean;
    model?: string | undefined;
    worktree?: boolean;
    tokenCount?: number | undefined;
  }>(),
  { placeholder: 'напиши наступний крок…', disabled: false, worktree: false },
);

const emit = defineEmits<{
  'update:modelValue': [value: string];
  send: [text: string, images: ImageInput[]];
}>();

const focused = ref(false);

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

// Enter sends; Shift+Enter inserts a newline. Enter mid-IME-composition is
// ignored so committing a candidate doesn't fire the message.
function onComposerKeydown(e: KeyboardEvent): void {
  if (props.disabled || e.key !== 'Enter' || e.shiftKey || e.isComposing) return;
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

// Compact token readout: 12_300 → "12.3k ток", small counts stay exact.
const tokenLabel = computed(() => `${tokens(props.tokenCount ?? 0)} ток`);

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

.k-composer__tokens {
  font-size: var(--k-fs-xs);
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
