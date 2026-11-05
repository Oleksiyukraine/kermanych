<template>
  <div ref="rootEl" class="k-switcher" :class="{ 'k-switcher--open': open }">
    <button
      type="button"
      class="k-switcher__btn"
      aria-haspopup="menu"
      :aria-expanded="open"
      :aria-label="buttonLabel"
      v-tip="buttonLabel"
      @click="toggle"
      @keydown.down.prevent="openMenu"
    >
      <template v-if="current.workspace">
        <span v-if="current.workspace.icon" class="k-switcher__emoji" aria-hidden="true">{{ current.workspace.icon }}</span>
        <span
          v-else
          class="k-switcher__dot"
          :style="current.workspace.color ? { background: current.workspace.color } : undefined"
          aria-hidden="true"
        ></span>
      </template>
      <span class="k-switcher__name">{{ current.label }}</span>
      <span class="k-switcher__caret" aria-hidden="true"></span>
      <!-- What waits OUTSIDE the scope (lib/attention.ts attentionOutside). Still — no pulse:
           it sits beside the work the operator is focused on. -->
      <KAttentionBadge :attention="outside" still />
    </button>

    <!-- Under <body>, `position: fixed`, like KSplitButton's menu: a header child would be
         clipped by the layout's own stacking, and the list can be long. -->
    <Teleport to="body">
      <div
        v-if="open"
        ref="menuEl"
        class="k-switcher__menu"
        :class="{ 'k-switcher__menu--placed': placed }"
        role="menu"
        :aria-label="menuLabel"
        @keydown="onMenuKeydown"
      >
        <section v-for="g in groups" :key="g.workspace.id" class="k-switcher__group">
          <!-- The workspace row scopes to the workspace, as its sidebar row does. -->
          <button
            type="button"
            class="k-switcher__ws"
            :class="{ 'k-switcher__ws--active': !projectId && workspaceId === g.workspace.id }"
            role="menuitem"
            data-switcher-item
            @click="pickWorkspace(g.workspace.id)"
          >
            <span v-if="g.workspace.icon" class="k-switcher__emoji" aria-hidden="true">{{ g.workspace.icon }}</span>
            <span
              v-else
              class="k-switcher__dot"
              :style="g.workspace.color ? { background: g.workspace.color } : undefined"
              aria-hidden="true"
            ></span>
            <span class="k-switcher__ws-name">{{ g.workspace.name }}</span>
            <KAttentionBadge :attention="workspaceAttention(g.workspace.id)" />
          </button>
          <KRailItem
            v-for="p in g.projects"
            :key="p.id"
            class="k-switcher__project"
            :project="p"
            :active="p.id === projectId"
            :attention="attentionOf(p.id)"
            :minion="minion.has(p.id)"
            role="menuitem"
            data-switcher-item
            @click="pickProject(p.id)"
          />
        </section>
        <section v-if="ungrouped.length" class="k-switcher__group">
          <div class="k-switcher__label mono">{{ ungroupedLabel }}</div>
          <KRailItem
            v-for="p in ungrouped"
            :key="p.id"
            class="k-switcher__project"
            :project="p"
            :active="p.id === projectId"
            :attention="attentionOf(p.id)"
            :minion="minion.has(p.id)"
            role="menuitem"
            data-switcher-item
            @click="pickProject(p.id)"
          />
        </section>
      </div>
    </Teleport>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref } from 'vue';
import type { Attention } from '../../lib/attention';
import { isAnchorOffscreen, placeMenu } from '../../lib/menu';
import KAttentionBadge from './KAttentionBadge.vue';
import KRailItem, { type RailProject } from './KRailItem.vue';

// The header's project switcher, in the spirit of an IDE's project menu: the button names
// where the operator is, the menu is the sidebar's tree in a dropdown. It is always on screen
// — in focus mode it is the only way to change project — and it only SELECTS: creating,
// moving and folding stay in the sidebar (spec docs/specs/2026-10-29-agents-tab-and-focus-mode.md,
// decision 10). The rows are the sidebar's own (KRailItem, the same attention mark and
// «Посіпака» icon), so a project reads the same in both places.
//
// Data comes in as props — the sidebar's tree, marks and selection — so this stays a kit
// component with no store of its own. MainLayout owns the one copy of each.
type Workspace = { id: string; name: string; color?: string | undefined; icon?: string | undefined };

const props = defineProps<{
  groups: readonly { workspace: Workspace; projects: readonly RailProject[] }[];
  ungrouped: readonly RailProject[];
  ungroupedLabel: string;
  projectId: string | undefined;
  workspaceId: string | undefined;
  attentionOf: (projectId: string) => Attention;
  workspaceAttention: (workspaceId: string) => Attention;
  minion: ReadonlySet<string>;
  // What needs the operator outside the current scope.
  outside: Attention;
  // «Вибрати проєкт», «{name} · усі проєкти», the menu's name, and the tooltip tail that
  // lists what `outside` holds — all i18n, passed in.
  emptyLabel: string;
  allProjectsLabel: (workspace: string) => string;
  menuLabel: string;
  outsideHint: string;
}>();

const emit = defineEmits<{ 'select-project': [id: string]; 'select-workspace': [id: string] }>();

// What the closed button names: the project and its workspace's marker; a workspace-only
// scope as «FS · усі проєкти»; nothing as an invitation.
const current = computed<{ label: string; workspace?: Workspace }>(() => {
  if (props.projectId) {
    for (const g of props.groups) {
      const p = g.projects.find((x) => x.id === props.projectId);
      if (p) return { label: p.name, workspace: g.workspace };
    }
    const p = props.ungrouped.find((x) => x.id === props.projectId);
    if (p) return { label: p.name };
  }
  if (props.workspaceId) {
    const g = props.groups.find((x) => x.workspace.id === props.workspaceId);
    if (g) return { label: props.allProjectsLabel(g.workspace.name), workspace: g.workspace };
  }
  return { label: props.emptyLabel };
});
const buttonLabel = computed(() => `${props.menuLabel}: ${current.value.label}${props.outsideHint}`);

const open = ref(false);
const placed = ref(false);
const rootEl = ref<HTMLElement | null>(null);
const menuEl = ref<HTMLElement | null>(null);

function toggle(): void {
  if (open.value) close();
  else void openMenu();
}

async function openMenu(): Promise<void> {
  if (open.value) return;
  open.value = true;
  placed.value = false;
  document.addEventListener('pointerdown', onDocPointerDown);
  window.addEventListener('resize', place);
  await nextTick();
  place();
  placed.value = true;
  // Focus lands on the current row, so ↑/↓ start from where the operator is.
  const items = itemButtons();
  (items.find((b) => b.getAttribute('aria-pressed') === 'true' || b.classList.contains('k-switcher__ws--active')) ?? items[0])?.focus();
}

function close(refocus = false): void {
  if (!open.value) return;
  open.value = false;
  placed.value = false;
  document.removeEventListener('pointerdown', onDocPointerDown);
  window.removeEventListener('resize', place);
  if (refocus) rootEl.value?.querySelector<HTMLButtonElement>('.k-switcher__btn')?.focus();
}

function pickProject(id: string): void {
  close();
  emit('select-project', id);
}
function pickWorkspace(id: string): void {
  close();
  emit('select-workspace', id);
}

// Hangs from the button's left edge: the switcher sits at the left end of the header.
function place(): void {
  const r = rootEl.value?.getBoundingClientRect();
  const m = menuEl.value;
  if (!r || !m) return;
  const viewport = { width: window.innerWidth, height: window.innerHeight };
  if (isAnchorOffscreen(r, viewport)) {
    close();
    return;
  }
  m.style.maxHeight = '';
  const at = placeMenu(r, { width: m.offsetWidth, height: m.offsetHeight }, viewport);
  m.style.left = `${at.left}px`;
  m.style.top = `${at.top}px`;
  m.style.maxHeight = `${at.maxHeight}px`;
  m.dataset.side = at.side;
}

function itemButtons(): HTMLButtonElement[] {
  return [...(menuEl.value?.querySelectorAll<HTMLButtonElement>('[data-switcher-item]') ?? [])];
}

// ↑/↓ walk the rows (wrapping), Home/End jump, Esc closes back onto the button, Tab leaves.
// Enter/Space are the focused row's own button click.
function onMenuKeydown(e: KeyboardEvent): void {
  const buttons = itemButtons();
  const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
  let next: number | undefined;
  if (e.key === 'ArrowDown') next = (at + 1) % buttons.length;
  else if (e.key === 'ArrowUp') next = (at - 1 + buttons.length) % buttons.length;
  else if (e.key === 'Home') next = 0;
  else if (e.key === 'End') next = buttons.length - 1;
  else if (e.key === 'Escape') {
    e.preventDefault();
    e.stopPropagation();
    close(true);
    return;
  } else if (e.key === 'Tab') {
    close(true);
    return;
  }
  if (next === undefined) return;
  e.preventDefault();
  buttons[next]?.focus();
}

// The menu is teleported, so a pointer inside it is outside the root.
function onDocPointerDown(e: PointerEvent): void {
  const target = e.target as Node;
  if (!rootEl.value?.contains(target) && !menuEl.value?.contains(target)) close();
}

onBeforeUnmount(() => close());
</script>

<style scoped lang="scss">
.k-switcher {
  display: inline-flex;
  min-width: 0;
}

// Reads as the header's current location, not as a primary action: no fill at rest, the
// surface tint on hover and while open.
.k-switcher__btn {
  display: inline-flex;
  align-items: center;
  gap: var(--k-sp-2);
  min-width: 0;
  max-width: 280px;
  height: 30px;
  padding: 0 var(--k-sp-2);
  background: transparent;
  border: 1px solid transparent;
  border-radius: var(--k-r);
  color: var(--k-text);
  font-family: var(--k-font-ui);
  font-size: var(--k-fs-base);
  font-weight: var(--k-fw-medium);
  cursor: pointer;
  transition: background 0.12s, border-color 0.12s;

  &:hover {
    background: var(--k-surface);
  }
  &:focus-visible {
    outline: 1px solid var(--k-accent);
    outline-offset: 1px;
  }
}

.k-switcher--open .k-switcher__btn {
  background: var(--k-surface);
  border-color: var(--k-line);
}

.k-switcher__name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

// Drawn like KSplitButton's caret: a clipped box has no baseline to drift off the label's line.
.k-switcher__caret {
  flex: none;
  width: 8px;
  height: 5px;
  background: var(--k-muted);
  clip-path: polygon(0 0, 100% 0, 50% 100%);
  transition: transform 0.12s ease;
}

.k-switcher--open .k-switcher__caret {
  transform: rotate(180deg);
}

// The workspace marker, as KWorkspaceRow draws it.
.k-switcher__dot {
  flex: none;
  width: 8px;
  height: 8px;
  border-radius: var(--k-r-pill);
  background: var(--k-line-strong);
}

.k-switcher__emoji {
  flex: none;
  width: 8px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 14px;
  line-height: 1;
}

// Floating surface — KSplitButton's menu: surface, strong rule, the pop shadow, and the same
// z-index band (above QDialog's 6000, below the toast layer at 7000).
.k-switcher__menu {
  position: fixed;
  top: 0;
  left: 0;
  z-index: 6500;
  box-sizing: border-box;
  width: 280px;
  max-width: calc(100vw - 16px);
  overflow-y: auto;
  overscroll-behavior: contain;
  display: flex;
  flex-direction: column;
  gap: var(--k-sp-1);
  padding: var(--k-sp-1);
  background: var(--k-grad-raise), var(--k-surface);
  border: 1px solid var(--k-line-strong);
  border-radius: var(--k-r);
  box-shadow: var(--k-sheen), var(--k-shadow-pop);
  opacity: 0;
  transition: opacity 0.12s ease, transform 0.12s cubic-bezier(0.4, 0, 0.2, 1);
  transform: translateY(-3px);
}

.k-switcher__menu[data-side='top'] {
  transform: translateY(3px);
}

.k-switcher__menu--placed {
  opacity: 1;
  transform: none;
}

.k-switcher__group {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

// The workspace row: KWorkspaceRow's look without its chevron, «+» or drag — the switcher
// only selects. The 12px right padding puts its mark in the column the project rows use.
.k-switcher__ws {
  display: flex;
  align-items: center;
  gap: var(--k-sp-2);
  width: 100%;
  min-height: 30px;
  padding: var(--k-sp-1) var(--k-sp-3);
  background: transparent;
  border: 1px solid transparent;
  border-radius: var(--k-r);
  color: var(--k-text);
  font-family: var(--k-font-ui);
  font-size: var(--k-fs-base);
  font-weight: var(--k-fw-medium);
  text-align: left;
  cursor: pointer;
  transition: background 0.12s;

  &:hover:not(.k-switcher__ws--active) {
    background: var(--k-surface2);
  }
  &:focus-visible {
    outline: 1px solid var(--k-accent);
    outline-offset: -1px;
  }
}

.k-switcher__ws--active {
  background: var(--k-surface2);
}

.k-switcher__ws-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

// Project names start under the workspace name: 12px row padding + 8px dot + 8px gap = 28,
// against KRailItem's own 12px padding. Scoped to the group so it outranks that padding
// whichever stylesheet loads last.
.k-switcher__group .k-switcher__project {
  padding-left: 28px;
}

.k-switcher__label {
  padding: var(--k-sp-2) var(--k-sp-3) var(--k-sp-1);
  font-size: var(--k-fs-xs);
  color: var(--k-faint);
}

@media (prefers-reduced-motion: reduce) {
  .k-switcher__menu,
  .k-switcher__caret {
    transition: none;
  }
}
</style>
