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

// Each glyph control gets ONE string that is both its visible tip and its accessible name —
// the house rule KIconButton and MainLayout's «+» already follow. Diverging the two fails
// WCAG 2.5.3 Label in Name: a voice-control user speaks what they can see, and a name that
// does not contain it cannot be reached.
//
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
    </button>
    <!-- The row's right end is ONE 28px slot, and the counter and the «+» take turns in
         it: the counter while the row rests, the button while it is pointed at or its
         control is focused. They cannot share it — a slot wide enough for both would push
         this row's counter 28px out of the column KNavItem and KRailItem keep theirs in,
         which is exactly the raggedness this replaced — and they must not reflow into each
         other either, so the slot's width is fixed and neither move nor truncate the name
         when the swap happens. Nothing is lost while the «+» shows: the count is
         decoration here (aria-hidden), and the row's own label carries it. -->
    <span class="k-ws__end">
      <span v-if="badge" class="k-ws__count mono" aria-hidden="true">{{ badge }}</span>
      <button
        class="k-ws__add"
        type="button"
        v-tip="addLabel"
        :aria-label="addLabel"
        @click.stop="emit('add-project')"
      >+</button>
    </span>
  </div>
</template>

<style scoped lang="scss">
// The 30px sidebar row (see KNavItem for the box), here built from the 28px control boxes
// inside it plus the 1px border on each side rather than from padding. The 20px line box
// is the same one the other two rows use, so the name and the counter centre on whole
// pixels inside that 28px interior.
.k-ws {
  display: flex;
  align-items: center;
  gap: 2px;
  font-family: var(--k-font-ui);
  line-height: 20px;
  border-radius: var(--k-r);
  border: 1px solid transparent;
  transition: background 0.12s;

  // The row is the tree's primary target, so it answers the pointer like KRailItem does.
  // Skipped while active: the hover tint and the active tint are neighbours on the surface
  // ladder, and swapping one for the other reads as the selection moving.
  &:hover:not(.k-ws--active) {
    background: var(--k-surface);
  }
}

.k-ws--active {
  background: var(--k-surface2);
}

// The drop affordance has to read at a glance mid-drag, so it is a border, not a
// background: a background change is indistinguishable from the active row.
.k-ws--drop {
  border-color: var(--k-accent);
}

// Glyph-only controls, so they take the house 28x28 box from KIconButton rather than a
// padding guess: 28 clears the 24x24 minimum of WCAG 2.5.8 and matches every other icon
// control in the app. Borderless, because a rule around each of these would fence the row
// into three visible boxes.
.k-ws__chevron,
.k-ws__add {
  display: flex;
  align-items: center;
  justify-content: center;
  flex: none;
  width: 28px;
  height: 28px;
  padding: 0;
  background: none;
  border: none;
  color: var(--k-muted);
  cursor: pointer;
  font-size: var(--k-fs-sm);
  line-height: 1;
  border-radius: var(--k-r);
  transition: color 0.12s, opacity 0.12s;

  &:hover {
    color: var(--k-text);
  }

  &:focus-visible {
    outline: 1px solid var(--k-accent);
    outline-offset: 1px;
  }
}

// ▾/▸ are filled triangles: their ink is roughly a third of the em box, so at the 12px the
// rest of this row uses the fold control was a ~6px smudge — the one affordance in the tree
// a new user has to find, and the hardest thing in the sidebar to see. Stepped up to the
// 18px title size, which puts its ink at the weight of the 12px «+» beside it without
// changing the 28x28 hit box either control occupies.
.k-ws__chevron {
  font-size: var(--k-fs-lg);
}

// Secondary action, so it stays out of the way until the row is pointed at — but keyboard
// users never hover, and an invisible tab stop is a trap. Focus reveals it too, which is
// why this is opacity and not `display: none`: a hidden button is not focusable at all.
//
// Pinned over the slot instead of sitting in it, so the 28px box it needs is not also
// charged to the counter beside it. Offsets resolve against the slot's padding box, so
// `right: 0` is the row's inner edge — the same edge the chevron's box starts from.
.k-ws__add {
  position: absolute;
  top: 0;
  right: 0;
  opacity: 0;
  font-size: var(--k-fs-md);
}

.k-ws:hover .k-ws__add,
.k-ws__add:focus-visible {
  opacity: 1;
}

// The two occupants of the slot are stacked, so the one that is not wanted has to go
// quiet as the other arrives — otherwise the «+» is drawn straight over the digit.
.k-ws:hover .k-ws__count,
.k-ws:has(.k-ws__add:focus-visible) .k-ws__count {
  opacity: 0;
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
  min-height: 28px;
  padding: 0 2px;
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

// The right-end slot the counter and the «+» share. 28px wide because that is the button
// pinned inside it, and the 12px of padding is the rail's indicator gutter: it puts this
// digit's right edge exactly where KNavItem's counter and KRailItem's badge sit.
// `min-width`, not `width`, so a three-digit count widens the slot instead of spilling
// over the name.
.k-ws__end {
  position: relative;
  flex: none;
  display: flex;
  align-items: center;
  justify-content: flex-end;
  min-width: 28px;
  height: 28px;
  padding-right: var(--k-sp-3);
}

.k-ws__count {
  font-size: var(--k-fs-xs);
  color: var(--k-muted);
  transition: opacity 0.12s;
}
</style>
