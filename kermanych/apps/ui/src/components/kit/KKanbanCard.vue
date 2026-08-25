<template>
  <div class="k-kanban-card" role="button" tabindex="0" @click="emit('click')">
    <div class="k-kanban-card__title">
      <KStatusDot :status="status" />
      <span class="k-kanban-card__name">{{ title }}</span>
    </div>
    <div class="k-kanban-card__branch">{{ branch }}</div>
    <div class="k-kanban-card__meta">{{ project }} · {{ time }}</div>
  </div>
</template>

<script setup lang="ts">
// Kanban card: a compact session tile for the board — status dot + title,
// mono branch, and a "project · time" meta line (design-system Дошка section).
import type { SessionStatus } from '@kermanych/core';
import KStatusDot from './KStatusDot.vue';

defineProps<{
  title: string;
  branch: string;
  project: string;
  time: string;
  status: SessionStatus;
}>();

const emit = defineEmits<{ click: [] }>();
</script>

<style scoped lang="scss">
.k-kanban-card {
  display: flex;
  flex-direction: column;
  gap: var(--k-sp-1);
  padding: var(--k-sp-3);
  background: var(--k-surface2);
  border: 1px solid var(--k-line);
  border-radius: var(--k-r-lg);
  cursor: pointer;
  transition: border-color 0.12s ease;

  &:hover {
    border-color: var(--k-line-strong);
  }

  &:focus-visible {
    outline: 2px solid var(--k-accent);
    outline-offset: 2px;
  }
}

.k-kanban-card__title {
  display: flex;
  align-items: center;
  gap: var(--k-sp-2);
  color: var(--k-text);
}

.k-kanban-card__name {
  font-size: var(--k-fs-base);
  font-weight: var(--k-fw-medium);
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.k-kanban-card__branch {
  font-family: var(--k-font-mono);
  font-size: var(--k-fs-xs);
  color: var(--k-faint);
}

.k-kanban-card__meta {
  font-size: var(--k-fs-xs);
  color: var(--k-faint);
}
</style>
