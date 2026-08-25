<template>
  <button
    class="k-nav-item"
    :class="{ 'k-nav-item--active': active }"
    type="button"
    @click="emit('click')"
  >
    <span v-if="icon" class="k-nav-item__icon">{{ icon }}</span>
    <span class="k-nav-item__label">{{ label }}</span>
    <KCount v-if="count != null" :value="count" />
  </button>
</template>

<script setup lang="ts">
// A sidebar navigation row: optional leading glyph, a label, and an optional
// trailing count pill. Active rows lift onto surface2 with full-strength text.
import KCount from './KCount.vue';

withDefaults(
  defineProps<{
    label: string;
    count?: number;
    active?: boolean;
    icon?: string;
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
  border-color: var(--k-line-strong);
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
