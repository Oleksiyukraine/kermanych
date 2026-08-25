<template>
  <div class="k-topnav" role="tablist">
    <button
      v-for="option in options"
      :key="option.value"
      class="k-topnav__seg"
      :class="{ 'k-topnav__seg--active': option.value === modelValue }"
      type="button"
      role="tab"
      :aria-selected="option.value === modelValue"
      @click="emit('update:modelValue', option.value)"
    >
      {{ option.label }}
    </button>
  </div>
</template>

<script setup lang="ts">
// Segmented navigation control. A pill track (--k-surface2) holds one button per
// option; the active segment carries the accent fill, the rest stay muted until
// hover. Machine-agnostic UI text, so --k-font-ui (inherited).
defineProps<{
  modelValue: string;
  options: { value: string; label: string }[];
}>();

const emit = defineEmits<{ 'update:modelValue': [value: string] }>();
</script>

<style scoped lang="scss">
.k-topnav {
  display: inline-flex;
  align-items: center;
  gap: var(--k-sp-1);
  padding: var(--k-sp-1);
  background: var(--k-surface2);
  border-radius: var(--k-r-pill);
}

.k-topnav__seg {
  appearance: none;
  border: none;
  cursor: pointer;
  padding: var(--k-sp-2) var(--k-sp-4);
  font-family: var(--k-font-ui);
  font-size: var(--k-fs-base);
  font-weight: var(--k-fw-medium);
  line-height: 1;
  color: var(--k-muted);
  background: transparent;
  border-radius: var(--k-r-pill);
  white-space: nowrap;
  transition:
    color 0.12s ease,
    background 0.12s ease;

  &:hover {
    color: var(--k-text);
  }
}

.k-topnav__seg--active {
  color: var(--k-on-accent);
  background: var(--k-accent);

  &:hover {
    color: var(--k-on-accent);
  }
}
</style>
