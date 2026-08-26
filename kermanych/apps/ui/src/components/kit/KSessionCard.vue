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
    <div class="k-session-card__status">
      <KStatusDot :status="status" />
      <span v-if="statusLine" class="k-session-card__status-line">{{ statusLine }}</span>
    </div>
    <!-- what is running and what it has cost — absent whenever we know neither -->
    <div v-if="model || spend" class="k-session-card__meta mono">
      <span v-if="model" class="k-session-card__model">{{ model }}</span>
      <span v-if="model && spend">·</span>
      <span v-if="spend" class="k-session-card__spend">{{ spend }}</span>
    </div>
  </button>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import type { SessionStatus, Usage } from '@kermanych/core';
import KStatusDot from './KStatusDot.vue';
import { tokens, usageTokens, usd } from '../../lib/format';

// Session summary card: branch + time header, a status row pairing the status dot with a
// short status line, and the accounting line — which model is running and what it has
// consumed. Selected / hover lift the card with a subtle surface fill.
const props = withDefaults(
  defineProps<{
    branch: string;
    time: string;
    status: SessionStatus;
    statusLine?: string;
    // The session's lifetime accounting. Absent until the agent has taken a turn we
    // counted, and absent it stays: the line disappears rather than claim `0 ток · $0.00`.
    usage?: Usage | undefined;
    model?: string | undefined;
    selected?: boolean;
  }>(),
  { selected: false },
);

defineEmits<{ click: [] }>();

// Same construction as the panel's status row: the facts we have, `·`-joined, so a missing
// one leaves no dangling separator behind.
const spend = computed(() => {
  const u = props.usage;
  if (!u) return '';
  return [`${tokens(usageTokens(u))} ток`, usd(u.cost)].filter(Boolean).join(' · ');
});
</script>

<style scoped lang="scss">
.k-session-card {
  display: flex;
  flex-direction: column;
  gap: var(--k-sp-2);
  width: 100%;
  text-align: left;
  background: transparent;
  border: none;
  border-radius: var(--k-r-lg);
  padding: var(--k-sp-3);
  cursor: pointer;
  transition: background 0.12s ease;

  &:hover {
    background: var(--k-surface2);
  }

  &:focus-visible {
    outline: none;
    box-shadow: inset 0 0 0 2px var(--k-accent);
  }
}

.k-session-card--selected {
  background: var(--k-surface2);
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

.k-session-card__status {
  display: flex;
  align-items: center;
  gap: var(--k-sp-2);
}

.k-session-card__status-line {
  font-size: var(--k-fs-sm);
  color: var(--k-muted);
}

// The accounting line, one notch quieter than the status line: it is reference, not news.
// A long model id is the only field here that survives clipping with its meaning intact,
// so it is the one that shrinks; the figure it cost must always be readable in full.
.k-session-card__meta {
  display: flex;
  align-items: center;
  gap: var(--k-sp-1);
  font-size: var(--k-fs-xs);
  color: var(--k-faint);
  white-space: nowrap;
  overflow: hidden;
}

.k-session-card__model {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}

.k-session-card__spend {
  flex: none;
}
</style>
