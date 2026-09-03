<template>
  <div class="k-select" :class="{ 'k-select--open': open }">
    <!-- `for` on the button, not a wrapping <label>: a <button> is a labelable element, so
         the association survives the popup moving to <body>, and clicking the caption still
         opens the list the way clicking a <select>'s label used to. -->
    <label v-if="label" :id="labelId" :for="triggerId" class="k-select__label">{{ label }}</label>

    <!-- SEARCHABLE — the trigger is a real text input, so «Модель» can be found by typing
         instead of scrolled through 26 rows. The input stays HERE, inside the component's
         own subtree, rather than in the teleported list: a QDialog (KModal) re-grabs focus
         from anything under <body>, so a search box parked in the popup would be unfocusable
         inside the very form that needs it most — the «Нова задача» launcher. -->
    <div
      v-if="searchable"
      ref="shellEl"
      class="k-select__input k-select__shell"
      :class="{ 'k-select__input--open': open, 'k-select__input--disabled': disabled }"
    >
      <span class="k-select__box">
        <input
          :id="triggerId"
          ref="inputEl"
          type="text"
          class="k-select__text"
          role="combobox"
          aria-haspopup="listbox"
          aria-autocomplete="list"
          autocomplete="off"
          spellcheck="false"
          :aria-expanded="open"
          :aria-controls="listId"
          :aria-activedescendant="activeId"
          :disabled="disabled"
          :value="open ? query : current ? currentLabel : ''"
          :placeholder="currentLabel"
          @focus="onFieldFocus"
          @click="openMenu()"
          @input="onQuery"
          @keydown="onKeydown"
        />
        <span class="k-select__sizer" aria-hidden="true">
          <span v-for="(opt, i) in items" :key="i">{{ opt.label }}</span>
        </span>
      </span>
      <!-- The one way to CLOSE the list by pointer without leaving the field: a click on the
           input itself must place the caret, not toggle. Out of the tab order and out of the
           a11y tree — the input beside it is the control. -->
      <button
        type="button"
        class="k-select__toggle"
        tabindex="-1"
        aria-hidden="true"
        :disabled="disabled"
        @mousedown.prevent
        @click="toggle"
      >
        <span class="k-select__caret" aria-hidden="true"></span>
      </button>
    </div>

    <button
      v-else
      :id="triggerId"
      ref="shellEl"
      type="button"
      class="k-select__input"
      :class="{ 'k-select__input--open': open, 'k-select__input--empty': showsPlaceholder }"
      role="combobox"
      aria-haspopup="listbox"
      :aria-expanded="open"
      :aria-controls="listId"
      :aria-activedescendant="activeId"
      :aria-labelledby="label ? `${labelId} ${triggerId}` : undefined"
      :disabled="disabled"
      @click="toggle"
      @keydown="onKeydown"
    >
      <span class="k-select__box">
        <span class="k-select__value">{{ currentLabel }}</span>
        <!-- Width reservation, not decoration. A native <select> sized itself to its LONGEST
             option; a button sized to the CURRENT one would shift every control beside it on
             each pick (the board's filter strip is a bare flex row). These copies are
             measured and never painted, so the control keeps one width for its whole life.
             Pages that cannot afford the widest option pin a measure and get an ellipsis.
             The searchable variant above reserves the same width, for the same reason — and
             so that filtering a list down to one row cannot resize the field. -->
        <span class="k-select__sizer" aria-hidden="true">
          <span v-for="(opt, i) in items" :key="i">{{ opt.label }}</span>
        </span>
      </span>
      <span class="k-select__caret" aria-hidden="true"></span>
    </button>

    <!-- Under <body>, `position: fixed`: every pane in this app sets `overflow: auto`, and
         an in-flow list would be cropped by the board toolbar, the risks strip or a modal
         body — the same reason lib/tip.ts parks its bubble there. -->
    <Teleport to="body">
      <div
        v-if="open"
        :id="listId"
        ref="popEl"
        class="k-select__pop"
        :class="{ 'k-select__pop--placed': placed }"
        role="listbox"
        :aria-labelledby="label ? labelId : undefined"
      >
        <div
          v-for="(opt, i) in visible"
          :id="optionId(i)"
          :key="i"
          class="k-select__opt"
          :class="{
            'k-select__opt--active': i === activeIndex,
            'k-select__opt--selected': opt.value === current,
          }"
          role="option"
          :aria-selected="opt.value === current"
          @mouseenter="activeIndex = i"
          @mousedown.prevent
          @click="commit(i)"
        >
          <span class="k-select__mark" aria-hidden="true">
            <span v-if="opt.value === current" class="k-select__check"></span>
          </span>
          <span class="k-select__opt-label">{{ opt.label }}</span>
        </div>

        <div v-if="!visible.length" class="k-select__empty mono">{{ emptyText }}</div>
      </div>
    </Teleport>
  </div>
</template>

<script lang="ts">
// An option is either a bare string (label === value) or a {value,label} pair. The pair
// form exists because a filter keyed by NAME breaks on duplicates, and duplicate names —
// two workspaces called «Робота», two projects called «api» — are entirely plausible.
export type KSelectOption = { value: string; label: string };

// Instance counter for the element ids below. MODULE scope on purpose: `<script setup>` runs
// once per instance, so a counter declared there would hand every select the same ids — and
// `aria-activedescendant` would point at another control's row.
let seq = 0;
</script>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { filterByQuery, matchByPrefix, placeMenu } from '../../lib/menu';

const { t } = useI18n();

// The app's dropdown. Styled like KField — label above, surface trigger, accent focus ring —
// and the LIST is ours too: a `role="listbox"` panel with the kit's glass, radius and rules.
//
// Why not `<select>`, which this replaced: the popup of a native select is drawn by the
// operating system, not by the page. No token reaches it, so on macOS every filter in a
// near-black UI opened a system menu with its own metrics, its own ✓ column and its own
// corner radius — the one surface in the product that ignored the design system. Its width
// also came from the OS (see the sizer in the template, which keeps the old sizing without
// the old popup), and it could not carry anything but text.
//
// Keyboard model is the ARIA combobox: focus stays on the trigger — the button, or the search
// input in `searchable` mode — and the active row is announced through
// `aria-activedescendant`. That keeps the LIST out of the tab order and out of the focus traps
// it opens inside (KModal is a QDialog, which re-grabs focus from anything under <body>).
const props = defineProps<{
  label?: string;
  modelValue?: string;
  // `readonly` because this component only ever maps over the list: a caller whose options are
  // a frozen module constant (TRIGGER_SOURCE_OPTIONS) must not have to copy them per render.
  options: readonly string[] | readonly KSelectOption[];
  placeholder?: string;
  disabled?: boolean;
  // Turns the trigger into a text field that filters the list as you type. For a picker whose
  // rows are counted in dozens — the model catalog is ~26 entries all named «Claude …» —
  // scrolling is the wrong instrument, and closed-list prefix type-ahead cannot help when
  // every label shares its first word. Left off elsewhere: a four-row picker with a caret
  // that suddenly takes a caret is a text box that looks editable and is not.
  searchable?: boolean;
}>();

const emit = defineEmits<{ 'update:modelValue': [value: string] }>();

// Ids have to be unique per instance: `aria-activedescendant` points at a row in a panel
// that lives under <body>, far from this component's subtree. A counter is enough — Vue
// 3.5's `useId()` is newer than this app's `vue@^3.4` floor.
const uid = (seq += 1);
const triggerId = `k-select-${uid}`;
const labelId = `k-select-label-${uid}`;
const listId = `k-select-list-${uid}`;
const optionId = (i: number): string => `k-select-opt-${uid}-${i}`;

// Nothing selected and nothing to call it. An em dash rather than a blank control: the
// AgentsPage branch picker is empty until a project is bound, and an empty box reads as a
// component that failed to render.
const EMPTY_LABEL = '—';
// How long a type-ahead buffer stays open. Long enough to spell «pmi» at a normal pace,
// short enough that a later unrelated keystroke starts its own search.
const TYPE_RESET_MS = 800;

const normalized = computed<KSelectOption[]>(() =>
  props.options.map((o) => (typeof o === 'string' ? { value: o, label: o } : o)),
);

// A value the caller never offered still gets an option of its own — a membership that has
// not loaded yet, a workspace someone else just deleted. Without it the control would show
// something it does not hold, and the first keystroke would silently rewrite the model. The
// label is the raw value: there is nothing better to show for an id nobody can resolve.
const mergedOptions = computed<KSelectOption[]>(() => {
  const v = props.modelValue;
  if (!v || normalized.value.some((o) => o.value === v)) return normalized.value;
  return [{ value: v, label: v }, ...normalized.value];
});

// The placeholder is a real row, exactly as it was a real `<option value="">`: '' means «no
// filter» / «не призначено» across the app, and it must be reachable AFTER a pick.
const items = computed<KSelectOption[]>(() =>
  props.placeholder !== undefined
    ? [{ value: '', label: props.placeholder }, ...mergedOptions.value]
    : mergedOptions.value,
);

const current = computed(() => props.modelValue ?? '');
// Indexes `items` (the FULL list), not `visible`: the field must keep naming what the control
// holds while a query hides that row.
const selectedIndex = computed(() => items.value.findIndex((o) => o.value === current.value));
const currentLabel = computed(() => items.value[selectedIndex.value]?.label ?? EMPTY_LABEL);
const showsPlaceholder = computed(() => !current.value);

// The live search box, empty unless `searchable` and the operator has typed. Reset by
// close(), so a reopened list always starts on the whole catalog.
const query = ref('');
// What the list actually renders. Every row index in this component — `activeIndex`,
// `optionId`, `commit` — is an index into THIS array, not into `items`.
const visible = computed<readonly KSelectOption[]>(() =>
  props.searchable ? filterByQuery(items.value, query.value) : items.value,
);
// Told apart because the two states have different cures: an empty catalog is «nothing to
// pick here», a query that matched nothing is «that word is not in this list».
const emptyText = computed(() => (query.value ? t('kit.select.notFound') : t('kit.select.noOptions')));

const open = ref(false);
// Placement runs after the panel is in the DOM (it has to be measured first), so the first
// frame would otherwise paint at 0,0 before jumping into place.
const placed = ref(false);
const activeIndex = ref(-1);
const activeId = computed(() =>
  open.value && activeIndex.value >= 0 && activeIndex.value < visible.value.length
    ? optionId(activeIndex.value)
    : undefined,
);
// Geometry and pointer containment: the whole control, which in `searchable` mode is the
// shell around the input and its caret — measuring the inset input would hang the list 11px
// off its field and a caret click would read as an outside click.
const shellEl = ref<HTMLElement | null>(null);
const inputEl = ref<HTMLInputElement | null>(null);
const popEl = ref<HTMLElement | null>(null);

// Where the keyboard lives: the search input when there is one, the button otherwise.
function focusTrigger(): void {
  (inputEl.value ?? shellEl.value)?.focus();
}

// The panel's UNCLAMPED height, measured once per open — and once more whenever `items`
// changes (watched below). `place()` also runs on every scroll frame, and clearing
// `max-height` to re-measure on each of those is a layout thrash for a list that cannot
// have changed. Zero means «measure on the next place()».
let naturalH = 0;
let typed = '';
let typedAt = 0;

function toggle(): void {
  if (open.value) close();
  else void openMenu();
}

async function openMenu(): Promise<void> {
  if (props.disabled || open.value) return;
  // Opening lands on the current value, so ↑/↓ continue from what the control holds. Resolved
  // against `visible`, because a query typed into the closed field opens the list already
  // filtered — and the held value is usually not among the matches.
  const at = visible.value.findIndex((o) => o.value === current.value);
  activeIndex.value = at >= 0 ? at : 0;
  typed = '';
  naturalH = 0;
  open.value = true;
  placed.value = false;
  document.addEventListener('click', onDocClick, true);
  // `capture` so a list nested in a scrolling pane follows its trigger: a scroll inside the
  // board's columns never bubbles to window.
  window.addEventListener('scroll', place, { capture: true, passive: true });
  window.addEventListener('resize', place);
  await nextTick();
  place();
  scrollActiveIntoView();
  placed.value = true;
}

function close(): void {
  if (!open.value) return;
  open.value = false;
  placed.value = false;
  document.removeEventListener('click', onDocClick, true);
  window.removeEventListener('scroll', place, true);
  window.removeEventListener('resize', place);
  // A reopened list starts on the whole catalog: a stale query is a list that silently hides
  // rows the operator never asked to hide.
  query.value = '';
}

function commit(i: number): void {
  const opt = visible.value[i];
  close();
  // Focus goes back to the control, not to <body>: a pick with the keyboard must leave the
  // next ↓ or Tab where the user left off.
  focusTrigger();
  if (!opt || opt.value === current.value) return;
  emit('update:modelValue', opt.value);
}

function place(): void {
  const t = shellEl.value;
  const p = popEl.value;
  if (!t || !p) return;
  const r = t.getBoundingClientRect();
  // A trigger scrolled out of sight leaves the list an orphan: it would be clamped to the
  // viewport edge, floating beside nothing, and a pick would write to a control the user
  // can no longer see. Close instead — the same call that keeps it glued while visible.
  if (r.bottom <= 0 || r.top >= window.innerHeight || r.right <= 0 || r.left >= window.innerWidth) {
    close();
    return;
  }
  // At least as wide as its trigger, so the two read as one object. The upper bound is CSS.
  // Width first: it decides how much of a long label wraps, i.e. the height measured next.
  p.style.minWidth = `${Math.round(r.width)}px`;
  if (!naturalH) {
    p.style.maxHeight = '';
    naturalH = p.offsetHeight;
  }
  const at = placeMenu(
    r,
    { width: p.offsetWidth, height: naturalH },
    { width: window.innerWidth, height: window.innerHeight },
  );
  p.style.left = `${at.left}px`;
  p.style.top = `${at.top}px`;
  p.style.maxHeight = `${at.maxHeight}px`;
  // Read by the entrance offset in this file's styles: a list that opened upward has to
  // rest below its final position, not above it.
  p.dataset.side = at.side;
}

function scrollActiveIntoView(): void {
  if (activeIndex.value < 0) return;
  document.getElementById(optionId(activeIndex.value))?.scrollIntoView({ block: 'nearest' });
}

function moveTo(i: number): void {
  const n = visible.value.length;
  if (!n) return;
  activeIndex.value = ((i % n) + n) % n;
  scrollActiveIntoView();
}

// Every keystroke in the search field. The list opens on the first character typed into a
// closed field — that is the whole point of the mode — and the active row resets to the top
// match, so Enter takes the best hit without an ↓ first.
function onQuery(e: Event): void {
  query.value = (e.target as HTMLInputElement).value;
  if (!open.value) void openMenu();
  activeIndex.value = visible.value.length ? 0 : -1;
}

// Tab into a closed field and the whole label is SELECTED, so the first letter typed replaces
// it instead of being spliced into it — the query is literally the field's text, and
// «cClaude Opus 4.1» matches nothing. The other two ways in are already safe: a pointer open
// empties the field (the value binding follows `open`), and a commit refocuses an input that
// never lost focus (the rows prevent mousedown), so neither leaves a highlight behind.
function onFieldFocus(e: FocusEvent): void {
  (e.target as HTMLInputElement).select();
}

function onKeydown(e: KeyboardEvent): void {
  if (props.disabled) return;

  if (!open.value) {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Enter' || (e.key === ' ' && !props.searchable)) {
      e.preventDefault();
      void openMenu();
    }
    // No closed-state type-ahead on purpose: on a native select that CHANGED the value
    // without ever showing the alternatives, which is how a stray keystroke reassigned a
    // task. Here a letter opens nothing and writes nothing — except in `searchable` mode,
    // where a letter is text and `onQuery` opens the list around it.
    return;
  }

  switch (e.key) {
    case 'Escape':
      e.preventDefault();
      // Stopped here or the KModal around this control closes on the same key: Quasar's
      // escape handling is a document-level keydown listener.
      e.stopPropagation();
      close();
      return;
    case 'Tab':
      // Not prevented: focus moves on, the list just must not outlive it.
      close();
      return;
    case 'Enter':
      e.preventDefault();
      commit(activeIndex.value);
      return;
    case ' ':
      // A space is a word separator in a search query («4.5 son»), so only the button form
      // treats it as «pick this row».
      if (props.searchable) return;
      e.preventDefault();
      commit(activeIndex.value);
      return;
    case 'ArrowDown':
      e.preventDefault();
      moveTo(activeIndex.value + 1);
      return;
    case 'ArrowUp':
      e.preventDefault();
      moveTo(activeIndex.value - 1);
      return;
    case 'Home':
      // Left to the input in `searchable` mode: Home/End move the text caret there, and a
      // list jump the operator cannot undo mid-word is worse than no shortcut.
      if (props.searchable) return;
      e.preventDefault();
      moveTo(0);
      return;
    case 'End':
      if (props.searchable) return;
      e.preventDefault();
      moveTo(visible.value.length - 1);
      return;
    default:
      // The search field does its own filtering through `onQuery`; prefix type-ahead is for
      // the closed-list form, where typing has nowhere else to go.
      if (!props.searchable && e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        typeahead(e.key);
      }
  }
}

function typeahead(ch: string): void {
  const now = Date.now();
  typed = now - typedAt > TYPE_RESET_MS ? ch : typed + ch;
  typedAt = now;
  const labels = items.value.map((o) => o.label);
  // One letter cycles to the NEXT match — repeated «o» walks the o-names, as a native select
  // did. A longer buffer refines the current match, so it searches from where it already is.
  const from = typed.length === 1 ? activeIndex.value + 1 : Math.max(activeIndex.value, 0);
  let hit = matchByPrefix(labels, typed, from);
  // A buffer that no longer matches anything is stale (a new search typed inside the
  // window), so the last letter gets its own attempt.
  if (hit < 0 && typed.length > 1) {
    typed = ch;
    hit = matchByPrefix(labels, ch, activeIndex.value + 1);
  }
  if (hit >= 0) moveTo(hit);
}

// Outside click. Capture phase, and the click is SWALLOWED: while a list is open the next
// click anywhere else only dismisses it, the way an OS menu does. Without that, the first
// click after opening a select inside a KModal lands on the dialog's backdrop and closes the
// whole modal — the user loses a half-filled task form to a stray click.
//
// `click`, not `pointerdown`: dismissing on the press would leave the release to act on
// whatever is underneath, and swallowing it then needs a one-shot listener that outlives
// presses which never become clicks (a drag, a text selection).
function onDocClick(e: MouseEvent): void {
  const target = e.target as Node | null;
  if (!target) return;
  // The whole control is excluded — trigger, search input and caret — so its own handlers
  // still toggle, or place a text caret, instead of closing twice.
  if (popEl.value?.contains(target) || shellEl.value?.contains(target)) return;
  e.preventDefault();
  e.stopPropagation();
  close();
}

// A control that goes disabled (the board locks the assignee of a running task) or loses its
// rows must not keep an open list; a list whose rows changed while open must be re-measured.
watch(
  () => props.disabled,
  (off) => {
    if (off) close();
  },
);
// Watched by IDENTITY, not by length: `visible` is a new array on every query change, and a
// filter that keeps the row COUNT can still change the panel's height (one label wraps, the
// next does not). `filterByQuery` returns the input array unchanged when nothing is typed,
// so an idle control never re-measures.
watch(visible, async (rows) => {
  if (!open.value) return;
  if (!rows.length) activeIndex.value = -1;
  await nextTick();
  naturalH = 0;
  place();
  // The list may have been scrolled far down when the query narrowed it: the top match has
  // to be on screen, not merely active.
  scrollActiveIntoView();
});

onBeforeUnmount(close);
</script>

<style scoped lang="scss">
.k-select {
  display: flex;
  flex-direction: column;
  gap: 6px;
  font-family: var(--k-font-ui);
  min-width: 0;
}

.k-select__label {
  text-align: left;
  font-size: 13px;
  font-weight: 400;
  color: var(--k-text);
  cursor: pointer;
}

.k-select__input {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  min-width: 0;
  font-family: var(--k-font-mono);
  font-size: 13px;
  line-height: 17px;
  text-align: left;
  color: var(--k-text);
  background: var(--k-surface);
  border: 1px solid var(--k-line-strong);
  padding: 9px 11px;
  border-radius: var(--k-r);
  outline: none;
  cursor: pointer;
  transition: border-color 0.12s, box-shadow 0.12s, color 0.12s;

  &:hover:not(:disabled):not(.k-select__input--disabled) {
    border-color: var(--k-accent);
  }

  // Both states get the accent frame: the ring says «this control has the keyboard», and an
  // open list is exactly that. `:focus-visible` rather than `:focus` so a mouse pick does
  // not leave a ring behind on the closed control.
  &:focus-visible,
  &.k-select__input--open {
    border-color: var(--k-accent);
    box-shadow: inset 0 0 0 1px var(--k-accent);
  }

  &:disabled,
  &.k-select__input--disabled {
    opacity: 0.45;
    cursor: not-allowed;
  }
}

// Placeholder and «nothing selected» are muted, as they are in KField: the control's own
// value must not read the same as a prompt for one.
.k-select__input--empty {
  color: var(--k-muted);
}

// ── Searchable variant ──────────────────────────────────────────────────────
//
// A <div> wearing the trigger's clothes, because the control it holds is an <input> and an
// input cannot contain the caret button. Same surface, same frame; the ring comes from
// `:focus-within` (the frame belongs to the shell, the keyboard to the input inside it) and
// `:focus-visible` cannot serve here — a click into a text field must show its ring.
.k-select__shell {
  cursor: text;

  &:focus-within {
    border-color: var(--k-accent);
    box-shadow: inset 0 0 0 1px var(--k-accent);
  }
}

// Bare text on the shell's surface: every visual belongs to the shell, so the input keeps
// only its caret and its own muted placeholder — which is where the CURRENT value is shown
// while a query is being typed over it.
.k-select__text {
  grid-area: 1 / 1;
  width: 100%;
  min-width: 0;
  font: inherit;
  color: inherit;
  background: none;
  border: 0;
  padding: 0;
  outline: none;
  text-overflow: ellipsis;

  &::placeholder {
    color: var(--k-muted);
    opacity: 1;
  }

  &:disabled {
    color: inherit;
    cursor: not-allowed;
  }
}

.k-select__toggle {
  flex: none;
  display: flex;
  align-items: center;
  padding: 0;
  border: 0;
  background: none;
  color: inherit;
  cursor: pointer;

  &:disabled {
    cursor: not-allowed;
  }
}

// One grid cell holding the visible value and the hidden width copies. `minmax(0, 1fr)`
// keeps the track shrinkable — the widest option decides the control's IDEAL width, not its
// minimum, so a page that pins a measure still gets an ellipsis instead of an overflow.
.k-select__box {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  min-width: 0;
  overflow: hidden;
}

.k-select__value,
.k-select__sizer {
  grid-area: 1 / 1;
}

.k-select__value {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

// Contributes width and nothing else: `max-height: 0` keeps the copies out of the row's
// height, `visibility: hidden` out of the paint and out of the accessibility tree.
.k-select__sizer {
  display: flex;
  flex-direction: column;
  max-height: 0;
  overflow: hidden;
  visibility: hidden;
  pointer-events: none;

  > span {
    white-space: nowrap;
  }
}

// Drawn, not typed — the house rule KWorkspaceRow's fold marker states at length: the UI
// face carries no geometric-shapes glyph, so a ▾ arrives from a fallback font and hangs
// below the control's centre line. A clipped box has no baseline to drift.
.k-select__caret {
  flex: none;
  width: 9px;
  height: 5px;
  background: currentColor;
  clip-path: polygon(0 0, 100% 0, 50% 100%);
  opacity: 0.7;
  transition: transform 0.12s ease, opacity 0.12s ease;
}

.k-select__input--open .k-select__caret {
  transform: rotate(180deg);
  opacity: 1;
}

// ── The list ────────────────────────────────────────────────────────────────
//
// Same glass recipe as the app's other floating surfaces (the tooltip, the Менеджмент log
// popover): translucent fill over a backdrop blur, hairline border, 1px inset top highlight
// for the lit edge. z-index sits above QDialog's 6000 — these open inside modals — and below
// the toast layer at 7000, which is the one thing that may cover a menu.
.k-select__pop {
  position: fixed;
  top: 0;
  left: 0;
  z-index: 6500;
  box-sizing: border-box;
  // The trigger's width is the floor (written by place()); this is the ceiling, so a long
  // «Постачальник, SaaS-залежність, vendor lock-in» wraps instead of crossing the screen.
  max-width: min(calc(100vw - 16px), 420px);
  overflow-y: auto;
  // No scroll chaining: a wheel at the end of the list must not start scrolling the board
  // behind it.
  overscroll-behavior: contain;
  padding: 4px;
  background: color-mix(in srgb, var(--k-surface2) 92%, transparent);
  -webkit-backdrop-filter: blur(22px) saturate(150%);
  backdrop-filter: blur(22px) saturate(150%);
  border: var(--k-rule-thin) solid var(--k-line-strong);
  border-radius: var(--k-r);
  box-shadow:
    var(--k-shadow-pop),
    inset 0 1px 0 color-mix(in srgb, #fff 8%, transparent);
  font-family: var(--k-font-mono);
  font-size: 13px;
  color: var(--k-text);
  opacity: 0;
  transition: opacity 0.12s ease, transform 0.12s cubic-bezier(0.4, 0, 0.2, 1);
  // Rests 3px toward its trigger, so the list reads as emerging from the control. Flipped
  // for a list that had to open upward (`data-side`, written by place()).
  transform: translateY(-3px);
}

.k-select__pop[data-side='top'] {
  transform: translateY(3px);
}

.k-select__pop--placed {
  opacity: 1;
  transform: none;
}

.k-select__opt {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 7px 9px;
  border-radius: var(--k-r-sm);
  cursor: pointer;
  // Long category names wrap rather than truncate: in the list the whole label is the point.
  white-space: normal;
  overflow-wrap: anywhere;
}

// Hover and keyboard share ONE highlight. Two would mean two «current» rows the moment a
// pointer rests on the list while ↓ walks it.
.k-select__opt--active {
  background: color-mix(in srgb, var(--k-accent) 18%, transparent);
}

.k-select__opt--selected {
  color: var(--k-accent);
}

// Fixed gutter whether or not the tick is there, so labels line up down the list.
.k-select__mark {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 10px;
  height: 17px;
}

.k-select__check {
  width: 4px;
  height: 8px;
  border: solid currentColor;
  border-width: 0 1.5px 1.5px 0;
  transform: rotate(45deg) translate(-1px, -1px);
}

.k-select__empty {
  padding: 7px 9px;
  font-size: 12px;
  color: var(--k-muted);
}

// House convention: motion is opt-out. The list still fades — an instantly painted overlay
// is a flash — but nothing travels.
@media (prefers-reduced-motion: reduce) {
  .k-select__pop,
  .k-select__pop[data-side='top'] {
    transform: none;
  }

  .k-select__input--open .k-select__caret {
    transition: none;
  }
}
</style>
