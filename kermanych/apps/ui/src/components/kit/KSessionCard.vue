<template>
  <button
    type="button"
    class="k-session-card"
    :class="{ 'k-session-card--selected': selected }"
    @click="$emit('click')"
  >
    <div class="k-session-card__top">
      <span class="k-session-card__branch">{{ branch }}</span>
      <span class="k-session-card__time">{{ time }}</span>
    </div>
    <div class="k-session-card__title">{{ title }}</div>
    <div class="k-session-card__status">
      <KStatusDot :status="status" />
      <span v-if="statusLine" class="k-session-card__status-line">{{ statusLine }}</span>
    </div>
  </button>
</template>

<script setup lang="ts">
import type { SessionStatus } from '@kermanych/core';
import KStatusDot from './KStatusDot.vue';

// Session summary card: branch + time header, title, and a status row pairing
// the status dot with a short status line. `selected` draws an inset accent ring.
withDefaults(
  defineProps<{
    branch: string;
    title: string;
    time: string;
    status: SessionStatus;
    statusLine?: string;
    selected?: boolean;
  }>(),
  { selected: false },
);

defineEmits<{ click: [] }>();
</script>

<style scoped lang="scss">
.k-session-card {
  display: flex;
  flex-direction: column;
  gap: var(--k-sp-2);
  width: 100%;
  text-align: left;
  background: var(--k-surface2);
  border: 1px solid var(--k-line);
  border-radius: var(--k-r-lg);
  padding: var(--k-sp-3);
  cursor: pointer;
  transition: border-color 0.12s ease, box-shadow 0.12s ease;

  &:hover {
    border-color: var(--k-line-strong);
  }

  &:focus-visible {
    outline: none;
    box-shadow: inset 0 0 0 2px var(--k-accent);
  }
}

.k-session-card--selected {
  border-color: transparent;
  box-shadow: inset 0 0 0 2px var(--k-accent);
}

.k-session-card__top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--k-sp-2);
}

.k-session-card__branch {
  font-family: var(--k-font-mono);
  font-size: var(--k-fs-xs);
  color: var(--k-faint);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.k-session-card__time {
  font-size: var(--k-fs-xs);
  color: var(--k-faint);
  flex: none;
}

.k-session-card__title {
  font-size: var(--k-fs-base);
  color: var(--k-text);
}

.k-session-card__status {
  display: flex;
  align-items: center;
  gap: var(--k-sp-2);
}

.k-session-card__status-line {
  font-size: var(--k-fs-sm);
  color: var(--k-muted);
}
</style>
