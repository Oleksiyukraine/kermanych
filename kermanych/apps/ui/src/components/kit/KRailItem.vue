<script lang="ts">
// The rail tile's view model. MainLayout builds it by joining the CLOUD project list (what
// exists for the whole team) with the LOCAL project rows (what this machine can actually
// run), so the tile renders the binding state without importing either store:
//   bound   — a local row with a localRepoPath; agents can be launched here.
//   unbound — the project exists in the cloud, this machine has no repo for it yet.
//   orphan  — a local row whose cloud project is gone (sync's prune kept it because it
//             still owns sessions); its agents stay usable, nothing new should start.
export type RailProject = {
  id: string;
  name: string;
  color?: string | undefined;
  state: 'bound' | 'unbound' | 'orphan';
};
</script>

<script setup lang="ts">
import { computed } from 'vue';
import { initialsOf } from '../../lib/initials';

// A project tile in the left rail (design-system section 07). Initials stand in for the
// project, the count badge is the number of running agents, and the corner glyph is the
// binding state. Active tile gets surface2 and a 2px accent strip on the left edge.
const props = defineProps<{ project: RailProject; active?: boolean; count?: number }>();

const count = computed(() => props.count ?? 0);

// Ukrainian copy for the two states worth naming; a bound project needs no explanation.
const STATE_HINT: Record<RailProject['state'], string> = {
  bound: '',
  unbound: ' · не прив’язано',
  orphan: ' · поза хмарою',
};

const STATE_GLYPH: Record<RailProject['state'], string> = {
  bound: '',
  unbound: '○',
  orphan: '⚠',
};

const title = computed(() => props.project.name + STATE_HINT[props.project.state]);

// A project stands in for its name with two letters; `·` marks the nameless row rather
// than an empty tile.
const initials = computed(() => initialsOf(props.project.name, '·'));
</script>

<template>
  <button
    class="k-rail"
    :class="{
      'k-rail--active': active,
      'k-rail--colored': !!project.color,
      'k-rail--unbound': project.state === 'unbound',
      'k-rail--orphan': project.state === 'orphan',
    }"
    type="button"
    :title="title"
    :aria-pressed="active"
    :style="project.color ? { '--rail-color': project.color } : undefined"
  >
    <span class="k-rail__initials mono">{{ initials }}</span>
    <span class="k-rail__name">{{ project.name }}</span>
    <span v-if="project.state !== 'bound'" class="k-rail__state mono" aria-hidden="true">{{ STATE_GLYPH[project.state] }}</span>
    <span v-if="count > 0" class="k-rail__count mono">{{ count }}</span>
  </button>
</template>

<style scoped lang="scss">
.k-rail {
  position: relative;
  display: flex;
  align-items: center;
  gap: var(--k-sp-2);
  width: 100%;
  padding: var(--k-sp-1) var(--k-sp-2);
  border: 1px solid transparent;
  background: transparent;
  color: var(--k-muted);
  cursor: pointer;
  border-radius: var(--k-r);
  text-align: left;
  transition: background 0.12s, color 0.12s;

  &:hover:not(.k-rail--active) {
    background: var(--k-surface);
    color: var(--k-text);
  }

  &:focus-visible {
    outline: 1px solid var(--k-accent);
    outline-offset: 1px;
  }
}

.k-rail--active {
  background: var(--k-surface2);
  color: var(--k-text);
}

// initials chip — the project's colour when set, else a neutral surface.
.k-rail__initials {
  flex: none;
  width: 22px;
  height: 22px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: var(--k-fs-xs);
  border-radius: var(--k-r-sm);
  background: var(--k-surface2);
  color: var(--k-muted);
  border: 1px solid var(--k-line-strong);
}

.k-rail--colored .k-rail__initials {
  background: var(--rail-color);
  color: var(--k-on-accent);
  border-color: transparent;
}

.k-rail--active .k-rail__initials {
  color: var(--k-text);
}

.k-rail__name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--k-fs-base);
}

// binding state — a muted glyph (○ no local repo here, ⚠ gone from the cloud).
.k-rail__state {
  flex: none;
  font-size: var(--k-fs-xs);
  color: var(--k-muted);
}

.k-rail--orphan .k-rail__state {
  color: var(--k-accent);
}

// count badge — running agents, accent pill.
.k-rail__count {
  flex: none;
  min-width: 16px;
  height: 16px;
  padding: 0 5px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: var(--k-fs-xs);
  line-height: 1;
  color: var(--k-on-accent);
  background: var(--k-accent);
  border-radius: var(--k-r-pill);
}
</style>
