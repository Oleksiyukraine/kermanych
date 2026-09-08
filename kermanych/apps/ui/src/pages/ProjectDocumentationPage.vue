<script setup lang="ts">
// The Project Documentation screen. Two levels in one place: the workspace's projects are
// listed (the workspace-level aggregation), and selecting one renders its configured doc
// folders as a browsable tree + a faithful GitHub-style preview of the actual repository
// files (decision A — read live from THIS machine's bound checkout; nothing is uploaded).
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import type { TreeEntry } from '@kermanych/core';
import { useProjects } from 'stores/projects';
import { useOrchestrator } from 'stores/orchestrator';
import { useProjectDocs } from 'stores/project-docs';
import { renderDoc } from '../lib/markdown';
import KFileView from 'components/kit/KFileView.vue';
import DocTreeNode, { type DocNode } from './DocTreeNode.vue';

const props = defineProps<{ workspaceId: string; workspaceName: string }>();
const { t } = useI18n();
const projects = useProjects();
const local = useOrchestrator();
const docs = useProjectDocs();

// Projects of this workspace (the aggregation).
const wsProjects = computed(() => projects.projectsByWorkspace.find((g) => g.workspace.id === props.workspaceId)?.projects ?? []);

const selectedId = ref('');
const localRow = computed(() => local.projects.find((p) => p.id === selectedId.value));
const docFolders = computed(() => localRow.value?.docFolders ?? []);
const isBound = computed(() => !!localRow.value?.localRepoPath);

// Pre-focus the sidebar's selected project if it belongs to this workspace.
watch(
  () => [props.workspaceId, local.selectedProjectId] as const,
  () => {
    const pre = wsProjects.value.find((p) => p.id === local.selectedProjectId)?.id;
    if (pre && pre !== selectedId.value) select(pre);
    else if (!selectedId.value && wsProjects.value[0]) select(wsProjects.value[0].id);
  },
  { immediate: true },
);

function select(id: string): void {
  selectedId.value = id;
  docs.setActive(id);
}

// Root folder nodes; each folder lazily loads its one level of children when expanded
// (DocTreeNode handles the recursion and click semantics).
const roots = ref<DocNode[]>([]);

watch([selectedId, docFolders, isBound], () => {
  roots.value = docFolders.value.map((f) => ({ folder: f, path: '', name: f, type: 'dir' as const }));
});

// A pull can add or remove files under an already-expanded folder (spec §3.6). When the store
// signals a refresh, walk every open dir and re-fetch its level, preserving expansion state.
async function refreshNode(node: DocNode): Promise<void> {
  if (node.type !== 'dir' || !node.open) return;
  const entries: TreeEntry[] = await docs.treeOf(selectedId.value, node.folder, node.path);
  const prev = new Map((node.children ?? []).map((c) => [c.path, c]));
  node.children = entries.map((e) => {
    const path = node.path ? `${node.path}/${e.name}` : e.name;
    const old = prev.get(path);
    if (old && old.type === e.type) return old;
    return { folder: node.folder, path, name: e.name, type: e.type };
  });
  for (const child of node.children) await refreshNode(child);
}

watch(() => docs.refreshNonce, () => { for (const r of roots.value) void refreshNode(r); });

const isMarkdown = computed(() => /\.(?:md|mdx|mdc|markdown|rst|adoc|asciidoc)$/i.test(docs.openPath));
const previewHtml = computed(() => {
  const f = docs.file;
  if (!f || f.binary || f.truncated || !isMarkdown.value) return '';
  const slash = docs.openPath.lastIndexOf('/');
  const dir = slash === -1 ? '' : docs.openPath.slice(0, slash);
  return renderDoc(f.content, { folder: docs.openFolder, dir });
});

// After v-html paints, resolve relative images (authed blob → object URL) and wire relative
// doc links to in-app navigation. Re-run whenever the rendered HTML changes.
const previewEl = ref<HTMLElement | null>(null);
watch([previewHtml, previewEl], async () => {
  const el = previewEl.value;
  if (!el) return;
  for (const img of Array.from(el.querySelectorAll<HTMLImageElement>('img[data-doc-path]'))) {
    const folder = img.getAttribute('data-doc-folder')!;
    const path = img.getAttribute('data-doc-path')!;
    try { img.src = await docs.rawUrl(selectedId.value, folder, path); } catch { /* leave broken */ }
  }
  for (const a of Array.from(el.querySelectorAll<HTMLAnchorElement>('a[data-doc-path]'))) {
    a.addEventListener('click', (ev) => {
      ev.preventDefault();
      const folder = a.getAttribute('data-doc-folder')!;
      const path = a.getAttribute('data-doc-path')!;
      void docs.openFile(selectedId.value, folder, path);
    });
  }
});

onBeforeUnmount(() => docs.releaseUrls());
</script>

<template>
  <div class="docs">
    <aside class="docs__projects">
      <button
        v-for="p in wsProjects"
        :key="p.id"
        type="button"
        class="docs__project"
        :class="{ 'docs__project--on': p.id === selectedId }"
        @click="select(p.id)"
      >{{ p.name }}</button>
      <p v-if="!wsProjects.length" class="docs__empty">{{ t('docsPage.noProjects') }}</p>
    </aside>

    <nav class="docs__tree">
      <template v-if="!selectedId"><p class="docs__empty">{{ t('docsPage.pickProject') }}</p></template>
      <template v-else-if="!isBound"><p class="docs__empty">{{ t('docsPage.bindPrompt') }}</p></template>
      <template v-else-if="!docFolders.length"><p class="docs__empty">{{ t('docsPage.noFolders') }}</p></template>
      <ul v-else class="docs__nodes">
        <DocTreeNode
          v-for="n in roots"
          :key="n.folder"
          :project-id="selectedId"
          :node="n"
        />
      </ul>
    </nav>

    <section class="docs__preview">
      <p v-if="docs.loadingFile" class="docs__empty">{{ t('docsPage.loading') }}</p>
      <p v-else-if="docs.fileError" class="docs__empty docs__empty--error">{{ docs.fileError }}</p>
      <template v-else-if="docs.file && !docs.file.binary && !docs.file.truncated && isMarkdown">
        <!-- renderDoc keeps html:false, so v-html output is a controlled tag set. -->
        <div ref="previewEl" class="k-log__markdown" v-html="previewHtml"></div>
      </template>
      <KFileView
        v-else-if="docs.file && !docs.file.binary"
        :path="docs.openPath"
        :file="docs.file"
      />
      <p v-else-if="docs.file && docs.file.binary" class="docs__empty">{{ t('docsPage.binary') }}</p>
      <p v-else class="docs__empty">{{ t('docsPage.pickFile') }}</p>
    </section>
  </div>
</template>

<style scoped lang="scss">
.docs { display: grid; grid-template-columns: 200px 240px 1fr; gap: var(--k-sp-3); height: 100%; min-height: 0; }
.docs__projects, .docs__tree { overflow: auto; border-right: 1px solid var(--k-line); padding-right: var(--k-sp-2); display: flex; flex-direction: column; gap: 2px; }
.docs__project, .docs__node { text-align: left; background: none; border: 0; color: var(--k-text); cursor: pointer; padding: 4px 6px; border-radius: 6px; font: inherit; }
.docs__project--on { background: var(--k-surface-2); }
.docs__node:hover, .docs__project:hover { background: var(--k-surface-2); }
.docs__nodes, .docs__nodes ul { list-style: none; margin: 0; padding-left: var(--k-sp-2); }
.docs__preview { overflow: auto; min-height: 0; }
.docs__empty { color: var(--k-muted); font-size: 13px; padding: var(--k-sp-3); &--error { color: var(--k-danger); } }
</style>
