<template>
  <div class="k-tabs" role="tablist">
    <button
      v-for="tab in tabs"
      :key="tab.value"
      class="k-tabs__tab"
      :class="{ 'k-tabs__tab--active': tab.value === modelValue }"
      type="button"
      role="tab"
      :aria-selected="tab.value === modelValue"
      @click="emit('update:modelValue', tab.value)"
    >
      {{ tab.label }}
    </button>
  </div>
</template>

<script setup lang="ts">
// Underline tabs. Active tab carries the vermilion 2px underline and full-text
// color; inactive tabs are muted and brighten on hover.
defineProps<{
  modelValue: string;
  tabs: { value: string; label: string }[];
}>();

const emit = defineEmits<{
  'update:modelValue': [value: string];
}>();
</script>

<style scoped lang="scss">
.k-tabs {
  display: flex;
  gap: var(--k-sp-4);
  border-bottom: 1px solid var(--k-line);
}

.k-tabs__tab {
  font-family: var(--k-font-ui);
  font-size: var(--k-fs-base);
  font-weight: var(--k-fw-medium);
  line-height: 1;
  padding: var(--k-sp-3) 0;
  border: none;
  border-bottom: 2px solid transparent;
  margin-bottom: -1px;
  background: transparent;
  color: var(--k-muted);
  cursor: pointer;
  transition: color 0.12s, border-color 0.12s;

  &:hover {
    color: var(--k-text);
  }

  &:focus-visible {
    outline: 1px solid var(--k-accent);
    outline-offset: 1px;
  }
}

.k-tabs__tab--active {
  color: var(--k-text);
  border-bottom-color: var(--k-accent);
}
</style>
