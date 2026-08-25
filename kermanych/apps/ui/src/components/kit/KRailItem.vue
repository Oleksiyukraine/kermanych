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

// A project row in the left sidebar. The name plus a small state dot on the right: bound
// (a local repo here) shows green, orphan (gone from the cloud) accent, unbound none. The
// active row gets a subtle surface highlight — no colour fill, no initials chip.
const props = defineProps<{ project: RailProject; active?: boolean; count?: number }>();

const STATE_HINT: Record<RailProject['state'], string> = {
  bound: '',
  unbound: ' · не прив’язано',
  orphan: ' · поза хмарою',
};

const title = computed(() => props.project.name + STATE_HINT[props.project.state]);
</script>

<template>
  <button
    class="k-rail"
    :class="{ 'k-rail--active': active }"
    type="button"
    :title="title"
    :aria-pressed="active"
  >
    <span class="k-rail__name">{{ project.name }}</span>
    <span
      v-if="project.state !== 'unbound'"
      class="k-rail__dot"
      :class="{ 'k-rail__dot--orphan': project.state === 'orphan' }"
      aria-hidden="true"
    ></span>
  </button>
</template>

<style scoped lang="scss">
.k-rail {
  display: flex;
  align-items: center;
  gap: var(--k-sp-2);
  width: 100%;
  padding: var(--k-sp-2);
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

.k-rail__name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--k-fs-base);
}

// state dot — bound (green), orphan (accent); unbound shows none.
.k-rail__dot {
  flex: none;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--k-success);
}

.k-rail__dot--orphan {
  background: var(--k-accent);
}
</style>
