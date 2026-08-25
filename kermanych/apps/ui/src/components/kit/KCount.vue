<template>
  <span class="k-count">{{ value }}</span>
</template>

<script setup lang="ts">
// A muted count pill: the trailing badge on nav items, kanban headers, etc.
defineProps<{ value: number }>();
</script>

<style scoped lang="scss">
.k-count {
  font-family: var(--k-font-ui);
  font-size: var(--k-fs-sm);
  font-weight: var(--k-fw-medium);
  line-height: 1;
  color: var(--k-muted);
  white-space: nowrap;
}
</style>
