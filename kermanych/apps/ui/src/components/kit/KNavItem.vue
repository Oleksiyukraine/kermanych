<template>
  <button
    class="k-nav-item"
    :class="{ 'k-nav-item--active': active }"
    type="button"
    v-tip="tip"
    :aria-label="tip"
    @click="emit('click')"
  >
    <span v-if="icon" class="k-nav-item__icon">
      <KIcon :name="icon" />
    </span>
    <span class="k-nav-item__label">{{ label }}</span>
    <KCount v-if="count != null" :value="count" />
  </button>
</template>

<script setup lang="ts">
// A sidebar navigation row: optional leading mark, a label, and an optional
// trailing count pill. Active rows lift onto surface2 with full-strength text.
//
// `tip` is for the minified rail, where the layout hides the label and the count with
// `display: none` — which takes them out of the accessibility tree too, leaving the button
// with no name at all. Set it to the label there and the mark gets both a tooltip and an
// accessible name; leave it unset while the label is visible, since a bubble repeating text
// already on screen is noise.
import KCount from './KCount.vue';
import KIcon, { type KIconName } from './KIcon.vue';

withDefaults(
  defineProps<{
    label: string;
    count?: number;
    active?: boolean;
    icon?: KIconName;
    tip?: string | undefined;
  }>(),
  { active: false },
);

const emit = defineEmits<{ click: [] }>();
</script>

<style scoped lang="scss">
.k-nav-item {
  display: flex;
  align-items: center;
  gap: var(--k-sp-2);
  width: 100%;
  padding: var(--k-sp-2) var(--k-sp-3);
  font-family: var(--k-font-ui);
  font-size: var(--k-fs-base);
  font-weight: var(--k-fw-medium);
  line-height: 1;
  text-align: left;
  color: var(--k-muted);
  background: transparent;
  border: 1px solid transparent;
  border-radius: var(--k-r);
  cursor: pointer;

  &:hover {
    color: var(--k-text);
  }
}

.k-nav-item--active {
  color: var(--k-text);
  background: var(--k-surface2);
}

.k-nav-item__icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
}

.k-nav-item__label {
  flex: 1;
}
</style>
