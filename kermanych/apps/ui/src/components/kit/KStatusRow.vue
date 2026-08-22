<template>
  <div class="k-sr mono">
    <span v-if="session.model">{{ session.model }}</span>
    <span v-if="session.contextPercent != null" class="k-sr__sep">·</span>
    <span v-if="session.contextPercent != null">{{ session.contextPercent.toFixed(0) }}%</span>
    <span v-if="cost" class="k-sr__sep">·</span>
    <span v-if="cost">${{ cost.toFixed(2) }}</span>
    <span class="k-sr__spacer"></span>
    <span v-if="live" class="k-sr__live">◆ {{ live }}<template v-if="elapsed"> · {{ elapsed }}</template></span>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import type { Session } from '@kermanych/core';
import { useNow } from '../../composables/useNow';

// The one row that never disappears: model, context budget, accumulated cost and — on
// the right — what the agent is doing right now with how long it has been at it.
const props = defineProps<{ session: Session; cost: number }>();

const now = useNow(1000);
const live = computed(() =>
  props.session.status === 'tool' ? (props.session.currentTool ?? 'виконує')
  : props.session.status === 'thinking' ? 'думає'
  : props.session.status === 'queued' ? 'стартує'
  : '',
);
// Never fabricate a metric: with no heartbeat there is no elapsed time to show.
const elapsed = computed(() => {
  if (!live.value || !props.session.lastEventAt) return '';
  const s = Math.max(0, Math.round((now.value - props.session.lastEventAt) / 1000));
  return s < 60 ? `${s} с` : `${Math.round(s / 60)} хв`;
});
</script>

<style scoped lang="scss">
.k-sr {
  flex: none;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 5px 12px;
  border-top: 1px solid var(--k-line-strong);
  font-size: 11px;
  color: var(--k-muted);
  white-space: nowrap;
  overflow: hidden;
}
.k-sr__spacer { margin-left: auto; }
.k-sr__live { color: var(--k-accent); }
</style>
