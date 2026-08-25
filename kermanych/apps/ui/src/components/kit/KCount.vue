<template>
  <span class="k-count">{{ value }}</span>
</template>

<script setup lang="ts">
// A muted count pill: the trailing badge on nav items, kanban headers, etc.
defineProps<{ value: number }>();
</script>

<style scoped lang="scss">
.k-count {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 18px;
  padding: 1px var(--k-sp-2);
  font-family: var(--k-font-ui);
  font-size: var(--k-fs-xs);
  font-weight: var(--k-fw-medium);
  line-height: 1;
  color: var(--k-muted);
  background: var(--k-surface2);
  border-radius: var(--k-r-pill);
  white-space: nowrap;
}
</style>
