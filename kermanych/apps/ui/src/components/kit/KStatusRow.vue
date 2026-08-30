<template>
  <div class="k-sr mono">
    <span v-if="context">{{ context }}</span>
    <span class="k-sr__spacer"></span>
    <span v-if="live" class="k-sr__live">◆ {{ live }}<template v-if="silence"> · тиша {{ silence }}</template></span>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import type { Session } from '@kermanych/core';
import { dur } from '../../lib/time';
import { useNow } from '../../composables/useNow';

// The one row that never disappears: how full the context is and — on the right — what the
// agent is doing right now. Model and spend deliberately live in the composer's chip row one
// floor below (`KComposer`), not here: printing them twice, a few pixels apart, made the
// panel look like two disagreeing readouts of the same session. Every figure here is either
// true or absent; a rounded-down zero would be a claim the project does not let this row make.
const props = defineProps<{ session: Session }>();

const now = useNow(1000);

// How full the model's context window is, as omp reports it. Sub-half-percent context is
// still context loaded; `toFixed(0)` would call it 0%. An exact 0 is not rounded from
// anything — the supervisor assigns omp's raw reading or nothing, with no `?? 0` anywhere —
// so it keeps `0%`; flooring that too would be the mirror-image lie, hiding a true zero
// behind a `<`. Do not "tidy" this guard.
const context = computed(() => {
  const pc = props.session.contextPercent;
  return pc == null ? '' : pc > 0 && pc < 0.5 ? '<1%' : `${pc.toFixed(0)}%`;
});

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
.k-sr__live { flex: none; color: var(--k-accent); }
</style>
