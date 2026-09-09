<script setup lang="ts">
// One node of the documentation tree, self-recursive so a folder renders its children at any
// depth (spec §3.5). A dir lazy-fetches its one level of children the first time it is opened;
// a file opens in the preview. The parent seeds root folder nodes and hands each down here.
import { computed } from 'vue';
import type { TreeEntry } from '@kermanych/core';
import { useProjectDocs } from 'stores/project-docs';
import { useI18n } from 'vue-i18n';

export type DocNode = {
  folder: string;
  path: string;
  name: string;
  type: 'dir' | 'file';
  children?: DocNode[];
  open?: boolean;
};

const props = defineProps<{ projectId: string; node: DocNode }>();
const docs = useProjectDocs();
const { t } = useI18n();

// Highlight the row whose file is open in the preview. The store identifies the open file by
// (folder, path), so a same-named file under a different doc folder never falsely lights up.
const isSelected = computed(
  () => props.node.type === 'file' && docs.openFolder === props.node.folder && docs.openPath === props.node.path,
);

async function onClick(): Promise<void> {
  const node = props.node;
  if (node.type === 'file') {
    void docs.openFile(props.projectId, node.folder, node.path);
    return;
  }
  node.open = !node.open;
  if (node.children || !node.open) return;
  const entries: TreeEntry[] = await docs.treeOf(props.projectId, node.folder, node.path);
  node.children = entries.map((e) => ({
    folder: node.folder,
    path: node.path ? `${node.path}/${e.name}` : e.name,
    name: e.name,
    type: e.type,
  }));
}
</script>

<template>
  <li class="doc-tree__item">
    <button
      class="doc-tree__row"
      :class="{ 'doc-tree__row--selected': isSelected }"
      type="button"
      @click="onClick"
    >
      <span class="doc-tree__twist" aria-hidden="true">{{
        node.type === 'dir' ? (node.open ? '▾' : '▸') : ''
      }}</span>
      <span class="doc-tree__icon" aria-hidden="true">{{ node.type === 'dir' ? '📁' : '📄' }}</span>
      <span class="doc-tree__name">{{ node.name }}</span>
    </button>
    <ul v-if="node.type === 'dir' && node.open && node.children" class="doc-tree__children">
      <DocTreeNode
        v-for="child in node.children"
        :key="child.path"
        :project-id="projectId"
        :node="child"
      />
      <li v-if="!node.children.length" class="doc-tree__empty">{{ t('docsPage.emptyFolder') }}</li>
    </ul>
  </li>
</template>

<style scoped lang="scss">
.doc-tree__item {
  list-style: none;
}
// Each nested level indents under its folder — the IDE guide (mirrors KFileTree).
.doc-tree__children {
  list-style: none;
  margin: 0;
  padding-left: 14px;
}
.doc-tree__row {
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
.doc-tree__twist {
  flex: none;
  width: 12px;
  color: var(--k-faint);
  font-size: 10px;
}
.doc-tree__icon {
  flex: none;
  font-size: var(--k-icon-xs);
}
.doc-tree__name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.doc-tree__empty {
  list-style: none;
  color: var(--k-muted);
  font-size: 12px;
  padding: 2px var(--k-sp-2) 2px 18px;
}
</style>
