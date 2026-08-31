<template>
  <div v-if="live" class="k-sr mono">
    <span class="k-sr__live">◆ {{ live }}<template v-if="silence"> · тиша {{ silence }}</template></span>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import type { Session } from '@kermanych/core';
import { dur } from '../../lib/time';
import { useNow } from '../../composables/useNow';

// The live lane: what the agent is doing right now, pinned between the plan lane and the
// composer. Everything countable about the session — model, effort, isolation, context
// budget, tokens, spend — lives one floor below in the composer's chip row (`KComposer`),
// printed once: two readouts of the same session a few pixels apart looked like two
// disagreeing instruments. So this row carries only the transient fact that has no place
// among static chips, and is absent entirely while the agent is idle (same rule as
// `KTodoLane`) rather than holding an empty strip open.
const props = defineProps<{ session: Session }>();

const now = useNow(1000);

const live = computed(() =>
  props.session.status === 'tool' ? (props.session.currentTool ?? 'виконує')
  : props.session.status === 'thinking' ? 'думає'
  : props.session.status === 'queued' ? 'стартує'
  : '',
);
// `lastEventAt` is a silence heartbeat, not a turn clock — every streaming delta resets
// it — so it is labelled as silence rather than passed off as time spent working. That
// label is the whole fix: a row reading `тиша 3 хв` beside a stall banner reading
// `Немає активності 3 хв` agrees with it rather than contradicting it. The figure is
// deliberately NOT suppressed at the stall threshold: the banner is an in-flow block at
// the tail of a scrollable log, so it is off-screen whenever the operator has scrolled
// back through history (`onLogScroll` and `jumpUser` both drop auto-follow), and this row
// is the one lane that never scrolls away. Suppressing here would blank the only visible
// evidence exactly when it matters most — and `queued` is live here but outside
// KPanel's `running`, so no banner could ever arrive to replace it.
const silence = computed(() => {
  if (!live.value || !props.session.lastEventAt) return '';
  return dur(Math.max(0, now.value - props.session.lastEventAt));
});
</script>

<style scoped lang="scss">
.k-sr {
  flex: none;
  display: flex;
  justify-content: flex-end;
  align-items: center;
  gap: 8px;
  padding: 5px 12px;
  border-top: 1px solid var(--k-line-strong);
  font-size: 11px;
  color: var(--k-muted);
  white-space: nowrap;
  overflow: hidden;
}
.k-sr__live { flex: none; color: var(--k-accent); }
</style>
