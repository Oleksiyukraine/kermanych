<template>
  <div class="k-date">
    <label v-if="label" :for="inputId" class="k-date__label">{{ label }}</label>

    <div
      ref="shellEl"
      class="k-date__shell"
      :class="{ 'k-date__shell--open': open, 'k-date__shell--disabled': disabled }"
    >
      <input
        :id="inputId"
        ref="inputEl"
        class="k-date__input"
        type="text"
        inputmode="numeric"
        autocomplete="off"
        role="combobox"
        aria-haspopup="grid"
        :aria-expanded="open"
        :aria-controls="popId"
        :aria-activedescendant="open ? cellId(activeIso) : undefined"
        :value="text"
        :placeholder="placeholder ?? 'дд.мм.рррр'"
        :disabled="disabled"
        @input="onInput"
        @blur="onBlur"
        @keydown="onKeydown"
      />
      <button
        type="button"
        class="k-date__toggle"
        :aria-label="open ? 'Закрити календар' : 'Відкрити календар'"
        :aria-expanded="open"
        :disabled="disabled"
        tabindex="-1"
        @click="toggle"
      >
        <span class="k-date__glyph" aria-hidden="true"></span>
      </button>
    </div>

    <!-- Under <body>, `position: fixed`, placed by lib/menu.ts — the same treatment KSelect's
         list gets, for the same reason: the risk editor is a modal body with its own scroll,
         and an in-flow calendar would be cropped by it. -->
    <Teleport to="body">
      <div
        v-if="open"
        :id="popId"
        ref="popEl"
        class="k-date__pop"
        :class="{ 'k-date__pop--placed': placed }"
        role="dialog"
        aria-label="Календар"
      >
        <div class="k-date__head">
          <button
            type="button"
            class="k-date__step"
            aria-label="Попередній місяць"
            @mousedown.prevent
            @click="stepMonth(-1)"
          ><span class="k-date__chev k-date__chev--prev" aria-hidden="true"></span></button>
          <span class="k-date__title" aria-live="polite">{{ title }}</span>
          <button
            type="button"
            class="k-date__step"
            aria-label="Наступний місяць"
            @mousedown.prevent
            @click="stepMonth(1)"
          ><span class="k-date__chev" aria-hidden="true"></span></button>
        </div>

        <div class="k-date__week" aria-hidden="true">
          <span v-for="w in WEEKDAY_LABELS" :key="w" class="k-date__wd">{{ w }}</span>
        </div>

        <div class="k-date__grid" role="grid">
          <div
            v-for="cell in cells"
            :id="cellId(cell.iso)"
            :key="cell.iso"
            class="k-date__day"
            :class="{
              'k-date__day--out': !cell.inMonth,
              'k-date__day--active': cell.iso === activeIso,
              'k-date__day--today': cell.iso === today,
              'k-date__day--selected': cell.iso === modelValue,
            }"
            role="gridcell"
            :aria-selected="cell.iso === modelValue"
            @mouseenter="activeIso = cell.iso"
            @mousedown.prevent
            @click="commit(cell.iso)"
          >{{ cell.day }}</div>
        </div>

        <div class="k-date__foot">
          <button type="button" class="k-date__action" @mousedown.prevent @click="commit(today)">Сьогодні</button>
          <button
            type="button"
            class="k-date__action k-date__action--clear"
            :disabled="!modelValue"
            @mousedown.prevent
            @click="commit('')"
          >Очистити</button>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<script lang="ts">
// Instance counter for the ids below — MODULE scope, like KSelect's: `<script setup>` runs
// per instance, and `aria-activedescendant` has to point at THIS field's grid cell.
let seq = 0;
</script>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import {
  WEEKDAY_LABELS,
  formatIsoDate,
  isoParts,
  monthGrid,
  monthTitle,
  parseTypedDate,
  shiftDays,
  shiftMonths,
  todayIso,
} from '../../lib/calendar';
import { placeMenu } from '../../lib/menu';

// A date field with the app's own calendar. Styled like KField — label above, surface input,
// accent focus ring — with a glass month grid on the same popup primitive as KSelect.
//
// Why not `<input type="date">`, which this replaced: the picker is drawn by the operating
// system. `color-scheme` is the only token that reaches it, so the risks editor opened a
// macOS calendar — its own metrics, its own week start, its own Latin month names — beside
// two Ukrainian fields, and Chromium's built-in `dd.mm.yyyy` spinner refused paste.
//
// The TEXT input stays the primary control and keeps DOM focus the whole time the calendar is
// open, for two reasons: typing «20.09.2026» is faster than eleven arrow presses for a date
// eight months out, and a QModal (QDialog) pulls focus back out of any node that is not its
// own child — which a body-teleported grid is not. Day cells are therefore driven by
// `aria-activedescendant` rather than by moving focus into the grid.
const props = defineProps<{
  label?: string;
  /** ISO `YYYY-MM-DD`, or '' for «not answered». */
  modelValue?: string;
  placeholder?: string;
  disabled?: boolean;
  /**
   * Epoch millis for «today». The caller owns the clock — the same contract lib/time.ts
   * states — so a form that already ticks (RiskEditor's `useNow`) marks the right day at
   * midnight instead of at mount.
   */
  nowMs?: number;
}>();

const emit = defineEmits<{ 'update:modelValue': [value: string] }>();

const uid = (seq += 1);
const inputId = `k-date-${uid}`;
const popId = `k-date-pop-${uid}`;
const cellId = (iso: string): string => `k-date-cell-${uid}-${iso}`;

const open = ref(false);
const placed = ref(false);
const inputEl = ref<HTMLInputElement | null>(null);
// The frame, not the input: the calendar is anchored to the whole control, toggle included.
const shellEl = ref<HTMLElement | null>(null);
const popEl = ref<HTMLElement | null>(null);

// What the input SHOWS, which is not the model: it holds half-typed text («20.09.20») that is
// not a date yet, and the model must not see those.
const text = ref(formatIsoDate(props.modelValue));
// The day the grid highlights and Enter picks. Follows the model, then the keyboard.
const activeIso = ref('');

const today = computed(() => todayIso(props.nowMs ?? Date.now()));

// The month on screen comes from the ACTIVE day, so stepping months and moving days are one
// piece of state — a separate «visible month» drifts out of step with the highlighted day.
const view = computed(() => isoParts(activeIso.value) ?? isoParts(today.value)!);
const cells = computed(() => monthGrid(view.value.year, view.value.month));
const title = computed(() => monthTitle(view.value.year, view.value.month));

let naturalH = 0;

// An outside edit — the editor resetting its draft, a load landing — must reach the input,
// but a keystroke of the user's own must not be reformatted under the caret.
watch(
  () => props.modelValue,
  (v) => {
    if (parseTypedDate(text.value) === (v || undefined)) return;
    text.value = formatIsoDate(v);
  },
);

watch(
  () => props.disabled,
  (off) => {
    if (off) close();
  },
);

function onInput(e: Event): void {
  text.value = (e.target as HTMLInputElement).value;
  const iso = parseTypedDate(text.value);
  if (iso) {
    activeIso.value = iso;
    // A complete date reaches the model as it is typed; the calendar follows along.
    if (iso !== props.modelValue) emit('update:modelValue', iso);
    // A month step can redraw the popup at a different width for a longer title, so the
    // measured height is dropped and taken again.
    if (open.value) {
      naturalH = 0;
      place();
    }
  } else if (!text.value.trim() && props.modelValue) {
    // Cleared by hand. '' is «not answered», which is a legal answer for both risk dates.
    emit('update:modelValue', '');
  }
}

// Typing stops mid-date more often than not — a tab away, a click on Save. Rather than keep
// text the model does not hold, the field snaps back to what it holds.
function onBlur(): void {
  if (open.value) return;
  text.value = formatIsoDate(props.modelValue);
}

function toggle(): void {
  if (open.value) close();
  else void openCalendar();
}

async function openCalendar(): Promise<void> {
  if (props.disabled || open.value) return;
  activeIso.value = isoParts(props.modelValue) ? props.modelValue! : today.value;
  open.value = true;
  placed.value = false;
  naturalH = 0;
  document.addEventListener('click', onDocClick, true);
  window.addEventListener('scroll', place, { capture: true, passive: true });
  window.addEventListener('resize', place);
  await nextTick();
  place();
  placed.value = true;
  // The input keeps the keyboard: every shortcut below is bound to it, and a click on the
  // toggle button would otherwise leave the grid unreachable without the mouse.
  inputEl.value?.focus();
}

function close(): void {
  if (!open.value) return;
  open.value = false;
  placed.value = false;
  document.removeEventListener('click', onDocClick, true);
  window.removeEventListener('scroll', place, true);
  window.removeEventListener('resize', place);
}

function commit(iso: string): void {
  close();
  inputEl.value?.focus();
  text.value = formatIsoDate(iso);
  if ((iso || '') !== (props.modelValue || '')) emit('update:modelValue', iso);
}

function place(): void {
  const t = shellEl.value;
  const p = popEl.value;
  if (!t || !p) return;
  const r = t.getBoundingClientRect();
  // A field scrolled out of sight leaves the calendar an orphan beside nothing — same rule
  // as KSelect's list.
  if (r.bottom <= 0 || r.top >= window.innerHeight || r.right <= 0 || r.left >= window.innerWidth) {
    close();
    return;
  }
  p.style.minWidth = `${Math.round(r.width)}px`;
  if (!naturalH) naturalH = p.offsetHeight;
  const at = placeMenu(
    r,
    { width: p.offsetWidth, height: naturalH },
    { width: window.innerWidth, height: window.innerHeight },
  );
  p.style.left = `${at.left}px`;
  p.style.top = `${at.top}px`;
  p.dataset.side = at.side;
}

function stepMonth(by: number): void {
  activeIso.value = shiftMonths(activeIso.value || today.value, by);
  inputEl.value?.focus();
}

function onKeydown(e: KeyboardEvent): void {
  if (props.disabled) return;

  if (!open.value) {
    // ArrowDown is the APG opener for a combobox; Alt+ArrowDown is what a native date input
    // answered to, so both work.
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      void openCalendar();
    }
    return;
  }

  switch (e.key) {
    case 'Escape':
      e.preventDefault();
      // Stopped here so the KModal this field sits in does not close on the same key.
      e.stopPropagation();
      close();
      text.value = formatIsoDate(props.modelValue);
      return;
    case 'Enter':
      e.preventDefault();
      commit(activeIso.value);
      return;
    case 'Tab':
      close();
      return;
    // Weeks, not days: ArrowLeft/ArrowRight stay with the caret, because the input is still
    // being typed into. A specific day is one typed date away, which is why this pair is
    // enough — see the note at the top of the file.
    case 'ArrowDown':
      e.preventDefault();
      activeIso.value = shiftDays(activeIso.value || today.value, 7);
      return;
    case 'ArrowUp':
      e.preventDefault();
      activeIso.value = shiftDays(activeIso.value || today.value, -7);
      return;
    case 'PageDown':
      e.preventDefault();
      stepMonth(e.shiftKey ? 12 : 1);
      return;
    case 'PageUp':
      e.preventDefault();
      stepMonth(e.shiftKey ? -12 : -1);
      return;
  }
}

function onDocClick(e: MouseEvent): void {
  const target = e.target as Node | null;
  if (!target) return;
  if (popEl.value?.contains(target) || shellEl.value?.contains(target)) return;
  // Swallowed, like KSelect's: the first click elsewhere dismisses the calendar and nothing
  // else, so a stray click cannot take the whole risk editor with it.
  e.preventDefault();
  e.stopPropagation();
  close();
  text.value = formatIsoDate(props.modelValue);
}

onBeforeUnmount(close);
</script>

<style scoped lang="scss">
.k-date {
  display: flex;
  flex-direction: column;
  gap: 6px;
  font-family: var(--k-font-ui);
  min-width: 0;
}

.k-date__label {
  text-align: left;
  font-size: 13px;
  font-weight: 400;
  color: var(--k-text);
  cursor: pointer;
}

// The frame lives on the SHELL, not on the input: the calendar button sits inside the same
// box, and a border per control would read as two fields.
.k-date__shell {
  display: flex;
  align-items: stretch;
  min-width: 0;
  background: var(--k-surface);
  border: 1px solid var(--k-line-strong);
  border-radius: var(--k-r);
  transition: border-color 0.12s, box-shadow 0.12s;

  &:focus-within,
  &.k-date__shell--open {
    border-color: var(--k-accent);
    box-shadow: inset 0 0 0 1px var(--k-accent);
  }
}

.k-date__shell--disabled {
  opacity: 0.45;
}

.k-date__input {
  flex: 1;
  min-width: 0;
  font-family: var(--k-font-mono);
  font-size: 13px;
  line-height: 17px;
  color: var(--k-text);
  background: transparent;
  border: none;
  padding: 9px 0 9px 11px;
  outline: none;

  &::placeholder {
    color: var(--k-muted);
  }

  &:disabled {
    cursor: not-allowed;
  }
}

.k-date__toggle {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  padding: 0;
  background: transparent;
  border: none;
  color: var(--k-muted);
  cursor: pointer;
  transition: color 0.12s;

  &:hover:not(:disabled),
  .k-date__shell--open & {
    color: var(--k-accent);
  }

  &:disabled {
    cursor: not-allowed;
  }
}

// Drawn, not typed: 📅 is an emoji on every platform and would drop a colour picture into a
// monochrome UI, while ▤-style glyphs come from a fallback face and sit off the centre line.
// A 12×12 box with a hanger row reads as a calendar at this size.
.k-date__glyph {
  width: 12px;
  height: 12px;
  border: 1px solid currentColor;
  border-radius: 2px;
  border-top-width: 4px;
  position: relative;

  &::after {
    content: '';
    position: absolute;
    left: 1px;
    right: 1px;
    top: 3px;
    border-top: 1px solid currentColor;
    opacity: 0.55;
  }
}

// ── The calendar ────────────────────────────────────────────────────────────
//
// Same glass as KSelect's list and the tooltip, same layer: above QDialog's 6000, below the
// 7000 toast surface.
.k-date__pop {
  position: fixed;
  top: 0;
  left: 0;
  z-index: 6500;
  box-sizing: border-box;
  padding: 8px;
  background: color-mix(in srgb, var(--k-surface2) 92%, transparent);
  -webkit-backdrop-filter: blur(22px) saturate(150%);
  backdrop-filter: blur(22px) saturate(150%);
  border: var(--k-rule-thin) solid var(--k-line-strong);
  border-radius: var(--k-r);
  box-shadow:
    var(--k-shadow-pop),
    inset 0 1px 0 color-mix(in srgb, #fff 8%, transparent);
  color: var(--k-text);
  opacity: 0;
  transition: opacity 0.12s ease, transform 0.12s cubic-bezier(0.4, 0, 0.2, 1);
  transform: translateY(-3px);
}

.k-date__pop[data-side='top'] {
  transform: translateY(3px);
}

.k-date__pop--placed {
  opacity: 1;
  transform: none;
}

.k-date__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 4px;
  padding: 2px 2px 8px;
}

.k-date__title {
  font-family: var(--k-font-ui);
  font-size: var(--k-fs-sm);
  font-weight: var(--k-fw-semibold);
}

.k-date__step {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  padding: 0;
  background: transparent;
  border: none;
  border-radius: var(--k-r-sm);
  color: var(--k-muted);
  cursor: pointer;

  &:hover {
    background: var(--k-surface);
    color: var(--k-text);
  }
}

// The same clipped triangle the rest of the kit uses for direction marks.
.k-date__chev {
  width: 5px;
  height: 9px;
  background: currentColor;
  clip-path: polygon(0 0, 100% 50%, 0 100%);
}

.k-date__chev--prev {
  clip-path: polygon(100% 0, 100% 100%, 0 50%);
}

.k-date__week,
.k-date__grid {
  display: grid;
  grid-template-columns: repeat(7, 32px);
  gap: 2px;
}

.k-date__wd {
  padding: 2px 0;
  text-align: center;
  font-family: var(--k-font-ui);
  font-size: var(--k-fs-xs);
  color: var(--k-faint);
}

.k-date__day {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 28px;
  border-radius: var(--k-r-sm);
  font-family: var(--k-font-mono);
  font-size: var(--k-fs-sm);
  cursor: pointer;
  // Tabular so the columns do not shuffle between 1 and 31 — mono is already fixed-width,
  // stated here because the grid depends on it.
  font-variant-numeric: tabular-nums;
}

// Neighbouring months stay reachable — a deadline on the 1st is picked from the 31st's row —
// but they recede, or the month on screen stops being obvious.
.k-date__day--out {
  color: var(--k-faint);
}

// Hover and keyboard share one highlight, as they do in KSelect.
.k-date__day--active {
  background: color-mix(in srgb, var(--k-accent) 18%, transparent);
}

// Today is outlined; the selected day is filled. Both at once still reads: the ring survives
// inside the fill.
.k-date__day--today {
  box-shadow: inset 0 0 0 1px var(--k-line-strong);
}

.k-date__day--selected {
  background: var(--k-accent);
  color: var(--k-on-accent);
}

.k-date__foot {
  display: flex;
  gap: 6px;
  padding-top: 8px;
  margin-top: 8px;
  border-top: var(--k-rule-thin) solid var(--k-line);
}

.k-date__action {
  flex: 1;
  padding: 6px 8px;
  background: transparent;
  border: 1px solid var(--k-line-strong);
  border-radius: var(--k-r-sm);
  color: var(--k-text);
  font-family: var(--k-font-ui);
  font-size: var(--k-fs-xs);
  cursor: pointer;
  transition: border-color 0.12s, color 0.12s;

  &:hover:not(:disabled) {
    border-color: var(--k-accent);
    color: var(--k-accent);
  }

  &:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }
}

@media (prefers-reduced-motion: reduce) {
  .k-date__pop,
  .k-date__pop[data-side='top'] {
    transform: none;
  }
}
</style>
