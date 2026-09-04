<template>
  <div class="k-tabs">
    <div class="k-tabs__list" role="tablist">
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
        <span v-if="tab.count != null && tab.count > 0" class="k-tabs__count mono">{{ tab.count }}</span>
      </button>
    </div>
    <!-- Trailing controls (e.g. the log's expand/collapse pair), right-aligned on the tab
         row's baseline. Kept out of the tablist so screen readers see only tabs there. -->
    <div v-if="$slots.end" class="k-tabs__end">
      <slot name="end" />
    </div>
  </div>
</template>

<script setup lang="ts">
// Underline tabs. Active tab carries the vermilion 2px underline and full-text
// color; inactive tabs are muted and brighten on hover. A tab MAY carry a `count`
// badge (the changed-file / worktree-file tallies), and the row MAY host trailing
// controls through the `end` slot.
defineProps<{
  modelValue: string;
  tabs: { value: string; label: string; count?: number }[];
}>();

const emit = defineEmits<{
  'update:modelValue': [value: string];
}>();
</script>

<style scoped lang="scss">
.k-tabs {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: var(--k-sp-4);
  border-bottom: 1px solid var(--k-line);
}

.k-tabs__list {
  display: flex;
  gap: var(--k-sp-4);
  min-width: 0;
}

.k-tabs__tab {
  display: inline-flex;
  align-items: baseline;
  gap: 6px;
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

// The count rides a step down the type scale and stays muted even on the active tab: it is
// a tally beside the label, not part of it.
.k-tabs__count {
  font-size: var(--k-fs-xs);
  font-weight: var(--k-fw-regular);
  color: var(--k-faint);
}

.k-tabs__end {
  display: flex;
  align-items: center;
  gap: var(--k-sp-3);
  flex: none;
  // Clears the 1px the active tab's underline is pulled down onto, so trailing controls sit
  // on the labels' baseline rather than on the rule.
  padding-bottom: var(--k-sp-3);
}
</style>
