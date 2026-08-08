<template>
  <section class="k-panel" :class="{ 'k-panel--active': isActive }">
    <!-- floor 1 — header (34px) -->
    <header class="k-panel__header">
      <div class="k-panel__id">
        <KStatusDot :status="session.status" />
        <span class="k-panel__harness mono">omp · {{ groupName }}</span>
        <KTag>⑂ {{ session.branch }}</KTag>
      </div>
      <div class="k-panel__controls">
        <span class="k-panel__status mono">{{ statusLabel }}</span>
        <button
          v-if="running"
          class="k-panel__icon"
          type="button"
          title="Зупинити"
          @click="emit('stop')"
        >■</button>
        <span class="k-panel__icon k-panel__icon--chrome" aria-hidden="true">⊞</span>
        <button
          class="k-panel__icon"
          type="button"
          title="Видалити"
          @click="emit('delete')"
        >✕</button>
      </div>
    </header>

    <!-- floor 2 — scrollable log -->
    <div class="k-panel__log">
      <slot />

      <!-- decision block — the ONE accent block-strip in the log -->
      <div v-if="req" class="k-panel__decision">
        <div class="k-panel__decision-head mono">ПОТРІБНЕ РІШЕННЯ</div>
        <div v-if="req.title" class="k-panel__decision-title">{{ req.title }}</div>
        <div v-if="req.message" class="k-panel__decision-msg">{{ req.message }}</div>

        <!-- confirm -->
        <div v-if="req.method === 'confirm'" class="k-panel__decision-row">
          <KBtn variant="primary" @click="answerConfirm(true)">Так</KBtn>
          <KBtn variant="secondary" @click="answerConfirm(false)">Ні</KBtn>
        </div>

        <!-- select -->
        <div v-else-if="req.method === 'select'" class="k-panel__decision-options">
          <button
            v-for="(opt, i) in req.options ?? []"
            :key="i"
            class="k-panel__option mono"
            type="button"
            @click="answerValue(opt)"
          >{{ i + 1 }} — {{ opt }}</button>
        </div>

        <!-- input -->
        <form
          v-else-if="req.method === 'input'"
          class="k-panel__decision-form"
          @submit.prevent="answerValue(decisionText)"
        >
          <input
            v-model="decisionText"
            class="k-panel__decision-input mono"
            :placeholder="req.placeholder ?? ''"
          />
          <KBtn variant="primary" type="submit">Надіслати</KBtn>
        </form>

        <!-- editor -->
        <form
          v-else-if="req.method === 'editor'"
          class="k-panel__decision-form k-panel__decision-form--editor"
          @submit.prevent="answerValue(decisionText)"
        >
          <textarea
            v-model="decisionText"
            class="k-panel__decision-editor mono"
            rows="4"
            :placeholder="req.placeholder ?? ''"
          />
          <KBtn variant="primary" type="submit">Надіслати</KBtn>
        </form>

        <div class="k-panel__decision-cancel">
          <KBtn variant="ghost" @click="answerCancel">Скасувати</KBtn>
        </div>
      </div>

      <!-- error banner — the omp child exited before finishing; surface the reason -->
      <div v-if="session.status === 'error'" class="k-panel__error" role="alert">
        <div class="k-panel__error-head mono">ПОМИЛКА</div>
        <div class="k-panel__error-msg">{{ session.error || 'Сесію завершено з помилкою.' }}</div>
      </div>
    </div>

    <!-- floor 3 — composer: attachment strip + input row (paste / drop / 📎) -->
    <div class="k-panel__composer">
      <KAttachStrip
        v-if="attachImages.length"
        class="k-panel__attach"
        :images="attachImages"
        @remove="removeImage"
      />
      <p v-if="attachError" class="k-panel__attach-error mono">{{ attachError }}</p>
      <form
        class="k-panel__input"
        :class="{ 'k-panel__input--focused': focused }"
        @submit.prevent="submit"
        @drop.prevent="onImageDrop"
        @dragover.prevent
      >
        <button
          type="button"
          class="k-panel__attach-btn"
          title="Додати зображення"
          @click="fileInput?.click()"
        >📎</button>
        <span class="k-panel__prompt" aria-hidden="true">❯</span>
        <input
          v-model="draft"
          class="k-panel__field mono"
          :placeholder="placeholder"
          @focus="focused = true"
          @blur="focused = false"
          @paste="onImagePaste"
        />
        <input
          ref="fileInput"
          type="file"
          accept="image/png,image/jpeg,image/gif,image/webp"
          multiple
          class="k-panel__file"
          @change="onFilePick"
        />
      </form>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';
import type { Group, Session, RpcExtensionUIResponse, ImageInput } from '@kermanych/core';
import KStatusDot from './KStatusDot.vue';
import KTag from './KTag.vue';
import KBtn from './KBtn.vue';
import KAttachStrip from './KAttachStrip.vue';
import { useImageAttach } from '../../composables/useImageAttach';

// The application atom (design-system section 05): three floors — header, log,
// input — stacked with no gaps (panels dock via 2px rules). The active panel
// (a running agent) takes surface2 and a 2px accent strip on its top edge.
const props = withDefaults(
  defineProps<{
    session: Session;
    group?: Group;
    placeholder?: string;
  }>(),
  { placeholder: 'напиши наступний крок…' },
);

const emit = defineEmits<{
  stop: [];
  delete: [];
  send: [text: string, images: ImageInput[]];
  answer: [res: RpcExtensionUIResponse];
}>();

const draft = ref('');
const focused = ref(false);
const decisionText = ref('');

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

const req = computed(() => props.session.pendingUiRequest);
const groupName = computed(() => props.group?.name ?? props.session.name);

const running = computed(
  () => props.session.status === 'thinking' || props.session.status === 'tool',
);
// active — a running agent lights the top strip; matches KStatusDot's running kind.
const isActive = computed(() => running.value);

const statusLabel = computed(() => {
  switch (props.session.status) {
    case 'thinking':
      return props.session.currentTool ?? 'працює';
    case 'tool':
      return props.session.currentTool ?? 'інструмент';
    case 'waiting_input':
      return 'чекає';
    case 'done':
      return 'готово';
    case 'error':
      return 'помилка';
    case 'queued':
      return 'у черзі';
    case 'stopped':
      return 'зупинено';
    default:
      return props.session.status;
  }
});

function submit() {
  const text = draft.value.trim();
  if (!text && !attachImages.value.length) return;
  emit('send', text, attachImages.value.map((i) => ({ data: i.data, mimeType: i.mimeType })));
  draft.value = '';
  clearImages();
}

function answerConfirm(confirmed: boolean) {
  if (!req.value) return;
  emit('answer', { type: 'extension_ui_response', id: req.value.id, confirmed });
}

function answerValue(value: string) {
  if (!req.value) return;
  emit('answer', { type: 'extension_ui_response', id: req.value.id, value });
  decisionText.value = '';
}

function answerCancel() {
  if (!req.value) return;
  emit('answer', { type: 'extension_ui_response', id: req.value.id, cancelled: true });
}
</script>

<style scoped lang="scss">
.k-panel {
  display: flex;
  flex-direction: column;
  background: var(--k-surface);
  border: 1px solid var(--k-line-strong);
  min-height: 320px;
}

// active — surface2 fill + 2px accent strip on the top edge.
.k-panel--active {
  background: var(--k-surface2);

  .k-panel__header {
    box-shadow: inset 0 2px 0 0 var(--k-accent);
    background: var(--k-surface2);
  }
}

// floor 1 — header
.k-panel__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  height: 34px;
  padding: 0 6px 0 12px;
  background: var(--k-surface);
  border-bottom: 2px solid var(--k-line-strong);
  flex: none;
}

.k-panel__id {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}

.k-panel__harness {
  font-size: 12.5px;
  font-weight: 700;
  color: var(--k-text);
  white-space: nowrap;
}

.k-panel__controls {
  display: flex;
  align-items: center;
  gap: 4px;
}

.k-panel__status {
  font-size: 11px;
  color: var(--k-muted);
  margin-right: 6px;
  white-space: nowrap;
}

.k-panel__icon {
  width: 24px;
  height: 24px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: none;
  background: transparent;
  color: var(--k-muted);
  font-size: 13px;
  cursor: pointer;
  border-radius: 0;
  transition: color 0.12s;

  &:hover {
    color: var(--k-text);
  }

  &:focus-visible {
    outline: 1px solid var(--k-accent);
    outline-offset: -1px;
  }
}

.k-panel__icon--chrome {
  cursor: default;

  &:hover {
    color: var(--k-muted);
  }
}

// floor 2 — log
.k-panel__log {
  flex: 1 1 auto;
  overflow-y: auto;
  padding: 14px 14px 16px;
}

// error — the omp child exited before finishing; full accent border reads as failure.
.k-panel__error {
  margin-top: 14px;
  padding: 12px 14px 14px;
  background: var(--k-surface);
  border: 1px solid var(--k-accent);
  border-left: 2px solid var(--k-accent);
}
.k-panel__error-head {
  font-size: 11px;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: var(--k-accent);
  margin-bottom: 8px;
}
.k-panel__error-msg {
  font-family: var(--k-font-mono);
  font-size: 12px;
  line-height: 1.55;
  color: var(--k-text);
  white-space: pre-wrap;
  word-break: break-word;
}

// decision — accent left strip, the only accent block in the log.
.k-panel__decision {
  margin-top: 14px;
  padding: 12px 14px 14px;
  background: var(--k-surface);
  border: 1px solid var(--k-line-strong);
  border-left: 2px solid var(--k-accent);
}

.k-panel__decision-head {
  font-size: 11px;
  font-weight: 400;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: var(--k-accent);
  margin-bottom: 10px;
}

.k-panel__decision-title {
  font-family: var(--k-font-ui);
  font-size: 14px;
  color: var(--k-text);
  margin-bottom: 4px;
}

.k-panel__decision-msg {
  font-family: var(--k-font-ui);
  font-size: 13px;
  line-height: 1.6;
  color: var(--k-muted);
  margin-bottom: 12px;
}

.k-panel__decision-row {
  display: flex;
  gap: 10px;
}

.k-panel__decision-options {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.k-panel__option {
  display: flex;
  align-items: center;
  text-align: left;
  font-size: 12px;
  color: var(--k-text);
  background: transparent;
  border: 1px solid var(--k-line-strong);
  padding: 8px 12px;
  cursor: pointer;
  border-radius: 0;
  transition: border-color 0.12s, background 0.12s;

  &:hover {
    border-color: var(--k-text);
    background: var(--k-surface2);
  }

  &:focus-visible {
    outline: 1px solid var(--k-accent);
    outline-offset: 1px;
  }
}

.k-panel__decision-form {
  display: flex;
  gap: 10px;
  align-items: stretch;

  &--editor {
    flex-direction: column;
    align-items: flex-start;
  }
}

.k-panel__decision-input,
.k-panel__decision-editor {
  flex: 1 1 auto;
  font-size: 12.5px;
  color: var(--k-text);
  background: var(--k-bg);
  border: 1px solid var(--k-line-strong);
  padding: 8px 11px;
  border-radius: 0;
  outline: none;

  &::placeholder {
    color: var(--k-muted);
  }

  &:focus {
    border-color: var(--k-accent);
  }
}

.k-panel__decision-editor {
  width: 100%;
  resize: vertical;
  line-height: 1.5;
}

.k-panel__decision-cancel {
  margin-top: 10px;
}

// floor 3 — input
.k-panel__input {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 0 14px;
  height: 44px;
  flex: none;
}

.k-panel__composer {
  border-top: 2px solid var(--k-line-strong);
}

.k-panel__attach {
  padding: 10px 12px 0;
}

.k-panel__attach-error {
  margin: 6px 12px 0;
  font-size: 11px;
  color: var(--k-accent);
}

.k-panel__attach-btn {
  flex: none;
  padding: 0 2px;
  background: transparent;
  border: none;
  color: var(--k-muted);
  font-size: 15px;
  line-height: 1;
  cursor: pointer;

  &:hover {
    color: var(--k-text);
  }
}

.k-panel__file {
  display: none;
}

.k-panel__prompt {
  font-family: var(--k-font-mono);
  font-size: 14px;
  color: var(--k-muted);
  transition: color 0.12s;
}

// red prompt = keyboard focus lives in this panel.
.k-panel__input--focused .k-panel__prompt {
  color: var(--k-accent);
}

.k-panel__field {
  flex: 1 1 auto;
  font-size: 12.5px;
  color: var(--k-text);
  background: transparent;
  border: none;
  outline: none;
  padding: 0;

  &::placeholder {
    color: var(--k-muted);
  }
}
</style>
