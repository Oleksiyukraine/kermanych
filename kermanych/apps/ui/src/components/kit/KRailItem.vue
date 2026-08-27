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

// A project row in the left sidebar. The name plus the running-agent badge on the right: a
// green pill carrying the count while agents work, a bare red dot when none does. Binding
// state stays in the tooltip — one indicator cannot carry two meanings, and "is anything
// running here" is the question the rail gets scanned for. The active row gets a subtle
// surface highlight — no colour fill, no initials chip.
const props = withDefaults(
  defineProps<{
    project: RailProject;
    active?: boolean;
    count?: number;
    // Nested under a workspace row in the tree.
    indent?: boolean;
    // Draggable so it can be moved to another workspace. Off by default: a local-only
    // project has no cloud row and therefore nowhere to move to.
    draggable?: boolean;
  }>(),
  { count: 0, indent: false, draggable: false },
);

const emit = defineEmits<{ dragstart: [id: string]; dragend: [] }>();

const STATE_HINT: Record<RailProject['state'], string> = {
  bound: '',
  unbound: ' · не прив’язано',
  orphan: ' · поза хмарою',
};

// The badge is aria-hidden (a bare digit reads as noise), so the count travels to assistive
// tech through the button's label instead. Count-agnostic phrasing — «запущено агентів: 3»
// — because Ukrainian would otherwise need three plural forms for one tooltip.
const title = computed(
  () =>
    props.project.name +
    STATE_HINT[props.project.state] +
    (props.count > 0 ? ` · запущено агентів: ${props.count}` : ' · немає запущених агентів'),
);
const initials = computed(() => initialsOf(props.project.name, '#'));

// The badge's text, and by its emptiness the badge's shape: a digit while agents run,
// nothing when the pill collapses into the bare idle dot. Resolved here rather than in the
// template because `withDefaults` only narrows `count` away from `undefined` on this side.
const badge = computed(() => (props.count > 0 ? String(props.count) : ''));

// `setData` is what makes this a standards-conformant drag, but the DROP cannot read it
// back: under the protected-mode rules `getData()` returns '' during `dragover`, which
// exposes the types and nothing else. So the id also travels up through `dragstart` and
// the consumer keeps it in component state.
function onDragStart(e: DragEvent): void {
  if (!props.draggable) return;
  e.dataTransfer?.setData('application/x-kermanych-project', props.project.id);
  if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
  emit('dragstart', props.project.id);
}
</script>

<template>
  <button
    class="k-rail"
    :class="{ 'k-rail--active': active, 'k-rail--indent': indent }"
    type="button"
    :title="title"
    :aria-label="title"
    :aria-pressed="active"
    :draggable="draggable"
    @dragstart="onDragStart"
    @dragend="emit('dragend')"
  >
    <span class="k-rail__initials" aria-hidden="true">{{ initials }}</span>
    <span class="k-rail__name">{{ project.name }}</span>
    <span
      class="k-rail__agents"
      :class="{ 'k-rail__agents--idle': !badge }"
      aria-hidden="true"
    >{{ badge }}</span>
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

// Nested under a workspace row: the name lines up past the row's chevron, so the tree
// reads as a tree. A literal rather than a spacing token because it is measured against
// the chevron's box, not against the 8pt rhythm.
.k-rail--indent {
  padding-left: 26px;
}

.k-rail__name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--k-fs-base);
}

// Compact tile shown only in the minified rail; the parent toggles it on via .shell--min.
.k-rail__initials {
  display: none;
  flex: none;
  width: 28px;
  height: 28px;
  align-items: center;
  justify-content: center;
  border-radius: var(--k-r);
  background: var(--k-surface2);
  color: var(--k-text);
  font-family: var(--k-font-ui);
  font-size: var(--k-fs-xs);
  font-weight: var(--k-fw-semibold);
}

// Running-agent badge — a green pill around the count. `--k-on-accent` is the token for
// text on a saturated fill and flips with the theme, so the digits stay legible on both
// the bright dark-theme green and the dark light-theme one. One digit lands on the 16px
// min-width (a circle); two or more grow the pill sideways.
.k-rail__agents {
  display: inline-flex;
  flex: none;
  align-items: center;
  justify-content: center;
  min-width: 16px;
  height: 16px;
  padding: 0 var(--k-sp-1);
  border-radius: var(--k-r-pill);
  background: var(--k-success);
  color: var(--k-on-accent);
  font-family: var(--k-font-mono);
  font-size: var(--k-fs-xs);
  font-weight: var(--k-fw-semibold);
  line-height: 1;
}

// Nothing running — the badge collapses to a bare red dot; there is no number to show.
.k-rail__agents--idle {
  min-width: 0;
  width: 7px;
  height: 7px;
  padding: 0;
  background: var(--k-danger);
}
</style>
