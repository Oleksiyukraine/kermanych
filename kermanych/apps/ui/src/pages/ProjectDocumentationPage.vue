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
import { useAuth } from 'stores/auth';
import { getDocIndexState, type DocIndexState } from '@kermanych/cloud';
import { api } from '../lib/api';

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

// The cloud documentation index for the selected project: when it was built and how many
// files it covers, or null when it has never been indexed. Read directly from the cloud under
// the operator's own JWT (RLS scopes it), the same way every other cloud read in the ui works.
const auth = useAuth();
const indexState = ref<DocIndexState | null>(null);
const reindexing = ref(false);
const reindexMsg = ref<{ level: 'ok' | 'error'; text: string } | null>(null);

async function loadIndexState(id: string): Promise<void> {
  indexState.value = null;
  reindexMsg.value = null;
  if (!id) return;
  try {
    indexState.value = await getDocIndexState(auth.client, id);
  } catch {
    // An unreachable cloud reads as "unknown"; the tab shows nothing rather than a false state.
    indexState.value = null;
  }
}

watch(selectedId, (id) => void loadIndexState(id), { immediate: true });

// Manual "reindex everything": the api walks the bound checkout and re-embeds every published
// doc file. Blocks (with a spinner) so the freshly-built state and any error are visible.
async function reindex(): Promise<void> {
  const id = selectedId.value;
  if (!id || reindexing.value) return;
  reindexing.value = true;
  reindexMsg.value = null;
  try {
    const res = await api.reindexDocs(id);
    reindexMsg.value = { level: 'ok', text: t('docsPage.reindexOk', { files: res.indexedFiles, chunks: res.chunkCount }) };
    await loadIndexState(id);
    docs.refreshIfActive(id);
  } catch (e) {
    reindexMsg.value = { level: 'error', text: t('docsPage.reindexFail', { error: e instanceof Error ? e.message : String(e) }) };
  } finally {
    reindexing.value = false;
  }
}

// Root folder nodes; each folder lazily loads its one level of children when expanded
// (DocTreeNode handles the recursion and click semantics).
const roots = ref<DocNode[]>([]);

// `immediate`: the pre-focus watch above selects a project SYNCHRONOUSLY during setup (before
// this watch exists), so without it a page entered with a project already selected would build
// no root nodes and render an empty tree even though docFolders is set.
watch([selectedId, docFolders, isBound], () => {
  const id = selectedId.value;
  const built: DocNode[] = docFolders.value.map((f) => ({ folder: f, path: '', name: f, type: 'dir' as const }));
  roots.value = built;
  // Auto-expand every configured folder so its files are visible on arrival. A root folder
  // that must be clicked open reads as «no docs» — the reported bug. Each root fetches its own
  // one level; an absent/empty folder resolves to an empty listing and shows the empty note.
  for (const r of built) void openNode(id, r);
}, { immediate: true });

// Expand a dir node and lazily fetch its one level of children. Guarded by the captured
// project id so a fast project switch cannot graft one project's tree onto another.
async function openNode(id: string, node: DocNode): Promise<void> {
  if (node.type !== 'dir') return;
  node.open = true;
  if (node.children) return;
  const entries: TreeEntry[] = await docs.treeOf(id, node.folder, node.path);
  if (id !== selectedId.value) return;
  node.children = entries.map((e) => ({
    folder: node.folder,
    path: node.path ? `${node.path}/${e.name}` : e.name,
    name: e.name,
    type: e.type,
  }));
}

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
    <aside class="docs__nav">
      <div v-if="wsProjects.length > 1" class="docs__projects">
        <button
          v-for="p in wsProjects"
          :key="p.id"
          type="button"
          class="docs__project"
          :class="{ 'docs__project--on': p.id === selectedId }"
          @click="select(p.id)"
        >{{ p.name }}</button>
      </div>

      <div v-if="selectedId && isBound" class="docs__index">
        <div class="docs__index-head">{{ t('docsPage.indexHeading') }}</div>
        <p class="docs__index-state">
          <template v-if="indexState && indexState.fileCount > 0">
            {{ t('docsPage.indexSummary', { files: indexState.fileCount, when: (indexState.lastIndexedAt || '').slice(0, 10) }) }}
          </template>
          <template v-else>{{ t('docsPage.indexNever') }}</template>
        </p>
        <button type="button" class="docs__reindex" :disabled="reindexing" @click="reindex">
          {{ reindexing ? t('docsPage.reindexing') : t('docsPage.reindex') }}
        </button>
        <p
          v-if="reindexMsg"
          class="docs__index-msg"
          :class="{ 'docs__index-msg--error': reindexMsg.level === 'error' }"
        >{{ reindexMsg.text }}</p>
      </div>

      <nav class="docs__tree">
        <template v-if="!wsProjects.length"><p class="docs__empty">{{ t('docsPage.noProjects') }}</p></template>
        <template v-else-if="!selectedId"><p class="docs__empty">{{ t('docsPage.pickProject') }}</p></template>
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
    </aside>

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
.docs { display: grid; grid-template-columns: minmax(200px, 280px) 1fr; gap: var(--k-sp-4); height: 100%; min-height: 0; }
.docs__nav { display: flex; flex-direction: column; gap: var(--k-sp-2); overflow: hidden; min-height: 0; border-right: 1px solid var(--k-line); padding-right: var(--k-sp-3); }
.docs__projects { display: flex; flex-wrap: wrap; gap: 4px; padding-bottom: var(--k-sp-2); border-bottom: 1px solid var(--k-line); }
.docs__tree { overflow: auto; min-height: 0; display: flex; flex-direction: column; gap: 2px; }
.docs__project { text-align: left; background: none; border: 1px solid var(--k-line); color: var(--k-text); cursor: pointer; padding: 4px 6px; border-radius: 6px; font: inherit; }
.docs__project--on { background: var(--k-surface2); }
.docs__project:hover { background: var(--k-surface2); }
.docs__nodes { list-style: none; margin: 0; padding-left: 0; }
.docs__preview { overflow: auto; min-height: 0; }
.docs__empty { color: var(--k-muted); font-size: 13px; padding: var(--k-sp-3); &--error { color: var(--k-danger); } }
.docs__index { display: flex; flex-direction: column; gap: 4px; padding-bottom: var(--k-sp-2); border-bottom: 1px solid var(--k-line); }
.docs__index-head { font-size: 12px; font-weight: 600; color: var(--k-muted); text-transform: uppercase; letter-spacing: 0.04em; }
.docs__index-state { margin: 0; font-size: 13px; color: var(--k-text); }
.docs__reindex { align-self: flex-start; background: none; border: 1px solid var(--k-line); color: var(--k-text); cursor: pointer; padding: 4px 8px; border-radius: 6px; font: inherit; }
.docs__reindex:hover:not(:disabled) { background: var(--k-surface2); }
.docs__reindex:disabled { opacity: 0.6; cursor: default; }
.docs__index-msg { margin: 0; font-size: 12px; color: var(--k-muted); &--error { color: var(--k-danger); } }
</style>
