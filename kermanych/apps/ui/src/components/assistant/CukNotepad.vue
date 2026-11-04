<template>
  <!-- ЦУК's notepad (docs/specs/2026-11-04-cuk-control-console.md, decisions 6 and 8): the current
       workspace's «Список дій» — the very list the Огляд tile shows — on a small ruled notebook
       page with a ringed binding. Built from theme tokens only, so it is a notebook in every
       theme. -->
  <aside class="note" :aria-label="t('cuk.notes.title')">
    <div class="note__binding" aria-hidden="true">
      <span v-for="n in RINGS" :key="n" class="note__ring"></span>
    </div>
    <header class="note__head">
      <span class="note__title mono">{{ t('cuk.notes.title') }}</span>
      <span v-if="workspace" class="note__ws mono">{{ workspace.icon ? `${workspace.icon} ` : '' }}{{ workspace.name }}</span>
    </header>
    <HomeTodoWidget v-if="workspaceId" class="note__page" :workspace-id="workspaceId" variant="notebook" />
    <p v-else class="note__page note__blank">{{ t('cuk.notes.noWorkspace') }}</p>
  </aside>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { useOrchestrator } from 'stores/orchestrator';
import { useProjects } from 'stores/projects';
import HomeTodoWidget from 'components/home/HomeTodoWidget.vue';

// How many rings hold the page: enough to read as a binding at ~300 px, few enough not to
// turn into a zipper.
const RINGS = 9;

const { t } = useI18n();
const orchestrator = useOrchestrator();
const projects = useProjects();

const workspaceId = computed(() => orchestrator.selectedWorkspaceId);
const workspace = computed(() => (workspaceId.value ? projects.workspaceById.get(workspaceId.value) : undefined));
</script>

<style scoped lang="scss">
.note {
  // The notebook skin's margin (HomeTodoWidget `--nb-margin`), repeated for the header so the
  // title starts where the rows do.
  --note-margin: 34px;
  position: relative;
  display: flex;
  flex-direction: column;
  min-height: 0;
  height: 100%;
  // Room above the page for the rings to rise out of it.
  padding-top: 9px;
}

// The binding: a row of rings that rise above the page's top edge and pass through punched
// holes, the way a spiral notebook's wire does.
.note__binding {
  position: absolute;
  z-index: 1;
  top: 0;
  left: var(--k-sp-4);
  right: var(--k-sp-4);
  display: flex;
  justify-content: space-between;
  pointer-events: none;
}

.note__ring {
  position: relative;
  width: 7px;
  height: 20px;
  border-radius: 4px;
  border: 1.5px solid var(--k-muted);
  background: linear-gradient(to right, var(--k-surface2), var(--k-line-strong));
  box-shadow: 0 1px 0 color-mix(in srgb, #000 35%, transparent);

  // The punched hole the ring passes through, on the page just under the ring's foot.
  &::after {
    content: '';
    position: absolute;
    z-index: -1;
    left: 50%;
    bottom: -4px;
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--k-canvas);
    transform: translateX(-50%);
  }
}

.note__head {
  flex: none;
  display: flex;
  align-items: baseline;
  gap: var(--k-sp-2);
  min-width: 0;
  padding: 22px var(--k-sp-3) var(--k-sp-2) calc(var(--note-margin) + var(--k-sp-2));
  border: var(--k-rule-thin) solid var(--k-line-strong);
  border-bottom: none;
  border-radius: var(--k-r-lg) var(--k-r-lg) 0 0;
  // Opaque, like paper: in the narrow layout the page slides over ЦУК's transcript.
  background: var(--k-surface);
}

.note__title {
  font-size: var(--k-fs-xs);
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: var(--k-text);
}

.note__ws {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--k-fs-xs);
  color: var(--k-faint);
}

.note__page {
  flex: 1;
  min-height: 0;
  border: var(--k-rule-thin) solid var(--k-line-strong);
  border-top: none;
  border-radius: 0 0 var(--k-r-lg) var(--k-r-lg);
  background: var(--k-surface);
  box-shadow: var(--k-shadow-toast);
  overflow: hidden;
}

.note__blank {
  margin: 0;
  padding: var(--k-sp-3) var(--k-sp-3) var(--k-sp-3) calc(var(--note-margin) + var(--k-sp-2));
  font-size: var(--k-fs-sm);
  line-height: 1.5;
  color: var(--k-muted);
}
</style>
