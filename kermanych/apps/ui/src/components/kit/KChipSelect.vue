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
      @click="open = !open"
    >
      <span v-if="icon" class="k-chip-select__icon" aria-hidden="true">{{ icon }}</span>
      <span class="k-chip-select__label">{{ currentLabel }}</span>
      <span class="k-chip-select__caret" aria-hidden="true">⌄</span>
    </button>

    <!-- Menu opens UPWARD: this chip's home is the composer's control row, which sits at the
         very bottom of the screen, so a downward menu would open off-viewport. -->
    <div v-if="open" class="k-chip-select__menu" role="menu" :aria-label="title">
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
        {{ o.label }}
      </button>
    </div>
  </span>
</template>

<script setup lang="ts" generic="T extends string">
import { computed, onBeforeUnmount, ref, watch } from 'vue';

// A flat chip that opens a small menu: `⚡ Високий ⌄`. The composer's control row needs a
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
}>();

const emit = defineEmits<{ 'update:modelValue': [value: T] }>();

const open = ref(false);
const rootEl = ref<HTMLElement | null>(null);

// A value with no matching option still has to print something: showing the raw value is the
// honest fallback (omp reporting a rung this build has no word for), never a blank chip.
const currentLabel = computed(() => props.options.find((o) => o.value === props.modelValue)?.label ?? props.modelValue);

function pick(value: T): void {
  open.value = false;
  if (value !== props.modelValue) emit('update:modelValue', value);
}

// Dismissal: a click anywhere outside, or Escape. Listeners exist only while the menu is
// open — this chip lives in a row that re-renders on every keystroke of the composer.
function onDocPointerDown(e: PointerEvent): void {
  if (!rootEl.value?.contains(e.target as Node)) open.value = false;
}
function onDocKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape') open.value = false;
}
watch(open, (isOpen) => {
  if (isOpen) {
    document.addEventListener('pointerdown', onDocPointerDown);
    document.addEventListener('keydown', onDocKeydown);
  } else {
    document.removeEventListener('pointerdown', onDocPointerDown);
    document.removeEventListener('keydown', onDocKeydown);
  }
});
// Unmounting with the menu open (the panel switches session mid-pick) must not leave the
// document listeners behind.
onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', onDocPointerDown);
  document.removeEventListener('keydown', onDocKeydown);
});
</script>

<style scoped lang="scss">
.k-chip-select {
  position: relative;
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

.k-chip-select__caret {
  font-size: 10px;
  line-height: 1;
  opacity: 0.5;
}

// floating surface — one of the few places this flat system uses a shadow.
.k-chip-select__menu {
  position: absolute;
  bottom: calc(100% + 6px);
  left: 0;
  z-index: 20;
  min-width: 160px;
  display: flex;
  flex-direction: column;
  padding: var(--k-sp-1);
  background: var(--k-surface);
  border: 1px solid var(--k-line-strong);
  border-radius: var(--k-r);
  box-shadow: var(--k-shadow-pop);
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
  white-space: nowrap;
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

// A fixed-width gutter for the selection dot, so the labels form one column whether or not
// their row is the selected one.
.k-chip-select__tick {
  width: 6px;
  flex: none;
  color: var(--k-accent);
}
</style>
