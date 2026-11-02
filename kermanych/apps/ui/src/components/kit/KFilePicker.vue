<template>
  <div v-if="open" class="k-fp" :class="{ 'k-fp--below': placement === 'below' }">
    <!-- Click-away, the same as KHelperPicker's: `mousedown.prevent` closes before the
         textarea underneath can take the caret. -->
    <div class="k-fp__scrim" @mousedown.prevent="emit('close')"></div>
    <div class="k-fp__panel" role="dialog" :aria-label="t('kit.filePicker.title')">
      <input
        ref="filterEl"
        v-model="query"
        class="k-fp__filter mono"
        type="text"
        :placeholder="t('kit.filePicker.filter')"
        :aria-label="t('kit.filePicker.filterLabel')"
        @keydown="onKeydown"
      />
      <p class="k-fp__path mono">/{{ dir }}</p>
      <KSkeleton v-if="phase === 'skeleton'" class="k-fp__skeleton" variant="lines" :rows="4" />
      <template v-else-if="phase === 'blank'"></template>
      <p v-else-if="error" class="k-fp__error mono" role="alert">{{ error }}</p>
      <ul v-else-if="shown.length" class="k-fp__list" role="listbox">
        <li v-for="(row, i) in shown" :key="`${row.kind}:${row.name}`">
          <button
            type="button"
            class="k-fp__item mono"
            :class="{ 'k-fp__item--on': i === active }"
            role="option"
            :aria-selected="i === active"
            @mousemove="active = i"
            @click="choose(row)"
          >
            <span class="k-fp__icon" aria-hidden="true">{{ row.kind === 'file' ? '·' : row.kind === 'up' ? '↑' : '▸' }}</span>
            <span class="k-fp__name" :class="{ 'k-fp__name--dir': row.kind !== 'file' }">
              {{ row.kind === 'up' ? t('kit.filePicker.up') : row.kind === 'dir' ? `${row.name}/` : row.name }}
            </span>
          </button>
        </li>
      </ul>
      <p v-else class="k-fp__empty mono">{{ t('kit.filePicker.empty') }}</p>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import type { TreeEntry } from '@kermanych/core';
import { api } from '../../lib/api';
import { useLoadPhase } from '../../composables/useLoadPhase';
import KSkeleton from './KSkeleton.vue';

// The «@ Файл» panel: the project's tree, one folder at a time, so the operator can name a
// file in a task or a chat message. Shaped and keyed like KHelperPicker — anchored to whichever
// field opened it, its own filter input owning the keyboard while open — and, like it, it only
// says WHICH file was picked: the host decides where the `@path` token lands.
//
// `source` is the tree it reads: a session's (its worktree, or the checkout an in-place session
// runs in) or a project's local checkout. Both are the Файли dock's own endpoints, which read
// one level per call, so the filter narrows the folder on screen rather than searching the
// whole repository.
const props = withDefaults(
  defineProps<{
    open: boolean;
    source: { kind: 'session' | 'project'; id: string } | null;
    placement?: 'above' | 'below';
  }>(),
  { placement: 'above' },
);
const emit = defineEmits<{ select: [path: string]; close: [] }>();

const { t } = useI18n();

const dir = ref('');
const query = ref('');
const active = ref(0);
const filterEl = ref<HTMLInputElement | null>(null);
// `undefined` = this folder has not arrived yet, kept apart from an empty one.
const entries = ref<TreeEntry[] | undefined>(undefined);
const error = ref<string | null>(null);
const phase = useLoadPhase(() => entries.value === undefined && error.value === null);

// A slow listing of a folder already left must not overwrite the one now on screen.
let run = 0;
async function load(path: string): Promise<void> {
  const src = props.source;
  const mine = ++run;
  dir.value = path;
  query.value = '';
  active.value = 0;
  entries.value = undefined;
  error.value = null;
  if (!src) {
    entries.value = [];
    return;
  }
  try {
    const list = src.kind === 'session' ? await api.sessionTree(src.id, path) : await api.projectTree(src.id, path);
    if (mine === run) entries.value = list;
  } catch (e) {
    if (mine === run) error.value = e instanceof Error ? e.message : String(e);
  }
}

// Opening is the reset: back to the root with an empty filter, focus in the filter.
watch(
  () => props.open,
  (open) => {
    if (!open) return;
    void load('');
    void nextTick(() => filterEl.value?.focus());
  },
);

type Row = { kind: 'up' | 'dir' | 'file'; name: string };
const shown = computed<Row[]>(() => {
  const q = query.value.trim().replace(/^@+/, '').toLowerCase();
  const list = (entries.value ?? [])
    .filter((e) => !q || e.name.toLowerCase().includes(q))
    .map((e): Row => ({ kind: e.type, name: e.name }));
  return dir.value && !q ? [{ kind: 'up', name: '..' }, ...list] : list;
});
watch(shown, (list) => {
  if (active.value >= list.length) active.value = 0;
});

function parentOf(path: string): string {
  const cut = path.lastIndexOf('/');
  return cut < 0 ? '' : path.slice(0, cut);
}

function choose(row: Row): void {
  if (row.kind === 'up') {
    void load(parentOf(dir.value));
  } else if (row.kind === 'dir') {
    void load(dir.value ? `${dir.value}/${row.name}` : row.name);
  } else {
    emit('select', dir.value ? `${dir.value}/${row.name}` : row.name);
    emit('close');
  }
  void nextTick(() => filterEl.value?.focus());
}

function onKeydown(e: KeyboardEvent): void {
  const last = shown.value.length - 1;
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    active.value = active.value >= last ? 0 : active.value + 1;
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    active.value = active.value <= 0 ? last : active.value - 1;
  } else if (e.key === 'Enter' && !e.isComposing) {
    // Never reaches the form around the host field: there Enter sends the message.
    e.preventDefault();
    const hit = shown.value[active.value];
    if (hit) choose(hit);
  } else if (e.key === 'Backspace' && !query.value && dir.value) {
    // An empty filter has nothing left to delete, so Backspace climbs a folder instead.
    e.preventDefault();
    void load(parentOf(dir.value));
  } else if (e.key === 'Escape' || e.key === 'Tab') {
    e.preventDefault();
    // Escape closes the panel and nothing else — not the KModal the task form sits in.
    if (e.key === 'Escape') e.stopPropagation();
    emit('close');
  }
}
</script>

<style scoped lang="scss">
.k-fp {
  position: absolute;
  bottom: calc(100% - var(--k-sp-2));
  left: var(--k-sp-3);
  z-index: 20;
}

.k-fp--below {
  top: calc(100% - var(--k-sp-2));
  bottom: auto;
}

.k-fp__scrim {
  position: fixed;
  inset: 0;
}

.k-fp__panel {
  position: relative;
  display: flex;
  flex-direction: column;
  width: 360px;
  max-height: 340px;
  border: 1px solid var(--k-line-strong);
  border-radius: var(--k-r);
  background: var(--k-surface);
  box-shadow: 0 8px 24px rgb(0 0 0 / 28%);
  overflow: hidden;
}

.k-fp__filter {
  flex: none;
  padding: var(--k-sp-2) var(--k-sp-3);
  border: none;
  border-bottom: 1px solid var(--k-line);
  background: transparent;
  color: var(--k-text);
  font-size: var(--k-fs-sm);
  outline: none;

  &::placeholder {
    color: var(--k-muted);
  }
}

.k-fp__path {
  flex: none;
  margin: 0;
  padding: var(--k-sp-1) var(--k-sp-3);
  border-bottom: 1px solid var(--k-line);
  color: var(--k-muted);
  font-size: var(--k-fs-xs);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.k-fp__skeleton {
  padding: var(--k-sp-3);
}

.k-fp__list {
  flex: 1 1 auto;
  margin: 0;
  padding: var(--k-sp-1);
  list-style: none;
  overflow-y: auto;
}

.k-fp__item {
  display: flex;
  align-items: baseline;
  gap: var(--k-sp-2);
  width: 100%;
  padding: var(--k-sp-1) var(--k-sp-2);
  border: none;
  border-radius: var(--k-r);
  background: transparent;
  color: var(--k-text);
  font-size: var(--k-fs-sm);
  text-align: left;
  cursor: pointer;
}

// Pointer and keyboard share one highlight, as in KHelperPicker.
.k-fp__item--on {
  background: var(--k-bg);
}

.k-fp__icon {
  flex: none;
  width: 1ch;
  color: var(--k-muted);
}

.k-fp__name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.k-fp__name--dir {
  color: var(--k-accent);
}

.k-fp__empty,
.k-fp__error {
  margin: 0;
  padding: var(--k-sp-3);
  color: var(--k-muted);
  font-size: var(--k-fs-xs);
}

.k-fp__error {
  color: var(--k-danger);
}
</style>
