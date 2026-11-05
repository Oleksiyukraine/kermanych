<script setup lang="ts">
// The integrated terminal panel under the page (VS Code style): a tab per shell of the
// selected project, «+» for another, 🗑 to end the active one, ✕ to hide the panel. Shells
// of other projects keep running and come back with their project. Placement and the
// Ctrl+` toggle live in MainLayout; the shells in the api (stores/terminal.ts).
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { confirmAction } from '../../lib/confirm';
import { useOrchestrator } from 'stores/orchestrator';
import { useTerminal } from 'stores/terminal';
import { usePending } from 'stores/pending';
import { useResizablePanel } from '../../composables/useResizablePanel';
import { useAsyncAction } from '../../composables/useAsyncAction';
import { useLoadPhase } from '../../composables/useLoadPhase';
import KTerminalView from './KTerminalView.vue';
import KSkeleton from './KSkeleton.vue';
import KSpinner from './KSpinner.vue';

const store = useOrchestrator();
const terminal = useTerminal();
const pending = usePending();
const { t } = useI18n();

const project = computed(() => store.projects.find((p) => p.id === store.selectedProjectId));
const bound = computed(() => !!project.value?.localRepoPath);
const tabs = computed(() => terminal.projectTerminals(project.value?.id));
const activeId = computed(() => terminal.activeFor(project.value?.id));
// A spawn in flight for this project (from here or the footer toggle): drawn as a pending tab.
const opening = computed(() => !!project.value && !!terminal.opening[project.value.id]);
// Before the api's list answers, «no terminals» is unknown: skeleton, never the empty text.
// A failed list ack ends the skeleton too (empty text + spawn link), or it would never resolve.
const phase = useLoadPhase(() => !terminal.loaded && !terminal.listFailed);
const activePending = computed(() => !!activeId.value && pending.isPending(`terminal:${activeId.value}`));

// The page above keeps at least this much; the header and footer take 100px (MainLayout), and
// the panel's own bottom inset (var(--k-sp-3)) another 12px.
const MIN_PAGE = 160;
const INSET = 12;
const { size: height, resizing, startResize, onKeydown } = useResizablePanel({
  storageKey: 'kermanych.terminal.height',
  defaultSize: 280,
  min: 120,
  edge: 'top',
  max: () => window.innerHeight - 100 - INSET - MIN_PAGE,
});

// The store refuses a second spawn for the same project while one is in flight.
const { run: newTerminal } = useAsyncAction(async () => {
  if (project.value && bound.value) await terminal.open(project.value.id);
});

// `kill` is fire-and-forget over the socket; the tab stays, dimmed, until the api's `exit`
// removes it from the list.
async function killActive(): Promise<void> {
  const id = activeId.value;
  if (!id || pending.isPending(`terminal:${id}`)) return;
  const ok = await confirmAction({
    title: t('confirmations.killTerminal.title'),
    message: t('confirmations.killTerminal.message'),
    confirmLabel: t('confirmations.label.close'),
  });
  if (!ok || pending.isPending(`terminal:${id}`) || !terminal.terminals.some((x) => x.id === id)) return;
  terminal.kill(id);
  pending.mark(`terminal:${id}`, () => !terminal.terminals.some((x) => x.id === id));
}
</script>

<template>
  <section
    class="k-term"
    :class="{ 'k-term--resizing': resizing }"
    :style="{ height: `${height}px` }"
    :aria-label="t('terminal.title')"
  >
    <div
      class="k-term__seam"
      role="separator"
      aria-orientation="horizontal"
      tabindex="0"
      :aria-label="t('terminal.resize')"
      :aria-valuenow="Math.round(height)"
      @pointerdown="startResize"
      @keydown="onKeydown"
    ></div>
    <header class="k-term__head">
      <span class="k-term__title">{{ t('terminal.title') }}</span>
      <div class="k-term__tabs" role="tablist">
        <button
          v-for="(tab, i) in tabs"
          :key="tab.id"
          type="button"
          role="tab"
          class="k-term__tab mono"
          :class="{
            'k-term__tab--on': tab.id === activeId,
            'k-term__tab--pending': pending.isPending(`terminal:${tab.id}`),
          }"
          :aria-selected="tab.id === activeId"
          :aria-busy="pending.isPending(`terminal:${tab.id}`) || undefined"
          :title="tab.cwd"
          @click="terminal.setActive(tab.projectId, tab.id)"
        ><KSpinner v-if="pending.isPending(`terminal:${tab.id}`)" :size="9" /> {{ t('terminal.tabLabel', { n: i + 1, shell: tab.shell }) }}</button>
        <span v-if="opening" class="k-term__tab k-term__tab--pending mono" role="tab" aria-busy="true" aria-selected="false">
          <KSpinner :size="9" /> {{ t('terminal.opening') }}
        </span>
      </div>
      <span class="k-term__spacer"></span>
      <button
        type="button"
        class="k-term__btn"
        :disabled="!bound || opening"
        :aria-busy="opening || undefined"
        v-tip="t('terminal.new')"
        :aria-label="t('terminal.new')"
        @click="newTerminal()"
      ><KSpinner v-if="opening" :size="10" /><template v-else>+</template></button>
      <button
        type="button"
        class="k-term__btn"
        :disabled="!activeId || activePending"
        :aria-busy="activePending || undefined"
        v-tip="t('terminal.kill')"
        :aria-label="t('terminal.kill')"
        @click="killActive"
      ><KSpinner v-if="activePending" :size="10" /><template v-else>🗑</template></button>
      <button
        type="button"
        class="k-term__btn"
        v-tip="t('terminal.hide')"
        :aria-label="t('terminal.hide')"
        @click="terminal.setPanel(false)"
      >✕</button>
    </header>
    <div class="k-term__body">
      <p v-if="!project" class="k-term__blank">{{ t('terminal.noProject') }}</p>
      <template v-else-if="!tabs.length">
        <p v-if="!bound" class="k-term__blank">{{ t('terminal.notBound') }}</p>
        <KSkeleton v-else-if="phase === 'skeleton' || opening" class="k-term__skeleton" variant="lines" :rows="4" />
        <div v-else-if="phase === 'ready'" class="k-term__blank">
          <span>{{ t('terminal.empty') }}</span>
          <button type="button" class="k-term__link" :disabled="opening" @click="newTerminal()">{{ t('terminal.new') }}</button>
        </div>
      </template>
      <!-- Every tab of the project stays mounted, so switching tabs keeps each screen and its
           scroll position; only the active one is shown. -->
      <KTerminalView
        v-for="tab in tabs"
        v-show="tab.id === activeId"
        :key="tab.id"
        class="k-term__view"
        :terminal-id="tab.id"
        :active="tab.id === activeId"
      />
    </div>
  </section>
</template>

<style scoped lang="scss">
// A card like the sidebar and the file-manager dock: inset from the canvas on the sides and the
// bottom. The top gap is the page's own 12px bottom padding, so it isn't doubled here.
.k-term {
  position: relative;
  display: flex;
  flex-direction: column;
  flex: none;
  box-sizing: border-box;
  min-height: 0;
  margin: 0 var(--k-sp-3) var(--k-sp-3);
  background: var(--k-bg);
  border: 1px solid var(--k-line);
  border-radius: var(--k-r-lg);
}

// The grab strip fills the gap between the page and the card; a thin accent rule in its middle
// lights up on hover, focus and while dragging.
.k-term__seam {
  position: absolute;
  top: calc(-1 * var(--k-sp-3) - 1px);
  left: 0;
  right: 0;
  z-index: 2;
  height: var(--k-sp-3);
  cursor: row-resize;
  touch-action: none;

  &::before {
    content: '';
    position: absolute;
    left: 0;
    right: 0;
    top: 50%;
    height: 2px;
    transform: translateY(-50%);
    background: transparent;
    transition: background 0.12s;
  }
  &:hover::before,
  &:focus-visible::before {
    background: var(--k-accent);
  }
  &:focus-visible {
    outline: none;
  }
}
.k-term--resizing {
  user-select: none;
}
.k-term--resizing .k-term__seam::before {
  background: var(--k-accent);
}

.k-term__head {
  display: flex;
  align-items: center;
  gap: var(--k-sp-2);
  flex: none;
  height: 34px;
  padding: 0 var(--k-sp-2) 0 var(--k-sp-3);
  border-bottom: 1px solid var(--k-line);
}

.k-term__title {
  flex: none;
  font-size: 11px;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: var(--k-muted);
}

.k-term__tabs {
  display: flex;
  gap: 2px;
  min-width: 0;
  overflow-x: auto;
  scrollbar-width: none;
}

.k-term__tab {
  flex: none;
  height: 24px;
  padding: 0 var(--k-sp-2);
  border: none;
  border-bottom: 2px solid transparent;
  background: none;
  color: var(--k-muted);
  font-size: var(--k-fs-xs);
  cursor: pointer;

  &:hover {
    color: var(--k-text);
  }
}
.k-term__tab--on {
  border-bottom-color: var(--k-accent);
  color: var(--k-text);
}
// A shell being started or killed: dimmed with a spinner until the api reports it.
.k-term__tab--pending {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  opacity: 0.6;
}
.k-term__skeleton {
  padding: 6px var(--k-sp-3);
}

.k-term__spacer {
  flex: 1;
}

.k-term__btn {
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
  font-size: var(--k-fs-sm);
  cursor: pointer;

  &:hover:not(:disabled) {
    background: var(--k-surface2);
    color: var(--k-text);
  }
  &:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }
}

// Clips the shells to the card's rounded bottom corners (the frame sits 1px outside).
.k-term__body {
  position: relative;
  flex: 1;
  min-height: 0;
  overflow: hidden;
  border-radius: 0 0 calc(var(--k-r-lg) - 1px) calc(var(--k-r-lg) - 1px);
}

.k-term__view {
  position: absolute;
  inset: 0;
}

.k-term__blank {
  display: flex;
  align-items: center;
  gap: var(--k-sp-2);
  margin: 0;
  padding: var(--k-sp-3) var(--k-sp-4);
  font-family: var(--k-font-ui);
  font-size: 14px;
  color: var(--k-muted);
}

.k-term__link {
  padding: 0;
  border: none;
  background: none;
  color: var(--k-accent);
  font: inherit;
  cursor: pointer;

  &:hover {
    text-decoration: underline;
  }
}
</style>
