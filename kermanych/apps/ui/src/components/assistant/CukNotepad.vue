<template>
  <!-- ЦУК's notepad (docs/specs/2026-11-04-cuk-control-console.md, decisions 6 and 8): the current
       workspace's «Список дій» — the very list the Огляд tile shows — on the top sheet of a small
       tear-off pad: a glued strip with a perforation under it, ruled paper, a few sheets showing
       beneath. Built from theme tokens only, so it is a pad in every theme. -->
  <aside class="note" :aria-label="t('cuk.notes.title')">
    <header class="note__head">
      <span class="note__glue" aria-hidden="true"></span>
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
  // The glued edge the sheets hang from.
  --note-glue: 14px;
  display: flex;
  flex-direction: column;
  min-height: 0;
  height: 100%;
  // Room under the page for the sheets beneath it to show.
  padding-bottom: 6px;
}

.note__head {
  position: relative;
  flex: none;
  display: flex;
  align-items: baseline;
  gap: var(--k-sp-2);
  min-width: 0;
  padding: calc(var(--note-glue) + var(--k-sp-3)) var(--k-sp-3) var(--k-sp-2) calc(var(--note-margin) + var(--k-sp-2));
  border: var(--k-rule-thin) solid var(--k-line-strong);
  border-bottom: none;
  border-radius: var(--k-r-lg) var(--k-r-lg) 0 0;
  // Opaque, like paper: in the narrow layout the page slides over ЦУК's transcript.
  background: var(--k-surface);
  overflow: hidden;
}

// The glued strip across the top, and the perforation the sheet tears off along.
.note__glue {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  height: var(--note-glue);
  background:
    repeating-linear-gradient(to right, var(--k-line-strong) 0 6px, transparent 6px 10px) bottom / 100% 1px no-repeat,
    linear-gradient(to bottom, color-mix(in srgb, #fff 6%, transparent), transparent) top / 100% 100% no-repeat,
    var(--k-surface2);
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

// The top sheet. The two offset edges under it are the sheets beneath — what makes it read as
// a pad rather than a panel.
.note__page {
  flex: 1;
  min-height: 0;
  border: var(--k-rule-thin) solid var(--k-line-strong);
  border-top: none;
  border-radius: 0 0 var(--k-r-lg) var(--k-r-lg);
  background: var(--k-surface);
  box-shadow:
    0 3px 0 -1px var(--k-surface2),
    0 3px 0 0 var(--k-line),
    0 6px 0 -2px var(--k-surface2),
    0 6px 0 -1px var(--k-line),
    var(--k-shadow-toast);
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
