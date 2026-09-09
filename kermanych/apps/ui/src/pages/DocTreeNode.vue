<script setup lang="ts">
// One node of the documentation tree, self-recursive so a folder renders its children at any
// depth (spec §3.5). A dir lazy-fetches its one level of children the first time it is opened;
// a file opens in the preview. The parent seeds root folder nodes and hands each down here.
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
  <li>
    <button
      class="docs__node"
      :class="{ 'docs__node--dir': node.type === 'dir' }"
      type="button"
      @click="onClick"
    >{{ node.type === 'dir' ? (node.open ? '▾ ' : '▸ ') : '' }}{{ node.name }}</button>
    <ul v-if="node.type === 'dir' && node.open && node.children">
      <DocTreeNode
        v-for="child in node.children"
        :key="child.path"
        :project-id="projectId"
        :node="child"
      />
      <li v-if="!node.children.length" class="docs__node-empty">{{ t('docsPage.emptyFolder') }}</li>
    </ul>
  </li>
</template>

<style scoped lang="scss">
.docs__node-empty { list-style: none; color: var(--k-muted); font-size: 12px; padding: 4px 6px; }
</style>
