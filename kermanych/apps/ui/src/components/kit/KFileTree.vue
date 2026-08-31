<script setup lang="ts">
// A lazy file tree for a session's worktree — one level per fetch, folders first. It renders
// ITSELF for an expanded folder: `load` fetches that folder's children the first time it
// opens, the result is cached on the node, and a collapse drops it (a re-open re-fetches,
// which is cheap against a local worktree). A file click bubbles up as `open`; read-only.
import { ref } from 'vue';
import type { TreeEntry } from '@kermanych/core';

const props = defineProps<{
  entries: TreeEntry[];
  base: string; // path prefix of this level ('' at the root)
  selected: string | null; // the file currently open in the viewer
  load: (path: string) => Promise<TreeEntry[]>;
}>();
const emit = defineEmits<{ open: [path: string] }>();

type Child = TreeEntry[] | 'loading' | 'error';
const children = ref<Record<string, Child>>({});

function pathOf(entry: TreeEntry): string {
  return props.base ? `${props.base}/${entry.name}` : entry.name;
}

async function onClick(entry: TreeEntry): Promise<void> {
  const path = pathOf(entry);
  if (entry.type === 'file') {
    emit('open', path);
    return;
  }
  if (children.value[path]) {
    delete children.value[path];
    return;
  }
  children.value[path] = 'loading';
  try {
    children.value[path] = await props.load(path);
  } catch {
    children.value[path] = 'error';
  }
}
</script>

<template>
  <ul class="k-file-tree">
    <li v-for="e in entries" :key="e.name">
      <button
        type="button"
        class="k-file-tree__row"
        :class="{ 'k-file-tree__row--selected': e.type === 'file' && selected === pathOf(e) }"
        @click="onClick(e)"
      >
        <span class="k-file-tree__twist" aria-hidden="true">{{
          e.type === 'dir' ? (Array.isArray(children[pathOf(e)]) ? '▾' : '▸') : ''
        }}</span>
        <span class="k-file-tree__icon" aria-hidden="true">{{ e.type === 'dir' ? '📁' : '📄' }}</span>
        <span class="k-file-tree__name mono">{{ e.name }}</span>
      </button>

      <div v-if="children[pathOf(e)] === 'loading'" class="k-file-tree__note mono">…</div>
      <div
        v-else-if="children[pathOf(e)] === 'error'"
        class="k-file-tree__note k-file-tree__note--error mono"
      >
        не вдалося відкрити теку
      </div>
      <KFileTree
        v-else-if="Array.isArray(children[pathOf(e)])"
        :entries="children[pathOf(e)] as TreeEntry[]"
        :base="pathOf(e)"
        :selected="selected"
        :load="load"
        @open="emit('open', $event)"
      />
    </li>
  </ul>
</template>

<style scoped lang="scss">
.k-file-tree {
  list-style: none;
  margin: 0;
  padding: 0;
}
// Each nested level indents under its folder — the IDE guide.
.k-file-tree .k-file-tree {
  padding-left: 14px;
}
.k-file-tree__row {
  display: flex;
  align-items: center;
  gap: 4px;
  width: 100%;
  padding: 2px var(--k-sp-2);
  border: none;
  background: transparent;
  color: var(--k-text);
  font-size: 13px;
  text-align: left;
  cursor: pointer;
  border-radius: var(--k-r-sm);

  &:hover {
    background: var(--k-surface2);
  }
  &--selected {
    background: var(--k-surface2);
    color: var(--k-accent);
  }
}
.k-file-tree__twist {
  flex: none;
  width: 12px;
  color: var(--k-faint);
  font-size: 10px;
}
.k-file-tree__icon {
  flex: none;
  font-size: 12px;
}
.k-file-tree__name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.k-file-tree__note {
  padding: 2px var(--k-sp-2) 2px 18px;
  color: var(--k-faint);
  font-size: 12px;
  &--error {
    color: var(--k-danger);
  }
}
</style>
