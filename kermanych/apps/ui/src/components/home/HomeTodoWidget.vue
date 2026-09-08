<template>
  <div class="todow">
    <!-- The format bar. `pointerdown.prevent` (and the mousedown fallback) keeps the browser
         from moving focus here, so the selection the command acts on stays in the row being
         edited — the classic contenteditable-toolbar contract. -->
    <div
      class="todow__bar"
      role="toolbar"
      :aria-label="t('management.home.todo.toolbar')"
      @pointerdown.prevent
      @mousedown.prevent
    >
      <KIconButton class="todow__tool" :title="t('management.home.todo.bold')" @click="format('bold')">
        <svg class="todow__icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M14 12a4 4 0 0 0 0-8H6v8" /><path d="M15 20a4 4 0 0 0 0-8H6v8" />
        </svg>
      </KIconButton>
      <KIconButton class="todow__tool" :title="t('management.home.todo.italic')" @click="format('italic')">
        <svg class="todow__icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <line x1="19" x2="10" y1="4" y2="4" /><line x1="14" x2="5" y1="20" y2="20" /><line x1="15" x2="9" y1="4" y2="20" />
        </svg>
      </KIconButton>
      <KIconButton class="todow__tool" :title="t('management.home.todo.underline')" @click="format('underline')">
        <svg class="todow__icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M6 4v6a6 6 0 0 0 12 0V4" /><line x1="4" x2="20" y1="20" y2="20" />
        </svg>
      </KIconButton>
      <span class="todow__bar-rule" aria-hidden="true"></span>
      <KIconButton
        class="todow__tool"
        :title="t('management.home.todo.checklist')"
        :active="activeKind === 'check'"
        @click="setKind('check')"
      >
        <svg class="todow__icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="m3 17 2 2 4-4" /><path d="m3 7 2 2 4-4" /><path d="M13 6h8" /><path d="M13 12h8" /><path d="M13 18h8" />
        </svg>
      </KIconButton>
      <KIconButton
        class="todow__tool"
        :title="t('management.home.todo.numbered')"
        :active="activeKind === 'number'"
        @click="setKind('number')"
      >
        <svg class="todow__icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M10 12h11" /><path d="M10 18h11" /><path d="M10 6h11" /><path d="M4 10h2" /><path d="M4 6h1v4" /><path d="M6 18H4c0-1 2-2 2-3s-1-1.5-2-1" />
        </svg>
      </KIconButton>
    </div>

    <ol v-if="items.length" class="todow__list">
      <li
        v-for="(item, i) in items"
        :key="item.id"
        class="todow__item"
        :class="{ 'todow__item--done': item.done }"
      >
        <button
          v-if="item.kind === 'check'"
          class="todow__box"
          type="button"
          role="checkbox"
          :aria-checked="item.done"
          :aria-label="t('management.home.todo.toggle')"
          @click="toggleDone(item)"
        ></button>
        <span v-else class="todow__num mono" aria-hidden="true">{{ numberOf(items, i) }}.</span>
        <p
          :ref="(el) => bindEditor(item, el)"
          class="todow__text"
          contenteditable="true"
          :data-placeholder="t('management.home.todo.placeholder')"
          @focus="activeId = item.id"
          @input="onInput(item, $event)"
          @keydown="onKeydown(item, i, $event)"
          @blur="onBlur(item, $event)"
        ></p>
        <button
          class="todow__remove"
          type="button"
          v-tip="t('management.home.todo.remove')"
          :aria-label="t('management.home.todo.remove')"
          @click="removeAt(i)"
        >✕</button>
      </li>
    </ol>
    <p v-else class="todow__empty mono">{{ t('management.home.todo.empty') }}</p>

    <button class="todow__add mono" type="button" @click="addItem()">
      {{ t('management.home.todo.add') }}
    </button>
  </div>
</template>

<script setup lang="ts">
// A personal scratch list on the workspace overview: rows of inline rich text
// (bold / italic / underline), each marked either with a checkbox or with its position in a
// numbered run. The list itself lives in stores/home-todo.ts — the management chat's
// `todo.create` / `todo.update` / `todo.delete` executor writes the same reactive copy, so a
// row the assistant filed or changed is on this tile the moment its notice prints. This component owns only the contenteditable
// DOM, which Vue must NOT re-render — every row's innerHTML is set once when its element
// appears (bindEditor) and then belongs to the browser, because a reactive re-write would
// reset the caret on every keystroke. `item.html` mirrors the DOM (raw on input, sanitized
// on blur) and is what gets persisted; writeTodo sanitizes again, so nothing unsanitized
// ever survives a reload.
import { computed, nextTick, onMounted, onUnmounted, watch, ref, type ComponentPublicInstance } from 'vue';
import { useI18n } from 'vue-i18n';
import KIconButton from 'components/kit/KIconButton.vue';
import { useHomeTodo } from 'stores/home-todo';
import { newTodoItem, numberOf, sanitizeInline, type TodoItem, type TodoKind } from '../../lib/home-todo';

const props = defineProps<{ workspaceId: string }>();

const { t } = useI18n();
const store = useHomeTodo();

// The store's reactive copy for THIS workspace — chat-appended rows show up through it.
// Loaded by the immediate workspace watch below, so this getter only reads.
const items = computed<TodoItem[]>(() => store.byWorkspace[props.workspaceId] ?? []);
// The row the toolbar acts on: the last one focused. Kept as an id, not an index, so a
// reorder by splice cannot point it at a different row.
const activeId = ref<string | null>(null);
// What a fresh row is when nothing is focused yet — flipped by the kind buttons.
const defaultKind = ref<TodoKind>('check');

const activeKind = computed<TodoKind>(
  () => items.value.find((it) => it.id === activeId.value)?.kind ?? defaultKind.value,
);

// The OLD workspace is flushed under its own key — flushing after the prop moved would file
// this list under the workspace being switched TO.
watch(
  () => props.workspaceId,
  (id, old) => {
    if (old) flush(old);
    activeId.value = null;
    store.listFor(id);
  },
  { immediate: true },
);

// ── persistence ───────────────────────────────────────────────────────────────
// Debounced: typing mutates `item.html` on every keystroke, and localStorage does not need
// each one. The unmount flush is what makes navigating away lossless.
let timer: ReturnType<typeof setTimeout> | undefined;
watch(
  items,
  () => {
    clearTimeout(timer);
    const id = props.workspaceId;
    timer = setTimeout(() => flush(id), 500);
  },
  { deep: true },
);

function flush(workspaceId = props.workspaceId): void {
  clearTimeout(timer);
  timer = undefined;
  store.persist(workspaceId);
}

// ── editors ───────────────────────────────────────────────────────────────────
// Row id → its contenteditable element. Hydrated exactly once per element: the `ready` flag
// on the dataset marks an innerHTML Vue must never touch again.
const editors = new Map<string, HTMLElement>();

function bindEditor(item: TodoItem, el: Element | ComponentPublicInstance | null): void {
  if (!(el instanceof HTMLElement)) {
    editors.delete(item.id);
    return;
  }
  editors.set(item.id, el);
  if (el.dataset.ready !== '1') {
    el.innerHTML = item.html;
    el.dataset.ready = '1';
  }
}

// ── editing ───────────────────────────────────────────────────────────────────
function format(cmd: 'bold' | 'italic' | 'underline'): void {
  // Acts on the live selection, which the toolbar's pointerdown.prevent left inside a row.
  document.execCommand(cmd);
}

function setKind(kind: TodoKind): void {
  defaultKind.value = kind;
  const item = items.value.find((it) => it.id === activeId.value);
  if (item) {
    item.kind = kind;
    if (kind === 'number') item.done = false;
  } else if (!items.value.length) {
    addItem(kind);
  }
}

function toggleDone(item: TodoItem): void {
  item.done = !item.done;
}

function addItem(kind?: TodoKind, index = items.value.length): void {
  const item = newTodoItem(kind ?? activeKind.value);
  items.value.splice(index, 0, item);
  void nextTick(() => editors.get(item.id)?.focus());
}

function removeAt(i: number): void {
  const removed = items.value.splice(i, 1)[0];
  if (removed) editors.delete(removed.id);
  const neighbour = items.value[Math.min(i, items.value.length - 1)];
  if (neighbour) void nextTick(() => editors.get(neighbour.id)?.focus());
}

function onInput(item: TodoItem, ev: Event): void {
  item.html = (ev.target as HTMLElement).innerHTML;
}

function onKeydown(item: TodoItem, i: number, ev: KeyboardEvent): void {
  const el = ev.target as HTMLElement;
  if (ev.key === 'Enter' && !ev.shiftKey) {
    // A row is one line of the list — Enter continues the list, never grows the row.
    ev.preventDefault();
    addItem(item.kind, i + 1);
    return;
  }
  if (ev.key === 'Backspace' && el.textContent === '') {
    ev.preventDefault();
    removeAt(i);
    return;
  }
  if ((ev.metaKey || ev.ctrlKey) && !ev.altKey) {
    const key = ev.key.toLowerCase();
    if (key === 'b' || key === 'i' || key === 'u') {
      ev.preventDefault();
      format(key === 'b' ? 'bold' : key === 'i' ? 'italic' : 'underline');
    }
  }
}

function onBlur(item: TodoItem, ev: Event): void {
  // Normalize on the way out of a row: whatever contenteditable produced collapses to the
  // allowed inline tags, and the DOM is rewritten to match — safe now, the caret is gone.
  const el = ev.target as HTMLElement;
  const clean = sanitizeInline(el.innerHTML);
  if (clean !== el.innerHTML) el.innerHTML = clean;
  item.html = clean;
}

onMounted(() => {
  // Tags, not styled spans: sanitizeInline keeps <b>/<i>/<u> and drops style attributes, so
  // a command that emitted `<span style=…>` would look formatted only until the next blur.
  document.execCommand('styleWithCSS', false, 'false');
});

onUnmounted(() => {
  flush();
});
</script>

<style scoped lang="scss">
.todow {
  display: flex;
  flex-direction: column;
  gap: var(--k-sp-2);
  height: 100%;
}

.todow__bar {
  display: flex;
  align-items: center;
  gap: var(--k-sp-1);
  flex: none;
}

.todow__bar-rule {
  width: 1px;
  height: 16px;
  margin: 0 var(--k-sp-1);
  background: var(--k-line);
}

.todow__icon {
  display: block;
  width: var(--k-icon-sm);
  height: var(--k-icon-sm);
}

.todow__list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
}

.todow__item {
  display: flex;
  align-items: flex-start;
  gap: var(--k-sp-2);
  padding: var(--k-sp-1) 0;
}

.todow__item + .todow__item {
  border-top: 1px solid var(--k-line);
}

// The checkbox, drawn like KCheckbox's box (same size, radius and accent fill) so «done»
// reads identically everywhere in the app — but a button, because the label beside it is an
// editor, not a <label>.
.todow__box {
  appearance: none;
  flex: none;
  width: 16px;
  height: 16px;
  margin-top: 3px;
  padding: 0;
  border: 1px solid var(--k-line-strong);
  background: var(--k-surface);
  border-radius: var(--k-r);
  display: grid;
  place-content: center;
  cursor: pointer;
  transition: background 0.12s, border-color 0.12s;
}

.todow__box:focus-visible {
  outline: 1px solid var(--k-accent);
  outline-offset: 1px;
}

.todow__item--done .todow__box {
  background: var(--k-accent);
  border-color: var(--k-accent);
}

.todow__item--done .todow__box::after {
  content: '';
  width: 4px;
  height: 8px;
  border: solid var(--k-canvas);
  border-width: 0 2px 2px 0;
  transform: rotate(45deg) translateY(-1px);
}

.todow__num {
  flex: none;
  min-width: 18px;
  margin-top: 3px;
  font-size: var(--k-fs-xs);
  color: var(--k-faint);
  text-align: right;
  font-variant-numeric: tabular-nums;
}

.todow__text {
  flex: 1;
  min-width: 0;
  margin: 0;
  font-size: var(--k-fs-sm);
  line-height: 1.5;
  color: var(--k-text);
  overflow-wrap: anywhere;
  outline: none;
  border-radius: var(--k-r-sm);
}

.todow__text:empty::before {
  content: attr(data-placeholder);
  color: var(--k-faint);
  pointer-events: none;
}

// Done: struck AND dimmed — never colour alone.
.todow__item--done .todow__text {
  color: var(--k-faint);
  text-decoration: line-through;
}

.todow__remove {
  flex: none;
  width: 20px;
  height: 20px;
  margin-top: 1px;
  padding: 0;
  border: none;
  background: transparent;
  color: var(--k-faint);
  font-size: var(--k-fs-xs);
  line-height: 1;
  border-radius: var(--k-r-sm);
  cursor: pointer;
  opacity: 0;
  transition: opacity 0.12s, color 0.12s;
}

.todow__item:hover .todow__remove,
.todow__remove:focus-visible {
  opacity: 1;
}

.todow__remove:hover {
  color: var(--k-danger);
}

.todow__remove:focus-visible {
  outline: 1px solid var(--k-accent);
  outline-offset: 1px;
}

.todow__empty {
  margin: 0;
  color: var(--k-muted);
  font-size: var(--k-fs-xs);
}

.todow__add {
  margin-top: auto;
  align-self: flex-start;
  padding: var(--k-sp-1) 0;
  border: none;
  background: transparent;
  font-size: var(--k-fs-xs);
  color: var(--k-accent);
  cursor: pointer;
}

.todow__add:hover {
  text-decoration: underline;
}

.todow__add:focus-visible {
  outline: 1px solid var(--k-accent);
  outline-offset: 1px;
  border-radius: var(--k-r-sm);
}

@media (prefers-reduced-motion: reduce) {
  .todow__box,
  .todow__remove {
    transition: none;
  }
}
</style>
