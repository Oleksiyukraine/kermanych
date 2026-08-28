<template>
  <div
    ref="rootEl"
    class="k-topnav"
    :class="{ 'k-topnav--animate': animate, 'k-topnav--dense': dense }"
    role="tablist"
    @keydown="onKeydown"
  >
    <span
      v-show="ready"
      class="k-topnav__thumb"
      :style="{ '--k-thumb-x': `${x}px`, '--k-thumb-w': `${width}px` }"
      aria-hidden="true"
    ></span>
    <button
      v-for="(option, i) in options"
      :key="option.value"
      :ref="(el) => setBtn(option.value, el)"
      :data-nav-value="option.value"
      class="k-topnav__seg"
      :class="{ 'k-topnav__seg--active': option.value === modelValue }"
      type="button"
      role="tab"
      :aria-selected="option.value === modelValue"
      :tabindex="(activeIndex < 0 ? i === 0 : i === activeIndex) ? 0 : -1"
      @click="emit('update:modelValue', option.value)"
    >
      {{ option.label }}
    </button>
  </div>
</template>

<script setup lang="ts">
// Segmented view nav. A recessed hairline track holds one button per option and a
// single thumb that TRAVELS to the active segment — the movement is what tells the
// operator the view changed, so the segment itself needs no loud fill. The brand
// accent is spent on the active label only; a whole vermilion pill up here
// competed with the accent's real job (primary actions, live status).
//
// Label weight is identical in every state on purpose: switching the active
// segment to semibold would re-measure the strip and nudge its neighbours
// sideways every time the thumb lands.
import { computed, ref } from 'vue';
import { useSlidingIndicator } from '../../composables/useSlidingIndicator';

// `options` is readonly because this component only ever reads it — that lets a
// caller hand over a frozen registry table (lib/settings.ts) without copying it
// into a mutable array first.
//
// `dense` is a GEOMETRY variant, not a second control: the settings rail is 280px
// wide and three Ukrainian scope words do not fit the header strip's 16px
// segment padding. Tightening it here keeps one tablist — one thumb, one travel,
// one set of arrow keys — instead of a page-local copy that drifts.
const props = defineProps<{
  modelValue: string;
  options: readonly { value: string; label: string }[];
  dense?: boolean;
}>();

const emit = defineEmits<{ 'update:modelValue': [value: string] }>();

const rootEl = ref<HTMLElement | null>(null);
const active = computed(() => props.modelValue);
const { x, width, ready, animate } = useSlidingIndicator(rootEl, active);

// WHICH SEGMENT IS ACTIVE, or -1 when the strip does not hold the current value
// at all — the shell parks the nav there whenever it is on a screen outside the
// table, e.g. Налаштування. That state has to stay Tab-reachable: with the roving
// tabindex keyed on a match alone, every segment fell to -1 and the whole view
// switcher dropped out of the tab order, so the only way back to Агенти was the
// mouse. The FIRST segment carries the tab stop instead.
const activeIndex = computed(() => props.options.findIndex((o) => o.value === props.modelValue));

// Roving focus needs the button elements to move focus onto; a tablist that
// answers only the mouse is not one.
const btns = new Map<string, HTMLElement>();
function setBtn(value: string, el: unknown): void {
  if (el instanceof HTMLElement) btns.set(value, el);
  else btns.delete(value);
}

const STEP: Record<string, number> = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 };

function onKeydown(e: KeyboardEvent): void {
  const i = activeIndex.value;
  const last = props.options.length - 1;
  if (last < 0) return;
  const step = STEP[e.key];
  const next =
    step !== undefined
      ? i < 0
        ? // Nothing is selected, so there is no neighbour to step from: enter the
          // ring from the end the arrow came from.
          step > 0
          ? 0
          : last
        : // Wrap: a segmented control is a ring, and dead-ending at the edges reads
          // as a broken key rather than a boundary.
          (i + step + props.options.length) % props.options.length
      : e.key === 'Home'
        ? 0
        : e.key === 'End'
          ? last
          : -1;
  if (next < 0) return;
  e.preventDefault();
  const target = props.options[next];
  if (!target) return;
  emit('update:modelValue', target.value);
  btns.get(target.value)?.focus();
}
</script>

<style scoped lang="scss">
.k-topnav {
  position: relative;
  display: inline-flex;
  align-items: center;
  gap: 2px;
  padding: 3px;
  // Recess, not a slab: a hairline ring over a barely-there tint, so the thumb is
  // the only thing on this strip with any weight.
  background: color-mix(in srgb, var(--k-surface2) 32%, transparent);
  border: var(--k-rule-thin) solid var(--k-line);
  border-radius: var(--k-r-pill);
}

.k-topnav__thumb {
  position: absolute;
  top: 3px;
  left: 0;
  height: calc(100% - 6px);
  width: var(--k-thumb-w);
  transform: translate3d(var(--k-thumb-x), 0, 0);
  // `--k-surface2` is the selected tint in BOTH themes (raised on the dark
  // canvas, a shade down on the light one), so the thumb reads as the chosen
  // segment either way.
  background: var(--k-surface2);
  border: var(--k-rule-thin) solid var(--k-line-strong);
  border-radius: var(--k-r-pill);
  box-shadow: var(--k-shadow-pop);
  pointer-events: none;
}

// Only after the first measured frame, so the thumb never slides in from x=0.
.k-topnav--animate .k-topnav__thumb {
  transition:
    transform 0.28s cubic-bezier(0.22, 1, 0.36, 1),
    width 0.28s cubic-bezier(0.22, 1, 0.36, 1);
}

.k-topnav__seg {
  position: relative;
  z-index: 1;
  appearance: none;
  border: none;
  cursor: pointer;
  padding: var(--k-sp-2) var(--k-sp-4);
  font-family: var(--k-font-ui);
  font-size: var(--k-fs-base);
  font-weight: var(--k-fw-medium);
  letter-spacing: -0.01em;
  line-height: 1;
  color: var(--k-muted);
  background: transparent;
  border-radius: var(--k-r-pill);
  white-space: nowrap;
  transition:
    color 0.16s ease,
    background 0.16s ease;

  // Ghost fill under the cursor: the strip answers the pointer before the click,
  // and it is what makes the thumb's arrival feel like a hand-off.
  &:hover:not(.k-topnav__seg--active) {
    color: var(--k-text);
    background: color-mix(in srgb, var(--k-surface2) 50%, transparent);
  }

  &:focus-visible {
    outline: var(--k-rule-thin) solid var(--k-accent);
    outline-offset: 2px;
  }
}

// The accent is spent here and nowhere else on this strip.
.k-topnav__seg--active {
  color: var(--k-accent);
}

// DENSE — the same strip in a narrow column. Geometry only: nothing about the
// thumb, the accent or the keyboard changes, so a dense strip is the same control
// the header carries, not a lookalike.
.k-topnav--dense .k-topnav__seg {
  padding: var(--k-sp-2) 10px;
  font-size: var(--k-fs-sm);
}

@media (prefers-reduced-motion: reduce) {
  .k-topnav--animate .k-topnav__thumb {
    transition: none;
  }
}
</style>
