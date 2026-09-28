<script setup lang="ts">
// The Project Documentation screen. Two levels in one place: the workspace's projects are
// listed (the workspace-level aggregation), and selecting one renders its configured doc
// folders as a browsable tree + a faithful GitHub-style preview of the actual repository
// files (decision A — read live from THIS machine's bound checkout; nothing is uploaded).
//
// Beside the folders sit the project's documentation LINKS — pages that live outside the
// repository (a Google Doc, a Figma file, a published artifact). They are cloud rows shared
// by the team, so they show whether or not this machine has the checkout bound. A link opens
// in the same preview pane, embedded in an iframe, and can be blown up to the whole window.
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import type { TreeEntry } from '@kermanych/core';
import { useProjects } from 'stores/projects';
import { useOrchestrator } from 'stores/orchestrator';
import { useProjectDocs } from 'stores/project-docs';
import { DOC_MARKUP_RE, renderDoc } from '../lib/markdown';
import KFileView from 'components/kit/KFileView.vue';
import DocTreeNode, { type DocNode } from './DocTreeNode.vue';
import { useAuth } from 'stores/auth';
import { getDocIndexState, type DocIndexState } from '@kermanych/cloud';
import { api } from '../lib/api';
import { describeDocLink, parseDocLinkUrl, type DocLinkProvider } from '../lib/doc-links';
import { IS_PREVIEW } from '../lib/preview';
import KModal from 'components/kit/KModal.vue';
import KField from 'components/kit/KField.vue';
import KBtn from 'components/kit/KBtn.vue';
import KIconButton from 'components/kit/KIconButton.vue';

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

const isMarkdown = computed(() => DOC_MARKUP_RE.test(docs.openPath));
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

// ── Links ────────────────────────────────────────────────────────────────────

// The mark in a link's badge — a letter or glyph per provider, coloured by the stylesheet.
const BADGE: Record<DocLinkProvider, string> = {
  'google-docs': 'D',
  'google-sheets': 'S',
  'google-slides': 'P',
  'google-drawings': 'Dr',
  'google-forms': 'F',
  'google-drive': 'G',
  figma: 'Fg',
  youtube: '▶',
  loom: 'L',
  miro: 'M',
  notion: 'N',
  claude: '✳',
  github: 'GH',
  web: '↗',
};

const linkViews = computed(() => docs.links.map((link) => ({ link, view: describeDocLink(link.url) })));
const openEntry = computed(() => linkViews.value.find((e) => e.link.id === docs.openLinkId));
// A link's page cannot be shown before the api has said whether its host allows framing; a
// refused iframe renders blank, which reads as «the link is broken».
const openCheck = computed(() => (openEntry.value ? docs.embedChecks[openEntry.value.view.embedUrl] : undefined));

// Ask about every link once the list is known: the gallery draws a live thumbnail only for a
// page that may be framed, and the open link needs its answer before its iframe is mounted.
watch(linkViews, (entries) => { for (const e of entries) void docs.checkEmbed(e.view.embedUrl); }, { immediate: true });

// «Try here anyway» for a refused page, per link and only until another link is opened: the
// api fetches without the user's cookies, so in a browser tab signed in to the host the
// iframe may succeed where the check said no.
const forceEmbed = ref(false);
// «Full screen» lifts the open link's viewer over the whole window. The viewer is a manual
// popover so showPopover() promotes THIS element to the top layer — above every stacking
// context of the app shell — without moving it in the DOM: a re-parented iframe reloads,
// and the reader would lose their place in the page.
const fullPage = ref(false);
const viewerEl = ref<HTMLElement | null>(null);
watch([fullPage, viewerEl], ([full, el]) => {
  if (!el?.isConnected) return;
  const open = el.matches(':popover-open');
  if (full && !open) el.showPopover();
  else if (!full && open) el.hidePopover();
});
watch(() => docs.openLinkId, () => {
  forceEmbed.value = false;
  if (!docs.openLinkId) fullPage.value = false;
});

function onKey(ev: KeyboardEvent): void {
  if (ev.key === 'Escape' && fullPage.value) fullPage.value = false;
}
window.addEventListener('keydown', onKey);
onBeforeUnmount(() => window.removeEventListener('keydown', onKey));

// The add/edit dialog. `editingId` empty = adding.
const editorOpen = ref(false);
const editingId = ref('');
const urlInput = ref('');
const titleInput = ref('');
const saving = ref(false);
const editorError = ref<string | null>(null);
const parsedUrl = computed(() => parseDocLinkUrl(urlInput.value));
watch(urlInput, () => { editorError.value = null; });

function openEditor(id = ''): void {
  // The dialog renders under the top layer, so the full-screen viewer steps back first.
  fullPage.value = false;
  const link = docs.links.find((l) => l.id === id);
  editingId.value = link?.id ?? '';
  urlInput.value = link?.url ?? '';
  titleInput.value = link?.title ?? '';
  editorError.value = null;
  editorOpen.value = true;
}

async function saveLink(): Promise<void> {
  const url = parsedUrl.value;
  if (!url) {
    editorError.value = t('docsPage.linkUrlInvalid');
    return;
  }
  // An untitled link is named after its provider (or host) rather than refused: the URL is
  // the part that matters, and «Google Docs» is a fair name until someone gives a better one.
  const title = titleInput.value.trim() || describeDocLink(url).label;
  saving.value = true;
  editorError.value = null;
  try {
    if (editingId.value) await docs.saveLink(editingId.value, { title, url });
    else docs.openLink((await docs.addLink(selectedId.value, title, url)).id);
    editorOpen.value = false;
  } catch (e) {
    editorError.value = e instanceof Error ? e.message : String(e);
  } finally {
    saving.value = false;
  }
}

async function removeLink(id: string): Promise<void> {
  const link = docs.links.find((l) => l.id === id);
  if (!link || !window.confirm(t('docsPage.removeConfirm', { title: link.title }))) return;
  try {
    await docs.removeLink(id);
  } catch (e) {
    local.notify(e instanceof Error ? e.message : String(e), 'error');
  }
}

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

      <div v-if="selectedId && !IS_PREVIEW" class="docs__links">
        <div class="docs__links-head">
          <span class="docs__index-head">{{ t('docsPage.linksHeading') }}</span>
          <KIconButton :title="t('docsPage.addLink')" @click="openEditor()">+</KIconButton>
        </div>
        <p v-if="docs.linksError" class="docs__index-msg docs__index-msg--error">{{ docs.linksError }}</p>
        <p v-else-if="!docs.links.length && !docs.linksLoading" class="docs__index-msg">{{ t('docsPage.linksEmpty') }}</p>
        <ul v-if="linkViews.length" class="docs__link-list">
          <li v-for="e in linkViews" :key="e.link.id">
            <button
              type="button"
              class="docs__link"
              :class="{ 'docs__link--on': e.link.id === docs.openLinkId }"
              @click="docs.openLink(e.link.id)"
            >
              <span class="docs__badge" :data-provider="e.view.provider">{{ BADGE[e.view.provider] }}</span>
              <span class="docs__link-text">
                <span class="docs__link-title">{{ e.link.title }}</span>
                <span class="docs__link-host">{{ e.view.host }}</span>
              </span>
            </button>
          </li>
        </ul>
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
      <!-- An open link. A manual popover only so «full screen» can lift this same element into
           the top layer (see `fullPage`); closed, the stylesheet keeps it in the page flow. -->
      <div v-if="openEntry" ref="viewerEl" popover="manual" class="docs__viewer">
        <header class="docs__viewer-bar">
          <span class="docs__badge" :data-provider="openEntry.view.provider">{{ BADGE[openEntry.view.provider] }}</span>
          <div class="docs__viewer-title">
            <strong>{{ openEntry.link.title }}</strong>
            <span class="docs__link-host">{{ openEntry.view.label === openEntry.view.host ? openEntry.view.host : `${openEntry.view.label} · ${openEntry.view.host}` }}</span>
          </div>
          <a class="docs__open" :href="openEntry.link.url" target="_blank" rel="noopener noreferrer">{{ t('docsPage.openInBrowser') }} ↗</a>
          <KIconButton :title="t('docsPage.editLink')" @click="openEditor(openEntry.link.id)">✎</KIconButton>
          <KIconButton :title="t('docsPage.removeLink')" @click="removeLink(openEntry.link.id)">×</KIconButton>
          <KIconButton
            :title="fullPage ? t('docsPage.exitFullPage') : t('docsPage.fullPage')"
            :active="fullPage"
            @click="fullPage = !fullPage"
          >{{ fullPage ? '⤡' : '⤢' }}</KIconButton>
        </header>
        <div class="docs__viewer-body">
          <p v-if="!openCheck" class="docs__empty">{{ t('docsPage.checking') }}</p>
          <div v-else-if="openCheck.embeddable === false && !forceEmbed" class="docs__blocked">
            <h3>{{ t('docsPage.blockedTitle') }}</h3>
            <p>{{ t('docsPage.blockedFrame', { host: openEntry.view.host, header: openCheck.reason === 'frame-ancestors' ? 'CSP frame-ancestors' : 'X-Frame-Options' }) }}</p>
            <p>{{ t('docsPage.blockedSignIn') }}</p>
            <div class="docs__blocked-actions">
              <a class="docs__open docs__open--primary" :href="openEntry.link.url" target="_blank" rel="noopener noreferrer">{{ t('docsPage.openInBrowser') }} ↗</a>
              <KBtn variant="ghost" @click="forceEmbed = true">{{ t('docsPage.showAnyway') }}</KBtn>
            </div>
          </div>
          <template v-else>
            <!-- No allow-top-navigation: an embedded page cannot replace the app. Popups are
                 allowed and escape the sandbox — the desktop app routes them to the default
                 browser (src-electron/external-links.ts). -->
            <iframe
              :key="openEntry.view.embedUrl"
              class="docs__frame"
              :src="openEntry.view.embedUrl"
              :title="openEntry.link.title"
              sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-presentation allow-downloads"
              allow="fullscreen; clipboard-write; autoplay; encrypted-media; picture-in-picture"
            />
            <p v-if="openCheck.embeddable !== true" class="docs__frame-hint">{{ t('docsPage.blankHint') }}</p>
          </template>
        </div>
      </div>
      <p v-else-if="docs.loadingFile" class="docs__empty">{{ t('docsPage.loading') }}</p>
      <p v-else-if="docs.fileError" class="docs__empty docs__empty--error">{{ docs.fileError }}</p>
      <!-- An <img> never runs an SVG's scripts or loads its external resources, so a
           repository SVG is drawn without being trusted. -->
      <div v-else-if="docs.imageUrl" class="docs__image">
        <img :src="docs.imageUrl" :alt="docs.openPath">
      </div>
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
      <!-- Nothing open: the links as preview cards. A live miniature only for a page the api
           confirmed may be framed — anything else would be a blank or «refused» tile. -->
      <div v-else-if="linkViews.length" class="docs__gallery">
        <p class="docs__empty">{{ t('docsPage.pickFileOrLink') }}</p>
        <div class="docs__cards">
          <button
            v-for="e in linkViews"
            :key="e.link.id"
            type="button"
            class="docs__card"
            @click="docs.openLink(e.link.id)"
          >
            <span class="docs__card-thumb" :data-provider="e.view.provider">
              <iframe
                v-if="docs.embedChecks[e.view.embedUrl]?.embeddable === true"
                class="docs__card-frame"
                :src="e.view.embedUrl"
                tabindex="-1"
                aria-hidden="true"
                loading="lazy"
                sandbox="allow-scripts allow-same-origin"
              />
              <span v-else class="docs__card-mark">{{ BADGE[e.view.provider] }}</span>
            </span>
            <span class="docs__card-meta">
              <span class="docs__badge" :data-provider="e.view.provider">{{ BADGE[e.view.provider] }}</span>
              <span class="docs__link-text">
                <span class="docs__link-title">{{ e.link.title }}</span>
                <span class="docs__link-host">{{ e.view.label === e.view.host ? e.view.host : `${e.view.label} · ${e.view.host}` }}</span>
              </span>
            </span>
          </button>
        </div>
      </div>
      <p v-else class="docs__empty">{{ t('docsPage.pickFile') }}</p>
    </section>

    <KModal v-model="editorOpen" :title="editingId ? t('docsPage.editLink') : t('docsPage.addLink')" width="520px">
      <form class="docs__editor" @submit.prevent="saveLink">
        <KField v-model="urlInput" :label="t('docsPage.linkUrl')" :placeholder="t('docsPage.linkUrlPlaceholder')" />
        <KField v-model="titleInput" :label="t('docsPage.linkTitle')" :placeholder="parsedUrl ? describeDocLink(parsedUrl).label : ''" />
        <p class="docs__index-msg">{{ t('docsPage.linkHint') }}</p>
        <p v-if="editorError" class="docs__index-msg docs__index-msg--error">{{ editorError }}</p>
        <!-- A hidden submit so Enter in either field saves. -->
        <button type="submit" hidden />
      </form>
      <template #controls>
        <KBtn variant="ghost" @click="editorOpen = false">{{ t('docsPage.cancel') }}</KBtn>
        <KBtn variant="primary" :loading="saving" :disabled="!urlInput.trim()" @click="saveLink">
          {{ saving ? t('docsPage.saving') : t('docsPage.save') }}
        </KBtn>
      </template>
    </KModal>
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
.docs__image { padding: var(--k-sp-3); img { display: block; max-width: 100%; height: auto; } }
.docs__empty { color: var(--k-muted); font-size: 13px; padding: var(--k-sp-3); &--error { color: var(--k-danger); } }
.docs__index { display: flex; flex-direction: column; gap: 4px; padding-bottom: var(--k-sp-2); border-bottom: 1px solid var(--k-line); }
.docs__index-head { font-size: 12px; font-weight: 600; color: var(--k-muted); text-transform: uppercase; letter-spacing: 0.04em; }
.docs__index-state { margin: 0; font-size: 13px; color: var(--k-text); }
.docs__reindex { align-self: flex-start; background: none; border: 1px solid var(--k-line); color: var(--k-text); cursor: pointer; padding: 4px 8px; border-radius: 6px; font: inherit; }
.docs__reindex:hover:not(:disabled) { background: var(--k-surface2); }
.docs__reindex:disabled { opacity: 0.6; cursor: default; }
.docs__index-msg { margin: 0; font-size: 12px; color: var(--k-muted); &--error { color: var(--k-danger); } }

// ── Links ──
.docs__links { display: flex; flex-direction: column; gap: 4px; padding-bottom: var(--k-sp-2); border-bottom: 1px solid var(--k-line); min-height: 0; max-height: 40%; }
.docs__links-head { display: flex; align-items: center; justify-content: space-between; }
.docs__link-list { list-style: none; margin: 0; padding: 0; overflow: auto; display: flex; flex-direction: column; gap: 2px; }
.docs__link { display: flex; align-items: center; gap: 8px; width: 100%; text-align: left; background: none; border: 1px solid transparent; color: var(--k-text); cursor: pointer; padding: 4px 6px; border-radius: 6px; font: inherit; }
.docs__link:hover { background: var(--k-surface2); }
.docs__link--on { background: var(--k-surface2); border-color: var(--k-line); }
.docs__link-text { display: flex; flex-direction: column; min-width: 0; }
.docs__link-title { font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.docs__link-host { font-size: 11px; color: var(--k-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

// Provider badge: one colour per brand so a list of links is scanned by shape. `web` stays neutral.
.docs__badge, .docs__card-thumb {
  --docs-brand: var(--k-muted);
  --docs-on-brand: #fff;
  &[data-provider='google-docs'] { --docs-brand: #4285f4; }
  &[data-provider='google-sheets'] { --docs-brand: #0f9d58; }
  &[data-provider='google-slides'] { --docs-brand: #f4b400; }
  &[data-provider='google-drawings'] { --docs-brand: #db4437; }
  &[data-provider='google-forms'] { --docs-brand: #7248b9; }
  &[data-provider='google-drive'] { --docs-brand: #1fa463; }
  &[data-provider='figma'] { --docs-brand: #a259ff; }
  &[data-provider='youtube'] { --docs-brand: #ff0033; }
  &[data-provider='loom'] { --docs-brand: #625df5; }
  &[data-provider='miro'] { --docs-brand: #e6b800; }
  &[data-provider='claude'] { --docs-brand: #d97757; }
  // Monochrome brands: drawn in the text colour, so the glyph takes the background's.
  &[data-provider='notion'], &[data-provider='github'] { --docs-brand: var(--k-text); --docs-on-brand: var(--k-bg); }
}
.docs__badge { flex: none; display: inline-flex; align-items: center; justify-content: center; width: 22px; height: 22px; border-radius: 5px; font-size: 10px; font-weight: 800; color: var(--docs-on-brand); background: var(--docs-brand); }

// ── Viewer ──
// Closed, the popover's UA styles (display:none, fixed, centred, bordered) are all undone so
// the viewer is an ordinary block filling the preview pane; open, it covers the window.
.docs__viewer {
  position: static; inset: auto; margin: 0; padding: 0; border: 0; overflow: visible;
  display: flex; flex-direction: column; width: auto; height: 100%; min-height: 0;
  color: inherit; background: var(--k-bg);
}
.docs__viewer:popover-open { position: fixed; inset: 0; width: 100vw; height: 100vh; padding: var(--k-sp-3); }
.docs__viewer-bar { display: flex; align-items: center; gap: 8px; padding-bottom: var(--k-sp-2); border-bottom: 1px solid var(--k-line); }
.docs__viewer-title { display: flex; flex-direction: column; min-width: 0; flex: 1; strong { font-size: 14px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; } }
.docs__open { flex: none; font-size: 12px; color: var(--k-text); text-decoration: none; border: 1px solid var(--k-line); border-radius: var(--k-r); padding: 5px 9px; white-space: nowrap; }
.docs__open:hover { border-color: var(--k-text); }
.docs__open--primary { border-color: var(--k-accent); color: var(--k-accent); }
.docs__viewer-body { position: relative; flex: 1; min-height: 0; display: flex; flex-direction: column; padding-top: var(--k-sp-2); }
// White, not the theme background: embedded pages assume a light canvas behind them.
.docs__frame { flex: 1; width: 100%; min-height: 0; border: 1px solid var(--k-line); border-radius: var(--k-r); background: #fff; }
.docs__frame-hint { margin: 4px 0 0; font-size: 11px; color: var(--k-muted); }
.docs__blocked { max-width: 520px; padding: var(--k-sp-4) var(--k-sp-3); font-size: 13px; color: var(--k-muted); h3 { margin: 0 0 8px; font-size: 15px; color: var(--k-text); } p { margin: 0 0 8px; } }
.docs__blocked-actions { display: flex; align-items: center; gap: 10px; margin-top: var(--k-sp-3); }

// ── Gallery ──
.docs__cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: var(--k-sp-3); padding: 0 var(--k-sp-3) var(--k-sp-3); }
.docs__card { display: flex; flex-direction: column; padding: 0; text-align: left; background: var(--k-surface); border: 1px solid var(--k-line); border-radius: var(--k-r-lg); overflow: hidden; cursor: pointer; font: inherit; color: var(--k-text); transition: border-color 0.12s; }
.docs__card:hover { border-color: var(--k-text); }
// The miniature: the page laid out at 4× the tile and scaled down, so it reads as a page
// rather than a zoomed-in corner. Inert — the card, not the page, takes the click.
.docs__card-thumb { position: relative; display: flex; align-items: center; justify-content: center; height: 140px; overflow: hidden; background: color-mix(in srgb, var(--docs-brand) 14%, var(--k-surface)); border-bottom: 1px solid var(--k-line); }
.docs__card-frame { position: absolute; top: 0; left: 0; width: 400%; height: 400%; transform: scale(0.25); transform-origin: 0 0; border: 0; background: #fff; pointer-events: none; }
.docs__card-mark { font-size: 28px; font-weight: 800; color: var(--docs-brand); }
.docs__card-meta { display: flex; align-items: center; gap: 8px; padding: 8px 10px; min-width: 0; }
.docs__editor { display: flex; flex-direction: column; gap: 12px; }
</style>
