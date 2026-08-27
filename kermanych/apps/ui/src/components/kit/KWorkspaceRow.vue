<script setup lang="ts">
import { computed } from 'vue';

// A workspace row in the left sidebar: the group header that is also the scope selector
// and the drop target for projects.
//
// THREE hit areas, deliberately separate — conflating them is the bug this comment exists
// to prevent:
//   chevron      -> toggle expansion only, never changes scope
//   add button   -> create a project INSIDE this workspace
//   rest of row  -> set the workspace scope, never toggles expansion
// Both buttons therefore stop propagation. Clicking an already-active row is a no-op, not
// a collapse: expansion and scope are independent, and a sidebar that folds the group you
// just selected hides exactly what you asked to look at.
//
// The sidebar carries two «+» buttons and they create different things — the one beside
// the «Воркспейси» heading creates a workspace, this one creates a project. Hence a label
// that names the workspace instead of a bare «Новий проєкт».
const props = withDefaults(
  defineProps<{
    workspace: { id: string; name: string; color?: string | undefined };
    active?: boolean;
    expanded?: boolean;
    count?: number;
    dropTarget?: boolean;
  }>(),
  { count: 0, active: false, expanded: true, dropTarget: false },
);

const emit = defineEmits<{ select: []; toggle: []; 'add-project': [] }>();

// The counter is aria-hidden (a bare digit reads as noise), so the count reaches assistive
// tech through the row's label instead. Count-agnostic phrasing — «запущено агентів: 3» —
// because Ukrainian would otherwise need three plural forms for one tooltip.
const title = computed(
  () =>
    props.workspace.name +
    (props.count > 0 ? ` · запущено агентів: ${props.count}` : ' · немає запущених агентів'),
);

// The visible counter, empty when nothing runs. Resolved here rather than in the template
// because `withDefaults` only narrows `count` away from `undefined` on this side.
const badge = computed(() => (props.count > 0 ? String(props.count) : ''));

// Names are quoted because they are arbitrary text spliced into a Ukrainian sentence:
// «Новий проєкт у Особисте» is ungrammatical, «Новий проєкт у «Особисте»» is not.
const toggleLabel = computed(() =>
  props.expanded ? `Згорнути «${props.workspace.name}»` : `Розгорнути «${props.workspace.name}»`,
);
const addLabel = computed(() => `Новий проєкт у «${props.workspace.name}»`);
</script>

<template>
  <div class="k-ws" :class="{ 'k-ws--active': active, 'k-ws--drop': dropTarget }">
    <button
      class="k-ws__chevron"
      type="button"
      :aria-expanded="expanded"
      :aria-label="toggleLabel"
      v-tip="toggleLabel"
      @click.stop="emit('toggle')"
    >{{ expanded ? '▾' : '▸' }}</button>
    <button
      class="k-ws__body"
      type="button"
      :title="title"
      :aria-label="title"
      :aria-pressed="active"
      @click="emit('select')"
    >
      <span
        class="k-ws__dot"
        :style="workspace.color ? { background: workspace.color } : undefined"
        aria-hidden="true"
      ></span>
      <span class="k-ws__name">{{ workspace.name }}</span>
      <span v-if="badge" class="k-ws__count mono" aria-hidden="true">{{ badge }}</span>
    </button>
    <button
      class="k-ws__add"
      type="button"
      v-tip="'Новий проєкт у цьому воркспейсі'"
      :aria-label="addLabel"
      @click.stop="emit('add-project')"
    >+</button>
  </div>
</template>

<style scoped lang="scss">
.k-ws {
  display: flex;
  align-items: center;
  gap: 2px;
  font-family: var(--k-font-ui);
  border-radius: var(--k-r);
  border: 1px solid transparent;
}

.k-ws--active {
  background: var(--k-surface2);
}

// The drop affordance has to read at a glance mid-drag, so it is a border, not a
// background: a background change is indistinguishable from the active row.
.k-ws--drop {
  border-color: var(--k-accent);
}

.k-ws__chevron,
.k-ws__add {
  background: none;
  border: none;
  color: var(--k-muted);
  cursor: pointer;
  font-size: var(--k-fs-sm);
  line-height: 1;
  padding: var(--k-sp-1) 4px;
  border-radius: var(--k-r);

  &:hover {
    color: var(--k-text);
  }

  &:focus-visible {
    outline: 1px solid var(--k-accent);
    outline-offset: 1px;
  }
}

// Secondary action, so it stays out of the way until the row is pointed at — but keyboard
// users never hover, and an invisible tab stop is a trap. Focus reveals it too.
.k-ws__add {
  opacity: 0;
  font-size: var(--k-fs-md);
}

.k-ws:hover .k-ws__add,
.k-ws__add:focus-visible {
  opacity: 1;
}

.k-ws__body {
  display: flex;
  align-items: center;
  gap: var(--k-sp-2);
  flex: 1;
  min-width: 0;
  background: none;
  border: none;
  color: var(--k-text);
  cursor: pointer;
  font-size: var(--k-fs-base);
  padding: 7px 2px;
  text-align: left;
  border-radius: var(--k-r);

  &:focus-visible {
    outline: 1px solid var(--k-accent);
    outline-offset: 1px;
  }
}

// The workspace's colour, and the row's only chrome — a neutral token when it has none,
// so the name never shifts sideways between coloured and uncoloured workspaces.
.k-ws__dot {
  width: 8px;
  height: 8px;
  flex: none;
  border-radius: var(--k-r-pill);
  background: var(--k-line-strong);
}

.k-ws__name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-weight: var(--k-fw-medium);
}

.k-ws__count {
  font-size: var(--k-fs-xs);
  color: var(--k-muted);
}
</style>
