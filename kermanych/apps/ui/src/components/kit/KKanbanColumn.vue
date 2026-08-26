<template>
  <div class="k-kanban-col">
    <header class="k-kanban-col__head">
      <span class="k-kanban-col__label">{{ label }}</span>
      <KCount :value="count" />
    </header>
    <div class="k-kanban-col__body">
      <slot />
    </div>
  </div>
</template>

<script setup lang="ts">
// Board column: a labelled header with a running count and a vertical stack of
// KKanbanCard children in the default slot (design-system Дошка section).
import KCount from './KCount.vue';

defineProps<{ label: string; count: number }>();
</script>

<style scoped lang="scss">
.k-kanban-col {
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  background: var(--k-bg);
  border: 1px solid var(--k-line);
  border-radius: var(--k-r-lg);
  overflow: hidden;
}

.k-kanban-col__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--k-sp-2);
  flex: none;
  padding: var(--k-sp-3);
}

.k-kanban-col__label {
  font-size: var(--k-fs-sm);
  font-weight: var(--k-fw-semibold);
  color: var(--k-text);
}

.k-kanban-col__body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: var(--k-sp-2);
  padding: 0 var(--k-sp-3) var(--k-sp-3);
}
</style>
