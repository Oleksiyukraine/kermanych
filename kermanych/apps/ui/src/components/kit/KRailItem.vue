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
    <span v-if="count > 0" class="k-rail__count mono">{{ count }}</span>
    <span v-if="project.state !== 'bound'" class="k-rail__state mono" aria-hidden="true">
      {{ STATE_GLYPH[project.state] }}
    </span>
  </button>
</template>

<style scoped lang="scss">
.k-rail {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 44px;
  height: 44px;
  padding: 0;
  border: 1px solid var(--k-line);
  background: transparent;
  color: var(--k-muted);
  cursor: pointer;
  border-radius: var(--k-r);
  transition: background 0.12s, border-color 0.12s, color 0.12s;

  &:hover:not(.k-rail--active) {
    border-color: var(--k-line-strong);
    color: var(--k-text);
  }

  &:focus-visible {
    outline: 1px solid var(--k-accent);
    outline-offset: 1px;
  }
}

// left strip — project color when set (always shown), else the accent when active.
.k-rail--active {
  background: var(--k-surface2);
  border-color: var(--k-line-strong);
  color: var(--k-text);
}

.k-rail--active::before,
.k-rail--colored::before {
  content: '';
  position: absolute;
  left: -1px;
  top: 0;
  bottom: 0;
  width: 2px;
  background: var(--k-accent);
}

.k-rail--colored::before {
  background: var(--rail-color);
}

// binding state — dashed frame while this machine has no repo, accent frame for a row the
// cloud no longer lists.
.k-rail--unbound {
  border-style: dashed;
}

.k-rail--orphan {
  border-color: var(--k-accent);
}

.k-rail__state {
  position: absolute;
  bottom: -1px;
  right: 1px;
  font-size: 9px;
  line-height: 1;
  color: var(--k-muted);
}

.k-rail__initials {
  font-size: 12px;
  font-weight: 400;
  letter-spacing: 0.04em;
}

// count badge — accent square, top-right, machine number.
.k-rail__count {
  position: absolute;
  top: -1px;
  right: -1px;
  min-width: 15px;
  height: 15px;
  padding: 0 3px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 10px;
  line-height: 1;
  color: var(--k-canvas);
  background: var(--k-accent);
}
</style>
