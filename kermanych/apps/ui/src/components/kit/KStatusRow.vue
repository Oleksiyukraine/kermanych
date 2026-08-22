<template>
  <div class="k-sr mono">
    <span v-if="session.model" class="k-sr__model">{{ session.model }}</span>
    <span v-if="session.model && metrics" class="k-sr__sep">·</span>
    <span v-if="metrics">{{ metrics }}</span>
    <span class="k-sr__spacer"></span>
    <span v-if="live" class="k-sr__live">◆ {{ live }}<template v-if="silence"> · тиша {{ silence }}</template></span>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import type { Session } from '@kermanych/core';
import { useNow } from '../../composables/useNow';

// The one row that never disappears: model, context budget, accumulated spend and — on
// the right — what the agent is doing right now. Every figure here is either true or
// absent; a rounded-down zero would be a claim the project does not let this row make.
const props = defineProps<{ session: Session; cost: number; stalled: boolean }>();

const now = useNow(1000);

// The house duration form, identical to KRequestBlock's `dur()`: whole seconds below a
// minute, then whole minutes, and a floor marker under a second — `0 с` would claim no
// time passed at all.
function dur(ms: number): string {
  if (ms < 1000) return '<1 с';
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s} с` : `${Math.round(s / 60)} хв`;
}

// The machine metrics, assembled the way KRequestBlock's `summary` is: an array filtered
// of the facts we do not have, then joined. Gating each separator on the field that
// follows it is what produces a row opening with a dangling `·` — a chat has no model,
// so that was the default rendering.
const metrics = computed(() => {
  const pc = props.session.contextPercent;
  return [
    // Sub-half-percent context is still context loaded; `toFixed(0)` would call it 0%.
    pc == null ? '' : pc > 0 && pc < 0.5 ? '<1%' : `${pc.toFixed(0)}%`,
    // Sub-cent spend is real spend: rounding it to `$0.00` would assert the chat was free.
    props.cost >= 0.005 ? `$${props.cost.toFixed(2)}` : props.cost ? '<$0.01' : '',
  ].filter(Boolean).join(' · ');
});

const live = computed(() =>
  props.session.status === 'tool' ? (props.session.currentTool ?? 'виконує')
  : props.session.status === 'thinking' ? 'думає'
  : props.session.status === 'queued' ? 'стартує'
  : '',
);
// `lastEventAt` is a silence heartbeat, not a turn clock — every streaming delta resets
// it — so it is labelled as silence rather than passed off as time spent working. Past
// the stall threshold the pinned banner tells that story with its own wording, and one
// fact reported twice with two roundings is worse than reporting it once: the accent
// figure stands down and leaves the banner to it.
const silence = computed(() => {
  if (!live.value || props.stalled || !props.session.lastEventAt) return '';
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
// A long model id is the only field that survives truncation with its meaning intact,
// so it is the one that shrinks; the live indicator must never be what gets clipped.
.k-sr__model { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.k-sr__spacer { margin-left: auto; }
.k-sr__live { flex: none; color: var(--k-accent); }
</style>
