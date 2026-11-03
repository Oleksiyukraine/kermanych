<script setup lang="ts">
// A lazy file tree for a session's worktree — one level per fetch, folders first. It renders
// ITSELF for an expanded folder: `load` fetches that folder's children the first time it
// opens, the result is cached on the node, and a collapse drops it (a re-open re-fetches,
// which is cheap against a local worktree). A file click bubbles up as `open`; read-only.
//
// `refreshKey` re-reads every open folder when it changes (a pull may have added or removed
// files), keeping what is expanded; `reveal(path)` opens the folders down to a file, for a
// host that opens a file from somewhere other than the tree (a link in a rendered doc).
import { nextTick, ref, watch, type ComponentPublicInstance } from 'vue';
import { useI18n } from 'vue-i18n';
import type { TreeEntry } from '@kermanych/core';

const props = defineProps<{
  entries: TreeEntry[];
  base: string; // path prefix of this level ('' at the root)
  selected: string | null; // the file currently open in the viewer
  load: (path: string) => Promise<TreeEntry[]>;
  refreshKey?: unknown;
}>();
const emit = defineEmits<{ open: [path: string] }>();

const { t } = useI18n();

type Child = TreeEntry[] | 'loading' | 'error';
const children = ref<Record<string, Child>>({});

// Each open folder's own subtree, so `reveal` can carry on one level down.
type Subtree = { reveal: (path: string) => Promise<void> };
const subtrees = new Map<string, Subtree>();
function setSubtree(path: string, el: Element | ComponentPublicInstance | null): void {
  if (el) subtrees.set(path, el as unknown as Subtree);
  else subtrees.delete(path);
}

function pathOf(entry: TreeEntry): string {
  return props.base ? `${props.base}/${entry.name}` : entry.name;
}

// A folder that is gone after the refresh drops out of `entries`, and its subtree with it; a
// read that fails keeps what was shown.
watch(
  () => props.refreshKey,
  async () => {
    for (const [path, child] of Object.entries(children.value)) {
      if (!Array.isArray(child)) continue;
      try {
        const fresh = await props.load(path);
        if (Array.isArray(children.value[path])) children.value[path] = fresh;
      } catch {
        // keep the last good listing
      }
    }
  },
);

async function expand(path: string): Promise<boolean> {
  if (Array.isArray(children.value[path])) return true;
  if (children.value[path] === 'loading') return false;
  children.value[path] = 'loading';
  try {
    children.value[path] = await props.load(path);
    return true;
  } catch {
    children.value[path] = 'error';
    return false;
  }
}

async function reveal(target: string): Promise<void> {
  const dir = props.entries.find((e) => e.type === 'dir' && target.startsWith(`${pathOf(e)}/`));
  if (!dir) return;
  const path = pathOf(dir);
  if (!(await expand(path))) return;
  await nextTick();
  await subtrees.get(path)?.reveal(target);
}

defineExpose({ reveal });

async function onClick(entry: TreeEntry): Promise<void> {
  const path = pathOf(entry);
  if (entry.type === 'file') {
    emit('open', path);
    return;
  }
  // A second click while the folder is still loading is ignored: collapsing here would let the
  // in-flight fetch land afterwards and re-expand the folder on its own.
  if (children.value[path] === 'loading') return;
  if (children.value[path]) {
    delete children.value[path];
    return;
  }
  await expand(path);
}
</script>

<template>
  <ul class="k-file-tree">
    <li v-for="e in entries" :key="e.name">
      <button
        type="button"
        class="k-file-tree__row"
        :class="{ 'k-file-tree__row--selected': e.type === 'file' && selected === pathOf(e) }"
        :data-path="pathOf(e)"
        :data-kind="e.type"
        :aria-expanded="e.type === 'dir' ? Array.isArray(children[pathOf(e)]) : undefined"
        tabindex="-1"
        v-tip.overflow="e.name"
        @click="onClick(e)"
      >
        <span class="k-file-tree__twist" aria-hidden="true">{{
          e.type === 'dir' ? (Array.isArray(children[pathOf(e)]) ? '▾' : '▸') : ''
        }}</span>
        <span class="k-file-tree__icon" aria-hidden="true">{{ e.type === 'dir' ? '📁' : '📄' }}</span>
        <!-- A name cut to «…» by the panel's width shows in full in a tooltip on hover. -->
        <span class="k-file-tree__name mono" data-tip-clip>{{ e.name }}</span>
      </button>

      <div v-if="children[pathOf(e)] === 'loading'" class="k-file-tree__note mono">…</div>
      <div
        v-else-if="children[pathOf(e)] === 'error'"
        class="k-file-tree__note k-file-tree__note--error mono"
      >
        {{ t('kit.fileTree.openError') }}
      </div>
      <KFileTree
        v-else-if="Array.isArray(children[pathOf(e)])"
        :ref="(el) => setSubtree(pathOf(e), el)"
        :entries="children[pathOf(e)] as TreeEntry[]"
        :base="pathOf(e)"
        :selected="selected"
        :load="load"
        :refresh-key="refreshKey"
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
  // The row the arrow keys are on (KFileManager moves focus between rows). A click focuses a
  // row too, but only keyboard focus draws the ring.
  &:focus { outline: none; }
  &:focus-visible {
    background: var(--k-surface2);
    box-shadow: inset 0 0 0 1px var(--k-accent);
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
  // 📁/📄 are emoji: unlike a stroke glyph they fill their em box, so the floor step carries
  // them at the density these rows need. Named rather than literal so the row moves with the
  // scale if the floor ever lifts.
  font-size: var(--k-icon-xs);
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
