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
import { useI18n } from 'vue-i18n';
import { initialsOf } from '../../lib/initials';
import { describeAttention, type Attention } from '../../lib/attention';
import KAttentionBadge from './KAttentionBadge.vue';

// A project row in the left sidebar. The name plus the attention mark on the right
// (KAttentionBadge): whether an agent waits for an answer, has failed, is running, or has
// left a result nobody opened — and no mark when nothing is going on. Binding state stays
// in the tooltip — one indicator cannot carry two meanings, and «does this project need me»
// is the question the rail gets scanned for. The active row gets a subtle surface
// highlight — no colour fill, no initials chip.
const props = withDefaults(
  defineProps<{
    project: RailProject;
    active?: boolean;
    attention: Attention;
    // Nested under a workspace row in the tree.
    indent?: boolean;
    // Draggable so it can be moved to another workspace. Off by default: a local-only
    // project has no cloud row and therefore nowhere to move to.
    draggable?: boolean;
  }>(),
  { indent: false, draggable: false },
);

const emit = defineEmits<{ dragstart: [id: string]; dragend: [] }>();

const { t } = useI18n();

const stateHint = (state: RailProject['state']): string =>
  state === 'unbound' ? t('kit.railItem.unbound') : state === 'orphan' ? t('kit.railItem.orphan') : '';

// The mark is aria-hidden, so the breakdown travels to assistive tech through the button's
// label instead.
//
// Feeds `v-tip` (src/lib/tip.ts) AND `aria-label`, never the native `title`: the rail is the
// most-hovered surface in the app, and `title` drew the OS rectangle there — square, delayed,
// and the one bubble in the UI the app does not style.
const title = computed(
  () => props.project.name + stateHint(props.project.state) + describeAttention(props.attention, t),
);
const initials = computed(() => initialsOf(props.project.name, '#'));

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
    v-tip="title"
    :aria-label="title"
    :aria-pressed="active"
    :draggable="draggable"
    @dragstart="onDragStart"
    @dragend="emit('dragend')"
  >
    <span class="k-rail__initials" aria-hidden="true">{{ initials }}</span>
    <span class="k-rail__name">{{ project.name }}</span>
    <!-- `k-rail__agents` names the slot so the minified rail (MainLayout's .shell--min)
         can hide it; the look lives in KAttentionBadge. -->
    <KAttentionBadge class="k-rail__agents" :attention="attention" />
  </button>
</template>

<style scoped lang="scss">
// The 30px sidebar row (see KNavItem for the box): 4px padding + a 20px line box + the
// 1px border on each side. The right padding is the rail's 12px indicator gutter, so this
// row's badge lands in the same column as KNavItem's counter and KWorkspaceRow's — the
// three used to sit at 9, 13 and 33px from the row's edge.
.k-rail {
  display: flex;
  align-items: center;
  gap: var(--k-sp-2);
  width: 100%;
  padding: var(--k-sp-1) var(--k-sp-3);
  line-height: 20px;
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

// Nested under a workspace row: the child's name starts where the PARENT's name starts, so
// the tree reads as a tree instead of hanging its children out to the left. Both offsets are
// measured from the same edge and both include a 1px border, so they cancel:
//
//   parent .k-ws__name = 28 chevron + 2 row gap + 2 body padding + 8 dot + 8 dot gap = 48
//   child  .k-rail__name = padding-left                                              = 48
//
// A literal rather than a spacing token because it tracks KWorkspaceRow's internals, not the
// 8pt rhythm — change the chevron box or the dot there and this has to move with it.
.k-rail--indent {
  padding-left: 48px;
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
</style>
