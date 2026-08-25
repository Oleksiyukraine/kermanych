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
  gap: var(--k-sp-3);
  min-width: 0;
}

.k-kanban-col__head {
  display: flex;
  align-items: center;
  gap: var(--k-sp-2);
}

.k-kanban-col__label {
  font-size: var(--k-fs-sm);
  color: var(--k-muted);
}

.k-kanban-col__body {
  display: flex;
  flex-direction: column;
  gap: var(--k-sp-2);
}
</style>
