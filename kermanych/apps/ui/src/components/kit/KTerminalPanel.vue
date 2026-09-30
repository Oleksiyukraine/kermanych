<script setup lang="ts">
// The integrated terminal panel under the page (VS Code style): a tab per shell of the
// selected project, «+» for another, 🗑 to end the active one, ✕ to hide the panel. Shells
// of other projects keep running and come back with their project. Placement and the
// Ctrl+` toggle live in MainLayout; the shells in the api (stores/terminal.ts).
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { useOrchestrator } from 'stores/orchestrator';
import { useTerminal } from 'stores/terminal';
import { useResizablePanel } from '../../composables/useResizablePanel';
import KTerminalView from './KTerminalView.vue';

const store = useOrchestrator();
const terminal = useTerminal();
const { t } = useI18n();

const project = computed(() => store.projects.find((p) => p.id === store.selectedProjectId));
const bound = computed(() => !!project.value?.localRepoPath);
const tabs = computed(() => terminal.projectTerminals(project.value?.id));
const activeId = computed(() => terminal.activeFor(project.value?.id));

// The page above keeps at least this much; the header and footer take 90px (MainLayout).
const MIN_PAGE = 160;
const { size: height, resizing, startResize, onKeydown } = useResizablePanel({
  storageKey: 'kermanych.terminal.height',
  defaultSize: 280,
  min: 120,
  edge: 'top',
  max: () => window.innerHeight - 90 - MIN_PAGE,
});

function newTerminal(): void {
  if (project.value && bound.value) void terminal.open(project.value.id);
}

function killActive(): void {
  if (activeId.value) terminal.kill(activeId.value);
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
          :class="{ 'k-term__tab--on': tab.id === activeId }"
          :aria-selected="tab.id === activeId"
          :title="tab.cwd"
          @click="terminal.setActive(tab.projectId, tab.id)"
        >{{ t('terminal.tabLabel', { n: i + 1, shell: tab.shell }) }}</button>
      </div>
      <span class="k-term__spacer"></span>
      <button
        type="button"
        class="k-term__btn"
        :disabled="!bound"
        v-tip="t('terminal.new')"
        :aria-label="t('terminal.new')"
        @click="newTerminal"
      >+</button>
      <button
        type="button"
        class="k-term__btn"
        :disabled="!activeId"
        v-tip="t('terminal.kill')"
        :aria-label="t('terminal.kill')"
        @click="killActive"
      >🗑</button>
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
      <p v-else-if="!tabs.length && !bound" class="k-term__blank">{{ t('terminal.notBound') }}</p>
      <div v-else-if="!tabs.length" class="k-term__blank">
        <span>{{ t('terminal.empty') }}</span>
        <button type="button" class="k-term__link" @click="newTerminal">{{ t('terminal.new') }}</button>
      </div>
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
.k-term {
  position: relative;
  display: flex;
  flex-direction: column;
  flex: none;
  min-height: 0;
  background: var(--k-bg);
  border-top: 1px solid var(--k-line-strong);
}

// A 7px grab strip straddling the top rule, like the page's column seams.
.k-term__seam {
  position: absolute;
  top: -4px;
  left: 0;
  right: 0;
  z-index: 2;
  height: 7px;
  cursor: row-resize;
  touch-action: none;

  &:hover,
  &:focus-visible {
    background: var(--k-accent);
    opacity: 0.5;
    outline: none;
  }
}
.k-term--resizing {
  user-select: none;
}
.k-term--resizing .k-term__seam {
  background: var(--k-accent);
  opacity: 0.5;
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

.k-term__body {
  position: relative;
  flex: 1;
  min-height: 0;
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
