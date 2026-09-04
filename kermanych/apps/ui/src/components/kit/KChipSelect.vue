<template>
  <span ref="rootEl" class="k-chip-select">
    <button
      type="button"
      class="k-chip-select__trigger"
      :class="{ 'k-chip-select__trigger--open': open }"
      :disabled="disabled"
      :aria-label="title"
      :aria-haspopup="'menu'"
      :aria-expanded="open"
      @click="toggle"
    >
      <span v-if="icon" class="k-chip-select__icon" aria-hidden="true">{{ icon }}</span>
      <span class="k-chip-select__label">{{ currentLabel }}</span>
      <span class="k-chip-select__caret" aria-hidden="true"></span>
    </button>

    <!-- Under <body>, `position: fixed`, like KSelect's listbox and lib/tip.ts's bubble:
         every pane in this app sets `overflow: auto`, so an in-flow menu is cropped by the
         first scroll container above it — for the Jira board's assignee filter that is the
         toolbar itself, which is only as tall as one chip.

         `placement` is now a PREFERENCE, not a setting: placeMenu() honours it while the
         list fits there and flips otherwise, so the composer's chip (bottom of the window)
         still opens up and the board's still opens down, but neither runs off-screen. -->
    <Teleport to="body">
      <div
        v-if="open"
        ref="menuEl"
        class="k-chip-select__menu"
        :class="{ 'k-chip-select__menu--placed': placed }"
        role="menu"
        :aria-label="title"
      >
        <button
          v-for="o in options"
          :key="o.value"
          type="button"
          class="k-chip-select__item"
          :class="{ 'k-chip-select__item--active': o.value === modelValue }"
          role="menuitemradio"
          :aria-checked="o.value === modelValue"
          @click="pick(o.value)"
        >
          <span class="k-chip-select__tick" aria-hidden="true">{{ o.value === modelValue ? '·' : '' }}</span>
          <span class="k-chip-select__label-text">{{ o.label }}</span>
        </button>
      </div>
    </Teleport>
  </span>
</template>

<script setup lang="ts" generic="T extends string">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import { isAnchorOffscreen, placeMenu } from '../../lib/menu';

// A flat chip that opens a small menu: `⚡ Високий ▾`. The composer's control row needs a
// picker that reads as a label rather than a form field, which is why this is not KSelect —
// that one is a labelled, full-width native <select> built for modal forms.
//
// Generic over the value type so a caller with a union (e.g. ThinkingLevel) gets that union
// back from `update:modelValue` instead of a bare string it would have to re-narrow.
const props = defineProps<{
  modelValue: T;
  options: { value: T; label: string }[];
  // Leading glyph. Mono-width in the row, so an icon-less chip still lines up with its peers.
  icon?: string | undefined;
  // Names the control for screen readers and for the app tooltip — the chip itself shows only
  // the current value, so without this the menu is an unlabelled list of words.
  title?: string | undefined;
  disabled?: boolean | undefined;
  // Which way the menu PREFERS to unfold; it flips when that side cannot hold the list.
  // Defaults to 'up' — the composer's need, and the behaviour every existing caller
  // already relies on.
  placement?: 'up' | 'down' | undefined;
}>();

const emit = defineEmits<{ 'update:modelValue': [value: T] }>();

const open = ref(false);
const rootEl = ref<HTMLElement | null>(null);
const menuEl = ref<HTMLElement | null>(null);
// Gates the entrance transition: the menu is measured and pinned before it is allowed to
// fade in, so it never animates from a wrong corner of the screen.
const placed = ref(false);
// The list's height with nothing capping it, measured once per opening. Re-measuring after
// `max-height` lands would read back the cap and the menu could never grow again.
let naturalH = 0;

// A value with no matching option still has to print something: showing the raw value is the
// honest fallback (omp reporting a rung this build has no word for), never a blank chip.
const currentLabel = computed(() => props.options.find((o) => o.value === props.modelValue)?.label ?? props.modelValue);

function pick(value: T): void {
  close();
  if (value !== props.modelValue) emit('update:modelValue', value);
}

function toggle(): void {
  if (open.value) close();
  else void openMenu();
}

async function openMenu(): Promise<void> {
  if (props.disabled || open.value) return;
  naturalH = 0;
  open.value = true;
  placed.value = false;
  document.addEventListener('pointerdown', onDocPointerDown);
  document.addEventListener('keydown', onDocKeydown);
  // `capture`, because a scroll inside the board's columns or the risks strip never bubbles
  // to window — and that is exactly where these chips live.
  window.addEventListener('scroll', place, { capture: true, passive: true });
  window.addEventListener('resize', place);
  await nextTick();
  place();
  placed.value = true;
}

function close(): void {
  if (!open.value) return;
  open.value = false;
  placed.value = false;
  document.removeEventListener('pointerdown', onDocPointerDown);
  document.removeEventListener('keydown', onDocKeydown);
  window.removeEventListener('scroll', place, true);
  window.removeEventListener('resize', place);
}

// Measure the trigger, then pin the teleported menu to it in viewport coordinates.
function place(): void {
  const t = rootEl.value;
  const m = menuEl.value;
  if (!t || !m) return;
  const r = t.getBoundingClientRect();
  const viewport = { width: window.innerWidth, height: window.innerHeight };
  // A chip scrolled out of its pane leaves the menu floating beside nothing.
  if (isAnchorOffscreen(r, viewport)) {
    close();
    return;
  }
  // At least as wide as its trigger, so chip and menu read as one object; the ceiling is
  // CSS. Width first — it decides how much of a long name wraps, i.e. the height read next.
  m.style.minWidth = `${Math.round(r.width)}px`;
  if (!naturalH) {
    m.style.maxHeight = '';
    naturalH = m.offsetHeight;
  }
  const at = placeMenu(
    r,
    { width: m.offsetWidth, height: naturalH },
    viewport,
    props.placement === 'down' ? 'bottom' : 'top',
  );
  m.style.left = `${at.left}px`;
  m.style.top = `${at.top}px`;
  m.style.maxHeight = `${at.maxHeight}px`;
  // Read by the entrance offset in this file's styles: a menu that opened upward has to
  // rest below its final position, not above it.
  m.dataset.side = at.side;
}

// Dismissal: a pointer anywhere outside the chip AND outside the menu, or Escape. The menu
// is teleported, so it is no longer inside `rootEl` — testing only the root would close the
// list on pointerdown and the item's click would land on nothing.
function onDocPointerDown(e: PointerEvent): void {
  const target = e.target as Node;
  if (!rootEl.value?.contains(target) && !menuEl.value?.contains(target)) close();
}
function onDocKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape') close();
}
// Unmounting with the menu open (the panel switches session mid-pick) must not leave the
// document or window listeners behind.
onBeforeUnmount(close);
// A chip disabled while its menu is open (the composer locks its row on submit) must not
// leave an orphaned list on screen.
watch(
  () => props.disabled,
  (isDisabled) => {
    if (isDisabled) close();
  },
);
</script>

<style scoped lang="scss">
// No `position: relative` — the menu is teleported to <body> and pinned in viewport
// coordinates, so there is no longer a containing block for it to establish.
.k-chip-select {
  display: inline-flex;
  flex: none;
}

.k-chip-select__trigger {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 5px 8px;
  background: transparent;
  border: none;
  border-radius: var(--k-r);
  color: var(--k-muted);
  font-family: var(--k-font-ui);
  font-size: var(--k-fs-sm);
  line-height: 1;
  cursor: pointer;
  white-space: nowrap;
  transition: background 0.12s, color 0.12s;

  &:hover:not(:disabled),
  &.k-chip-select__trigger--open {
    background: var(--k-surface2);
    color: var(--k-text);
  }
  &:focus-visible {
    outline: 1px solid var(--k-accent);
    outline-offset: 1px;
  }
  &:disabled {
    cursor: default;
    opacity: 0.5;
  }
}

.k-chip-select__icon {
  font-size: var(--k-fs-base);
  line-height: 1;
}

// Drawn, not typed, and at the weight of the marker KWorkspaceRow and KSelect already use:
// as a 10px `⌄` at half opacity this was a hairline that read as punctuation, and
// `--k-font-ui` carries no geometric-shapes glyph, so the fallback face also hung it below
// the label's centre line. A clipped box has no baseline to drift — its ink IS its box.
//
// 10x6 is KSelect's 9x5 marker one step up, because this chip has no frame to say it is a
// control: the triangle is the only thing separating «Високий» from the flat worktree
// reading beside it, so it has to carry that on its own.
.k-chip-select__caret {
  flex: none;
  width: 10px;
  height: 6px;
  background: currentColor;
  clip-path: polygon(0 0, 100% 0, 50% 100%);
  opacity: 0.75;
  transition: transform 0.12s ease, opacity 0.12s ease;
}

.k-chip-select__trigger--open .k-chip-select__caret {
  transform: rotate(180deg);
  opacity: 1;
}

// Floating surface — one of the few places this flat system uses a shadow.
//
// Teleported to <body>, so `position: fixed` and every coordinate comes from place(). The
// z-index matches KSelect's: above QDialog's 6000, because these chips open inside modals,
// and below the toast layer at 7000, which is the one thing allowed to cover a menu.
.k-chip-select__menu {
  position: fixed;
  top: 0;
  left: 0;
  z-index: 6500;
  box-sizing: border-box;
  // The trigger's width is the floor (written by place()); this is the ceiling. Without it
  // a board with «Kseniia Bershadska (Novakova)» on it sizes the menu to that one name and
  // runs off the right of a narrow window.
  max-width: min(calc(100vw - 16px), 320px);
  // The assignee filter on a 841-ticket board lists everyone holding a card. Uncapped, that
  // list simply ran past the bottom of the screen with no way to reach the last name.
  overflow-y: auto;
  // No scroll chaining: a wheel at the end of the list must not start scrolling the board
  // behind it.
  overscroll-behavior: contain;
  display: flex;
  flex-direction: column;
  padding: var(--k-sp-1);
  background: var(--k-surface);
  border: 1px solid var(--k-line-strong);
  border-radius: var(--k-r);
  box-shadow: var(--k-shadow-pop);
  opacity: 0;
  transition: opacity 0.12s ease, transform 0.12s cubic-bezier(0.4, 0, 0.2, 1);
  // Rests 3px toward its trigger, so the menu reads as emerging from the chip. Mirrored for
  // one that had to open upward (`data-side`, written by place()).
  transform: translateY(-3px);
}

.k-chip-select__menu[data-side='top'] {
  transform: translateY(3px);
}

.k-chip-select__menu--placed {
  opacity: 1;
  transform: none;
}

.k-chip-select__item {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 8px;
  background: transparent;
  border: none;
  border-radius: var(--k-r-sm);
  color: var(--k-muted);
  font-family: var(--k-font-ui);
  font-size: var(--k-fs-sm);
  line-height: 1.2;
  text-align: left;
  cursor: pointer;
  transition: background 0.12s, color 0.12s;

  &:hover {
    background: var(--k-surface2);
    color: var(--k-text);
  }
  &:focus-visible {
    outline: 1px solid var(--k-accent);
    outline-offset: -1px;
  }
}

.k-chip-select__item--active {
  color: var(--k-text);
}

// Long names wrap onto a second line rather than widening the menu past its max-width —
// «Kseniia Bershadska (Novakova)» is a real row on the Jira board. `min-width: 0` because a
// flex item refuses to shrink below its longest word without it.
.k-chip-select__label-text {
  min-width: 0;
  overflow-wrap: anywhere;
}

// A fixed-width gutter for the selection dot, so the labels form one column whether or not
// their row is the selected one. Aligned to the first line, not the box's centre, so the
// dot stays beside the start of a name that wrapped.
.k-chip-select__tick {
  width: 6px;
  flex: none;
  align-self: flex-start;
  line-height: 1.2;
  color: var(--k-accent);
}
</style>
