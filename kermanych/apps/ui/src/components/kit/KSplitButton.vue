<template>
  <div ref="rootEl" class="k-split-btn" :class="{ 'k-split-btn--open': open }">
    <!-- The default action: exactly what a plain primary button here would do. -->
    <KBtn variant="primary" class="k-split-btn__main" :disabled="!!disabled" @click="emit('click')">
      {{ label }}
    </KBtn>
    <!-- The other ways to do it. A separate control rather than a long-press or a hover, so
         the default stays one click and the alternatives are one deliberate click away. -->
    <KBtn
      variant="primary"
      class="k-split-btn__toggle"
      :disabled="!!disabled"
      :title="menuLabel"
      :aria-label="menuLabel"
      aria-haspopup="menu"
      :aria-expanded="open"
      @click="toggle"
      @keydown.down.prevent="openMenu"
    >
      <span class="k-split-btn__caret" aria-hidden="true"></span>
    </KBtn>

    <!-- Under <body>, `position: fixed`, like KChipSelect's menu: the board column this sits
         in scrolls (`overflow: auto`), and an in-flow menu would be cropped by it. -->
    <Teleport to="body">
      <div
        v-if="open"
        ref="menuEl"
        class="k-split-btn__menu"
        :class="{ 'k-split-btn__menu--placed': placed }"
        role="menu"
        :aria-label="menuLabel"
        @keydown="onMenuKeydown"
      >
        <button
          v-for="item in items"
          :key="item.value"
          type="button"
          class="k-split-btn__item"
          role="menuitem"
          @click="pick(item.value)"
        >
          <span v-if="item.icon" class="k-split-btn__disc" aria-hidden="true"><KIcon :name="item.icon" /></span>
          <span class="k-split-btn__text">
            <span class="k-split-btn__label">{{ item.label }}</span>
            <span v-if="item.caption" class="k-split-btn__caption">{{ item.caption }}</span>
          </span>
        </button>
      </div>
    </Teleport>
  </div>
</template>

<script setup lang="ts" generic="T extends string">
import { nextTick, onBeforeUnmount, ref, watch } from 'vue';
import KBtn from './KBtn.vue';
import KIcon, { type KIconName } from './KIcon.vue';
import { isAnchorOffscreen, placeMenu } from '../../lib/menu';

// A split button (Quasar's «split» QBtnDropdown): the main part runs the default action, the
// ▾ part opens a menu of the alternatives. Each item is a mark, a label and a one-line
// caption, because the menu is where the operator CHOOSES between ways of doing one thing —
// the caption is what tells them apart, a bare label would not.
//
// The main half emits `click`; a menu item emits `select` with its value. The menu may list
// the default action too: stating it beside the alternatives is what makes the difference
// readable, and picking it is the same as clicking the main half.
const props = defineProps<{
  label: string;
  items: { value: T; label: string; caption?: string; icon?: KIconName }[];
  // Names the ▾ part — its tooltip, its accessible name and the menu's. The part shows only
  // a caret, so without this it is an unlabelled control.
  menuLabel: string;
  disabled?: boolean | undefined;
}>();

const emit = defineEmits<{ click: []; select: [value: T] }>();

const open = ref(false);
const placed = ref(false);
const rootEl = ref<HTMLElement | null>(null);
const menuEl = ref<HTMLElement | null>(null);

function toggle(): void {
  if (open.value) close();
  else void openMenu();
}

async function openMenu(): Promise<void> {
  if (props.disabled || open.value) return;
  open.value = true;
  placed.value = false;
  document.addEventListener('pointerdown', onDocPointerDown);
  // `capture`, because a scroll inside the board column never bubbles to window.
  window.addEventListener('scroll', place, { capture: true, passive: true });
  window.addEventListener('resize', place);
  await nextTick();
  place();
  placed.value = true;
  // Focus moves into the menu so ↑/↓, Enter and Esc work at once. After a mouse click the
  // programmatic focus does not match :focus-visible, so no ring flashes for pointer users.
  itemButtons()[0]?.focus();
}

function close(refocus = false): void {
  if (!open.value) return;
  open.value = false;
  placed.value = false;
  document.removeEventListener('pointerdown', onDocPointerDown);
  window.removeEventListener('scroll', place, true);
  window.removeEventListener('resize', place);
  if (refocus) rootEl.value?.querySelector<HTMLButtonElement>('.k-split-btn__toggle')?.focus();
}

function pick(value: T): void {
  close();
  emit('select', value);
}

// Pinned under the whole split, its RIGHT edge on the button's right edge: the control sits
// at the right end of a header, and a menu hanging off its left corner would run out over
// whatever is beside it. placeMenu() left-aligns and clamps, so it is handed an anchor whose
// left edge is where a right-aligned menu starts.
function place(): void {
  const r = rootEl.value?.getBoundingClientRect();
  const m = menuEl.value;
  if (!r || !m) return;
  const viewport = { width: window.innerWidth, height: window.innerHeight };
  if (isAnchorOffscreen(r, viewport)) {
    close();
    return;
  }
  m.style.minWidth = `${Math.round(r.width)}px`;
  m.style.maxHeight = '';
  const box = { width: m.offsetWidth, height: m.offsetHeight };
  const at = placeMenu({ top: r.top, bottom: r.bottom, width: r.width, left: r.right - box.width }, box, viewport);
  m.style.left = `${at.left}px`;
  m.style.top = `${at.top}px`;
  m.style.maxHeight = `${at.maxHeight}px`;
  m.dataset.side = at.side;
}

function itemButtons(): HTMLButtonElement[] {
  return [...(menuEl.value?.querySelectorAll<HTMLButtonElement>('.k-split-btn__item') ?? [])];
}

// Menu keyboard: ↑/↓ walk the items (wrapping), Home/End jump, Esc closes back onto the ▾,
// Tab leaves the menu and closes it. Enter/Space are the focused item's own button click.
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
    // Stops here: an Esc that reached the page would also close whatever the page closes.
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

// A pointer anywhere outside the split AND outside the menu dismisses it. The menu is
// teleported, so testing only the root would close it before an item's click landed.
function onDocPointerDown(e: PointerEvent): void {
  const target = e.target as Node;
  if (!rootEl.value?.contains(target) && !menuEl.value?.contains(target)) close();
}

onBeforeUnmount(() => close());
// Disabled while open (the scope switched to a workspace): no orphaned menu on screen.
watch(
  () => props.disabled,
  (isDisabled) => {
    if (isDisabled) close();
  },
);
</script>

<style scoped lang="scss">
.k-split-btn {
  display: inline-flex;
  flex: none;
}

// The two halves read as one button: the inner corners are squared and a hairline in the
// label's own colour divides them, as in Quasar's split dropdown. `.k-split-btn` in front of
// each selector so these win over KBtn's own scoped rules regardless of load order.
.k-split-btn .k-split-btn__main {
  border-top-right-radius: 0;
  border-bottom-right-radius: 0;
}

.k-split-btn .k-split-btn__toggle {
  justify-content: center;
  padding: 0 11px;
  border-top-left-radius: 0;
  border-bottom-left-radius: 0;
  border-left-color: color-mix(in srgb, var(--k-on-accent) 22%, transparent);
}

// Open: the ▾ half holds its hover fill, so it is plain which part the menu belongs to.
.k-split-btn--open .k-split-btn__toggle {
  background: var(--k-accent-hover);
}

// Drawn like KChipSelect's caret: a clipped box has no baseline to drift off the label's line.
.k-split-btn__caret {
  display: block;
  width: 10px;
  height: 6px;
  background: currentColor;
  clip-path: polygon(0 0, 100% 0, 50% 100%);
  transition: transform 0.12s ease;
}

.k-split-btn--open .k-split-btn__caret {
  transform: rotate(180deg);
}

// Floating surface — KChipSelect's menu: surface, strong rule, the pop shadow, and the same
// z-index band (above QDialog's 6000, below the toast layer at 7000).
.k-split-btn__menu {
  position: fixed;
  top: 0;
  left: 0;
  z-index: 6500;
  box-sizing: border-box;
  width: 320px;
  max-width: calc(100vw - 16px);
  overflow-y: auto;
  overscroll-behavior: contain;
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: var(--k-sp-1);
  background: var(--k-surface);
  border: 1px solid var(--k-line-strong);
  border-radius: var(--k-r);
  box-shadow: var(--k-shadow-pop);
  opacity: 0;
  transition: opacity 0.12s ease, transform 0.12s cubic-bezier(0.4, 0, 0.2, 1);
  // Rests 3px toward its trigger, so the menu reads as emerging from the button.
  transform: translateY(-3px);
}

.k-split-btn__menu[data-side='top'] {
  transform: translateY(3px);
}

.k-split-btn__menu--placed {
  opacity: 1;
  transform: none;
}

.k-split-btn__item {
  display: flex;
  align-items: center;
  gap: var(--k-sp-3);
  width: 100%;
  padding: 8px 10px;
  background: transparent;
  border: none;
  border-radius: var(--k-r-sm);
  color: var(--k-text);
  font-family: var(--k-font-ui);
  text-align: left;
  cursor: pointer;
  transition: background 0.12s;

  &:hover {
    background: var(--k-surface2);
  }
  &:focus-visible {
    outline: 1px solid var(--k-accent);
    outline-offset: -1px;
  }
}

// The mark in a disc, as in the reference's avatar column: the eye finds the row by its shape
// before it reads the label.
.k-split-btn__disc {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  border-radius: 50%;
  background: color-mix(in srgb, var(--k-accent) 16%, transparent);
  color: var(--k-accent);
  --k-icon-size: var(--k-icon-md);
}

.k-split-btn__text {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 3px;
}

.k-split-btn__label {
  font-size: var(--k-fs-base);
  font-weight: var(--k-fw-semibold);
}

.k-split-btn__caption {
  font-size: var(--k-fs-xs);
  line-height: 1.35;
  color: var(--k-muted);
}

@media (prefers-reduced-motion: reduce) {
  .k-split-btn__menu,
  .k-split-btn__caret {
    transition: none;
  }
}
</style>
