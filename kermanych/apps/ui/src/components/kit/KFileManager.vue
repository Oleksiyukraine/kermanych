<script setup lang="ts">
// Global file-manager dock — the worktree tree + a read-only viewer for the selected
// session, lifted out of the Агенти detail panel's old «Файли» tab so it can stand beside
// any view (VS Code / Zed style). It reads the selection straight from the store: whichever
// session is open in Агенти is the one whose files this shows. Shell-level placement (which
// side, whether it is open) lives in the store; this component owns only the tree.
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { useOrchestrator } from 'stores/orchestrator';
import type { TreeEntry, FileContent } from '@kermanych/core';
import KFileTree from './KFileTree.vue';
import KFileView from './KFileView.vue';

const store = useOrchestrator();
const { t } = useI18n();

const selectedSession = computed(() =>
  store.sessions.find((s) => s.id === store.selectedSessionId),
);

// A retired worktree keeps `worktree: true` but loses its `worktreePath`; there is then no
// directory to read, so the panel shows a calm empty-state instead of an ENOENT error —
// mirrors the Зміни pane's own worktree-gone guard.
const worktreeGone = computed(
  () => !!selectedSession.value?.worktree && !selectedSession.value.worktreePath,
);

// The tree loads one level at a time: the root when the session opens, deeper levels lazily
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

function loadTreeLevel(path: string): Promise<TreeEntry[]> {
  const id = store.selectedSessionId;
  return id ? store.sessionTree(id, path) : Promise.resolve([]);
}

async function loadTreeRoot(id: string): Promise<void> {
  treeError.value = null;
  treeLoading.value = true;
  try {
    treeRoot.value = await store.sessionTree(id, '');
  } catch (e) {
    treeError.value = e instanceof Error ? e.message : String(e);
  } finally {
    treeLoading.value = false;
  }
}

async function openTreeFileAt(path: string): Promise<void> {
  const id = store.selectedSessionId;
  if (!id) return;
  const run = ++treeFileRun;
  openTreeFile.value = path;
  treeFileMaximized.value = true;
  treeFile.value = null;
  treeFileError.value = null;
  treeFileLoading.value = true;
  try {
    const f = await store.sessionFile(id, path);
    if (run !== treeFileRun) return;
    treeFile.value = f;
  } catch (e) {
    if (run !== treeFileRun) return;
    treeFileError.value = e instanceof Error ? e.message : String(e);
  } finally {
    if (run === treeFileRun) treeFileLoading.value = false;
  }
}

function closeTreeFile(): void {
  openTreeFile.value = null;
  treeFile.value = null;
  treeFileError.value = null;
  treeFileLoading.value = false;
  treeFileMaximized.value = false;
  treeFileRun++;
}

function toggleTreeFileMaximized(): void {
  treeFileMaximized.value = !treeFileMaximized.value;
}

// Escape leaves the full-screen viewer without reaching for the mouse; it only fires while the
// overlay is actually up, so it never steals the key from anything else.
function onKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape' && openTreeFile.value && treeFileMaximized.value) {
    e.preventDefault();
    closeTreeFile();
  }
}
onMounted(() => window.addEventListener('keydown', onKeydown));
onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown));

watch(
  () => store.selectedSessionId,
  (id) => {
    closeTreeFile();
    treeRoot.value = [];
    treeError.value = null;
    if (!id || worktreeGone.value) return;
    void loadTreeRoot(id);
  },
  { immediate: true },
);
</script>

<template>
  <aside class="k-fm">
    <header class="k-fm__head">
      <span class="k-fm__title">{{ t('fileManager.title') }}</span>
      <span
        v-if="selectedSession"
        class="k-fm__session mono"
        :title="selectedSession.name"
      >{{ selectedSession.branch || selectedSession.name }}</span>
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
      <div v-if="!selectedSession" class="k-fm__blank">
        <p class="k-fm__blank-text">{{ t('fileManager.noSession') }}</p>
      </div>
      <div v-else-if="worktreeGone" class="k-fm__blank">
        <span class="k-fm__blank-eyebrow mono">{{ t('agents.changes.historyEyebrow') }}</span>
        <p class="k-fm__blank-text">{{ t('agents.files.gone') }}</p>
      </div>
      <p v-else-if="treeLoading" class="k-fm__msg mono">{{ t('agents.changes.preparing') }}</p>
      <p v-else-if="treeError" class="k-fm__error" role="alert">{{ treeError }}</p>
      <template v-else>
        <KFileView
          v-if="openTreeFile && !treeFileMaximized"
          class="k-fm__view"
          :path="openTreeFile"
          :file="treeFile"
          :loading="treeFileLoading"
          :error="treeFileError"
          :maximized="false"
          @close="closeTreeFile"
          @toggle-maximize="toggleTreeFileMaximized"
        />
        <KFileTree
          v-show="!openTreeFile"
          class="k-fm__tree"
          :entries="treeRoot"
          base=""
          :selected="openTreeFile"
          :load="loadTreeLevel"
          @open="openTreeFileAt"
        />
      </template>
    </div>

    <!-- Full-screen viewer — the default when a file is clicked. It sits above everything via a
         backdrop; clicking the backdrop drops it back into the dock (minimize), the ✕ clears it.
         Teleported to <body> so no ancestor clip or stacking context can cage it. -->
    <Teleport to="body">
      <div
        v-if="openTreeFile && treeFileMaximized"
        class="k-fm-overlay"
        @click.self="toggleTreeFileMaximized"
      >
        <KFileView
          class="k-fm-overlay__view"
          :path="openTreeFile"
          :file="treeFile"
          :loading="treeFileLoading"
          :error="treeFileError"
          :maximized="true"
          @close="closeTreeFile"
          @toggle-maximize="toggleTreeFileMaximized"
        />
      </div>
    </Teleport>
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

.k-fm__view {
  flex: 1;
  min-height: 0;
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

// Full-screen viewer layer — the one shadowed surface this component owns. A dimmed backdrop
// over the whole viewport with the file panel centred; the panel caps at 1400px so the reading
// column stays sane on ultrawide displays while still dwarfing the 340px dock it replaces.
.k-fm-overlay {
  position: fixed;
  inset: 0;
  z-index: 5000;
  display: flex;
  padding: 32px;
  background: rgba(0, 0, 0, 0.62);
}
.k-fm-overlay__view {
  flex: 1;
  min-width: 0;
  min-height: 0;
  max-width: 1400px;
  margin: 0 auto;
  background: var(--k-bg);
  border: 1px solid var(--k-line-strong);
  border-radius: var(--k-r-lg);
  box-shadow: var(--k-shadow-modal);
  overflow: hidden;
}
</style>
