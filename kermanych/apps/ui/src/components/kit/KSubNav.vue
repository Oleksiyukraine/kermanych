<template>
  <nav
    ref="rootEl"
    class="k-subnav"
    :class="{ 'k-subnav--animate': animate }"
    role="tablist"
    :aria-label="ariaLabel"
    @keydown="onKeydown"
  >
    <button
      v-for="item in items"
      :key="item.value"
      :ref="(el) => setBtn(item.value, el)"
      :data-nav-value="item.value"
      class="k-subnav__item"
      :class="{ 'k-subnav__item--active': item.value === modelValue }"
      type="button"
      role="tab"
      :aria-selected="item.value === modelValue"
      :tabindex="item.value === modelValue ? 0 : -1"
      @click="emit('update:modelValue', item.value)"
    >
      {{ item.label }}
    </button>
    <span
      v-show="ready"
      class="k-subnav__bar"
      :style="{ '--k-bar-x': `${x}px`, '--k-bar-w': `${width}px` }"
      aria-hidden="true"
    ></span>
  </nav>
</template>

<script setup lang="ts">
// Page-level section nav: the strip that divides ONE screen into sections, one
// level below KTopNav's view switcher. Labels sit on a hairline baseline and a
// single accent bar slides under the active one.
//
// Deliberately not KTabs: those are the in-panel tabs of the agent detail pane
// (fixed set, inside a card, static underline per tab). This one addresses routes,
// carries the sliding bar, and owns roving focus.
import { computed, ref } from 'vue';
import { useSlidingIndicator } from '../../composables/useSlidingIndicator';

const props = defineProps<{
  modelValue: string;
  items: { value: string; label: string }[];
  ariaLabel?: string;
}>();

const emit = defineEmits<{ 'update:modelValue': [value: string] }>();

const rootEl = ref<HTMLElement | null>(null);
const active = computed(() => props.modelValue);
const { x, width, ready, animate } = useSlidingIndicator(rootEl, active);

const btns = new Map<string, HTMLElement>();
function setBtn(value: string, el: unknown): void {
  if (el instanceof HTMLElement) btns.set(value, el);
  else btns.delete(value);
}

const STEP: Record<string, number> = { ArrowRight: 1, ArrowLeft: -1 };

function onKeydown(e: KeyboardEvent): void {
  const i = props.items.findIndex((it) => it.value === props.modelValue);
  if (i < 0) return;
  const step = STEP[e.key];
  const next =
    step !== undefined
      ? (i + step + props.items.length) % props.items.length
      : e.key === 'Home'
        ? 0
        : e.key === 'End'
          ? props.items.length - 1
          : -1;
  if (next < 0) return;
  e.preventDefault();
  const target = props.items[next];
  if (!target) return;
  emit('update:modelValue', target.value);
  btns.get(target.value)?.focus();
}
</script>

<style scoped lang="scss">
.k-subnav {
  position: relative;
  display: flex;
  align-items: flex-end;
  gap: var(--k-sp-5);
  // The baseline the bar rides on. A pseudo-element rather than border-bottom, so
  // the 2px bar can overlap the 1px rule instead of stacking above it.
  &::after {
    content: '';
    position: absolute;
    left: 0;
    right: 0;
    bottom: 0;
    height: var(--k-rule-thin);
    background: var(--k-line);
  }
}

.k-subnav__item {
  appearance: none;
  border: none;
  background: transparent;
  cursor: pointer;
  padding: var(--k-sp-2) 0 var(--k-sp-3);
  font-family: var(--k-font-ui);
  font-size: var(--k-fs-base);
  // Constant across states: promoting the active label to semibold would shift
  // every label to its right by a pixel or two on each switch.
  font-weight: var(--k-fw-medium);
  letter-spacing: -0.01em;
  line-height: 1;
  color: var(--k-muted);
  white-space: nowrap;
  transition: color 0.16s ease;

  &:hover {
    color: var(--k-text);
  }

  &:focus-visible {
    outline: var(--k-rule-thin) solid var(--k-accent);
    outline-offset: 2px;
    border-radius: var(--k-r-sm);
  }
}

.k-subnav__item--active {
  color: var(--k-text);
}

.k-subnav__bar {
  position: absolute;
  left: 0;
  bottom: 0;
  z-index: 1;
  height: var(--k-rule-strong);
  width: var(--k-bar-w);
  transform: translate3d(var(--k-bar-x), 0, 0);
  background: var(--k-accent);
  border-radius: var(--k-rule-strong);
  // A breath of accent bleeding upward, so the bar looks lit rather than drawn.
  box-shadow: 0 -6px 16px -6px color-mix(in srgb, var(--k-accent) 65%, transparent);
  pointer-events: none;
}

.k-subnav--animate .k-subnav__bar {
  transition:
    transform 0.28s cubic-bezier(0.22, 1, 0.36, 1),
    width 0.28s cubic-bezier(0.22, 1, 0.36, 1);
}

@media (prefers-reduced-motion: reduce) {
  .k-subnav--animate .k-subnav__bar {
    transition: none;
  }
}
</style>
