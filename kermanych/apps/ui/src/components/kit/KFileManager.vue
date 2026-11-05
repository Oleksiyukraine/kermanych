<script setup lang="ts">
// Global file-manager dock — a directory tree + a read-only viewer, lifted out of the Агенти
// detail panel's old «Файли» tab so it can stand beside any view (VS Code / Zed style). It
// reads the selection straight from the store: the session open in Агенти shows its
// worktree; with no session selected, the selected project shows its own checkout. Shell-level
// placement (which side, whether it is open) lives in the store; this component owns only
// the tree.
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { useOrchestrator } from 'stores/orchestrator';
import type { TreeEntry, FileContent } from '@kermanych/core';
import type { FileDiff } from '../../lib/api';
import { useFileTreeKeys } from '../../composables/useFileTreeKeys';
import { useFullscreenPopover } from '../../composables/useFullscreenPopover';
import KFileTree from './KFileTree.vue';
import KFileView from './KFileView.vue';

const store = useOrchestrator();
const { t } = useI18n();

const selectedSession = computed(() =>
  store.sessions.find((s) => s.id === store.selectedSessionId),
);
const selectedProject = computed(() =>
  store.projects.find((p) => p.id === store.selectedProjectId),
);

// A retired worktree keeps `worktree: true` but loses its `worktreePath`; there is then no
// directory to read, so the panel shows a calm empty-state instead of an ENOENT error —
// mirrors the Зміни pane's own worktree-gone guard.
const worktreeGone = computed(
  () => !!selectedSession.value?.worktree && !selectedSession.value.worktreePath,
);
// Without a session the project's checkout is read, which needs a local binding.
const projectUnbound = computed(
  () => !selectedSession.value && !!selectedProject.value && !selectedProject.value.localRepoPath,
);

// Where the tree comes from: the selected session wins, else the selected project. null
// while nothing is selected or the directory is unreadable (worktree gone / unbound).
type Source = { kind: 'session' | 'project'; id: string };
const source = computed<Source | null>(() => {
  if (selectedSession.value) {
    return worktreeGone.value ? null : { kind: 'session', id: selectedSession.value.id };
  }
  if (selectedProject.value) {
    return projectUnbound.value ? null : { kind: 'project', id: selectedProject.value.id };
  }
  return null;
});
// A string key so the watcher reloads only on a real source change, not on every
// sessions/projects push that rebuilds the object.
const sourceKey = computed(() => (source.value ? `${source.value.kind}:${source.value.id}` : ''));

// The tree loads one level at a time: the root when the source opens, deeper levels lazily
// through loadTreeLevel as KFileTree expands folders. Opening a file fetches its body into
// the viewer, ordered by treeFileRun so a slow read cannot overwrite a newer one.
const treeRoot = ref<TreeEntry[]>([]);
const treeLoading = ref(false);
const treeError = ref<string | null>(null);
const openTreeFile = ref<string | null>(null);
const treeFile = ref<FileContent | null>(null);
const treeFileLoading = ref(false);
const treeFileError = ref<string | null>(null);
// A clicked file opens full-screen by default — the 340px dock was too cramped to read in.
// «Minimize» drops it back into the dock inline; «close» clears it. State, not a route, so the
// tree selection and the viewer stay in lockstep.
const treeFileMaximized = ref(false);
let treeFileRun = 0;
// The opened file's diff against the session's base, for the viewer's ± — read beside the
// body, under the same run counter. A project checkout has no base, so there the viewer gets
// no diff prop at all and shows no ±.
const treeDiff = ref<FileDiff | null>(null);
const treeDiffLoading = ref(false);
const treeDiffProp = computed(() => (source.value?.kind === 'session' ? treeDiff.value : undefined));

function listLevel(src: Source, path: string): Promise<TreeEntry[]> {
  return src.kind === 'session' ? store.sessionTree(src.id, path) : store.projectTree(src.id, path);
}

function loadTreeLevel(path: string): Promise<TreeEntry[]> {
  return source.value ? listLevel(source.value, path) : Promise.resolve([]);
}

async function loadTreeRoot(src: Source): Promise<void> {
  const key = sourceKey.value;
  treeError.value = null;
  treeLoading.value = true;
  try {
    const entries = await listLevel(src, '');
    if (key === sourceKey.value) treeRoot.value = entries;
  } catch (e) {
    if (key === sourceKey.value) treeError.value = e instanceof Error ? e.message : String(e);
  } finally {
    if (key === sourceKey.value) treeLoading.value = false;
  }
}

// The open file (and whether it is full screen) survives a reload and a restart, per source:
// each session's worktree and each project's checkout remembers its own. Written on open, on
// full screen ↔ dock, cleared on a close the operator asked for; a source switch keeps it.
type SavedView = { path: string; maximized: boolean };
const viewKey = (key: string) => `kermanych.fileManager.open.${key}`;
function readView(key: string): SavedView | null {
  if (!key) return null;
  try {
    const v = JSON.parse(localStorage.getItem(viewKey(key)) ?? 'null') as Partial<SavedView> | null;
    return v && typeof v.path === 'string' && v.path ? { path: v.path, maximized: v.maximized === true } : null;
  } catch {
    return null;
  }
}
function writeView(key: string, v: SavedView | null): void {
  if (!key) return;
  try {
    if (v) localStorage.setItem(viewKey(key), JSON.stringify(v));
    else localStorage.removeItem(viewKey(key));
  } catch {
    /* storage unavailable: the viewer still works, it just is not restored */
  }
}
function rememberView(): void {
  writeView(sourceKey.value, openTreeFile.value ? { path: openTreeFile.value, maximized: treeFileMaximized.value } : null);
}

// A clicked file opens full screen (the 340px dock is too cramped to read in); a restored
// one opens the way it was left.
async function openTreeFileAt(path: string, maximized = true): Promise<void> {
  const src = source.value;
  if (!src) return;
  const run = ++treeFileRun;
  openTreeFile.value = path;
  treeFileMaximized.value = maximized;
  rememberView();
  treeFile.value = null;
  treeFileError.value = null;
  treeFileLoading.value = true;
  treeDiff.value = null;
  treeDiffLoading.value = src.kind === 'session';
  if (src.kind === 'session') void loadTreeDiff(src.id, path, run);
  try {
    const f = src.kind === 'session' ? await store.sessionFile(src.id, path) : await store.projectFile(src.id, path);
    if (run !== treeFileRun) return;
    treeFile.value = f;
  } catch (e) {
    if (run !== treeFileRun) return;
    treeFileError.value = e instanceof Error ? e.message : String(e);
    // A remembered file that is gone (deleted, renamed) is not offered again next time.
    writeView(sourceKey.value, null);
  } finally {
    if (run === treeFileRun) treeFileLoading.value = false;
  }
}

// A diff that cannot be read leaves the ± disabled, like an unchanged file: the viewer's body
// is what this panel is for, and it does not depend on the diff.
async function loadTreeDiff(id: string, path: string, run: number): Promise<void> {
  try {
    const d = await store.fileDiff(id, path);
    if (run === treeFileRun) treeDiff.value = d;
  } catch {
    // stays null
  } finally {
    if (run === treeFileRun) treeDiffLoading.value = false;
  }
}

// Raw bytes for the viewer's preview mode, from the same source as the tree.
function loadRaw(path: string): Promise<Blob> {
  const src = source.value;
  if (!src) return Promise.reject(new Error('no source'));
  return src.kind === 'session' ? store.sessionRaw(src.id, path) : store.projectRaw(src.id, path);
}

// Keyboard in the tree, IDE-style (composables/useFileTreeKeys).
const treeEl = ref<{ $el: HTMLElement } | null>(null);
const { onTreeKeydown, focusTree } = useFileTreeKeys(treeEl);

// `refocus` for a close the operator asked for (✕, Escape); a source switch clears the viewer
// without pulling focus away from wherever it is.
function closeTreeFile(refocus = true): void {
  const closed = openTreeFile.value;
  if (refocus) writeView(sourceKey.value, null);
  openTreeFile.value = null;
  treeFile.value = null;
  treeFileError.value = null;
  treeFileLoading.value = false;
  treeDiff.value = null;
  treeDiffLoading.value = false;
  treeFileMaximized.value = false;
  treeFileRun++;
  if (refocus && closed) focusTree(closed);
}

// A link in a rendered doc opens its target in the same place, docked or full screen.
function openLinkedFile(path: string): void {
  void openTreeFileAt(path, treeFileMaximized.value);
}

const viewHost = ref<HTMLElement | null>(null);
useFullscreenPopover(viewHost, treeFileMaximized);

function toggleTreeFileMaximized(): void {
  treeFileMaximized.value = !treeFileMaximized.value;
  rememberView();
}

// Escape closes the viewer without reaching for the mouse: always while the full-screen
// overlay is up, and in the dock while focus is inside this panel — so an Escape meant for
// something else (the chat composer, a menu) never closes the file. Focus returns to the
// file's row in the tree (closeTreeFile).
const fmEl = ref<HTMLElement | null>(null);
function onKeydown(e: KeyboardEvent): void {
  if (e.key !== 'Escape' || e.defaultPrevented || !openTreeFile.value) return;
  const inPanel = !!fmEl.value && fmEl.value.contains(e.target as Node);
  if (!treeFileMaximized.value && !inPanel) return;
  e.preventDefault();
  closeTreeFile();
}
onMounted(() => window.addEventListener('keydown', onKeydown));
onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown));

watch(
  sourceKey,
  () => {
    closeTreeFile(false);
    treeRoot.value = [];
    treeError.value = null;
    treeLoading.value = false;
    if (source.value) {
      void loadTreeRoot(source.value);
      // This source's file from last time (a reload, a restart, or coming back to the agent).
      const saved = readView(sourceKey.value);
      if (saved) void openTreeFileAt(saved.path, saved.maximized);
    }
  },
  { immediate: true },
);
</script>

<template>
  <aside ref="fmEl" class="k-fm">
    <header class="k-fm__head">
      <span class="k-fm__title">{{ t('fileManager.title') }}</span>
      <span
        v-if="selectedSession"
        class="k-fm__session mono"
        :title="selectedSession.name"
      >{{ selectedSession.branch || selectedSession.name }}</span>
      <span
        v-else-if="selectedProject"
        class="k-fm__session mono"
        :title="selectedProject.localRepoPath || selectedProject.name"
      >{{ selectedProject.name }}</span>
      <span class="k-fm__spacer"></span>
      <button
        type="button"
        class="k-fm__close"
        :aria-label="t('fileManager.close')"
        :title="t('fileManager.close')"
        @click="store.toggleFileManager(store.fileManagerSide)"
      >✕</button>
    </header>
    <div class="k-fm__body">
      <!-- The open file: docked here, or — the default when a file is clicked — full screen
           over the whole window (useFullscreenPopover: the same viewer, so its mode, ± and
           scroll survive the switch). The collapse button drops it back into the dock, the ✕
           or Escape clears it. role="dialog" while full screen parks the session browser's
           native view (useOverlayOpen). -->
      <div
        v-if="openTreeFile"
        ref="viewHost"
        popover="manual"
        class="k-fm__view"
        :role="treeFileMaximized ? 'dialog' : undefined"
      >
        <KFileView
          :path="openTreeFile"
          :file="treeFile"
          :loading="treeFileLoading"
          :error="treeFileError"
          :maximized="treeFileMaximized"
          :load="loadRaw"
          :diff="treeDiffProp"
          :diff-loading="treeDiffLoading"
          @close="closeTreeFile()"
          @toggle-maximize="toggleTreeFileMaximized"
          @open="openLinkedFile"
        />
      </div>
      <div v-if="!selectedSession && !selectedProject" class="k-fm__blank">
        <p class="k-fm__blank-text">{{ t('fileManager.noSelection') }}</p>
      </div>
      <div v-else-if="worktreeGone" class="k-fm__blank">
        <span class="k-fm__blank-eyebrow mono">{{ t('agents.changes.historyEyebrow') }}</span>
        <p class="k-fm__blank-text">{{ t('agents.files.gone') }}</p>
      </div>
      <div v-else-if="projectUnbound" class="k-fm__blank">
        <p class="k-fm__blank-text">{{ t('fileManager.notBound') }}</p>
      </div>
      <!-- The tree stays mounted (v-show) under an open file, so its expanded folders are
           there again when the file closes. A file restored while the tree loads shows alone. -->
      <p v-else-if="treeLoading && !openTreeFile" class="k-fm__msg mono">{{ t('agents.changes.preparing') }}</p>
      <p v-else-if="treeError && !openTreeFile" class="k-fm__error" role="alert">{{ treeError }}</p>
      <KFileTree
        v-else-if="!treeLoading && !treeError"
        v-show="!openTreeFile"
        ref="treeEl"
        class="k-fm__tree k-scroller"
        tabindex="0"
        @keydown="onTreeKeydown"
        :entries="treeRoot"
        base=""
        :selected="openTreeFile"
        :load="loadTreeLevel"
        @open="openTreeFileAt"
      />
    </div>
  </aside>
</template>

<style scoped lang="scss">
.k-fm {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  background: var(--k-bg);
  border: 1px solid var(--k-line);
  border-radius: var(--k-r-lg);
  overflow: hidden;
}

.k-fm__head {
  display: flex;
  align-items: center;
  gap: var(--k-sp-2);
  flex: none;
  height: 34px;
  padding: 0 var(--k-sp-2) 0 var(--k-sp-3);
  border-bottom: 1px solid var(--k-line);
}

.k-fm__title {
  font-size: 11px;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: var(--k-muted);
}

.k-fm__session {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--k-fs-xs);
  color: var(--k-faint);
}

.k-fm__spacer {
  flex: 1;
}

.k-fm__close {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  border: none;
  border-radius: var(--k-r);
  background: none;
  color: var(--k-muted);
  cursor: pointer;

  &:hover {
    background: var(--k-surface2);
    color: var(--k-text);
  }
}

.k-fm__body {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
  overflow: hidden;
}

.k-fm__tree {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 8px 6px;
}

// The viewer's host. Closed, the popover's UA styles are undone so it fills the dock; open,
// it covers the window, edge to edge.
.k-fm__view {
  position: static;
  inset: auto;
  flex: 1;
  width: auto;
  height: auto;
  min-height: 0;
  margin: 0;
  padding: 0;
  border: 0;
  overflow: hidden;
  display: flex;
  flex-direction: column;
  color: inherit;
  background: var(--k-bg);

  &:popover-open {
    position: fixed;
    inset: 0;
    width: 100vw;
    height: 100vh;
  }
}

.k-fm__blank {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  justify-content: center;
  gap: 10px;
  height: 100%;
  padding: 0 24px;
}

.k-fm__blank-eyebrow {
  font-size: 11px;
  letter-spacing: 0.2em;
  color: var(--k-muted);
}

.k-fm__blank-text {
  margin: 0;
  font-family: var(--k-font-ui);
  font-size: 14px;
  color: var(--k-muted);
}

.k-fm__msg {
  padding: 12px;
  color: var(--k-muted);
  font-size: var(--k-fs-xs);
}
.k-fm__error {
  padding: 12px;
  color: var(--k-accent);
  font-size: var(--k-fs-xs);
}
</style>
