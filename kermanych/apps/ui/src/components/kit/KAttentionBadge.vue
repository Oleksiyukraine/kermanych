<template>
  <span v-if="level !== 'idle'" class="k-att" :class="`k-att--${level}`" aria-hidden="true">{{ digits }}</span>
</template>

<script setup lang="ts">
// The sidebar's «does this need me» mark, shared by the project rows (KRailItem) and the
// workspace rows (KWorkspaceRow) so the two speak one language. It shows the TOP state of
// the tally only (lib/attention.ts orders them); the row's tooltip lists the rest.
//
//   input    warning pill with the count, pulsing — an agent is blocked on a question
//   error    danger dot — crashed or conflicted
//   running  success pill with the count — agents at work
//   result   warning ring, no fill — a finished result nobody has opened yet
//   idle     nothing at all, so colour only appears where something is happening
//
// aria-hidden: a bare digit reads as noise; the row's label carries the full breakdown.
import { computed } from 'vue';
import { levelOf, type Attention } from '../../lib/attention';

const props = defineProps<{ attention: Attention }>();

const level = computed(() => levelOf(props.attention));
// Only the pills carry a number. The dot and the ring are presence marks: «something is
// broken» and «something to read» are what the operator acts on, not how many.
const digits = computed(() =>
  level.value === 'input' || level.value === 'running' ? String(props.attention[level.value]) : '',
);
</script>

<style scoped lang="scss">
// One 16px pill box for both counted states: one digit lands on the min-width (a circle),
// two or more grow it sideways. `--k-on-accent` is the token for text on a saturated fill
// and flips with the theme, so the digits read on the bright dark-theme fills and the dark
// light-theme ones alike.
.k-att {
  display: inline-flex;
  flex: none;
  align-items: center;
  justify-content: center;
  min-width: 16px;
  height: 16px;
  padding: 0 var(--k-sp-1);
  border-radius: var(--k-r-pill);
  color: var(--k-on-accent);
  font-family: var(--k-font-mono);
  font-size: var(--k-fs-xs);
  font-weight: var(--k-fw-semibold);
  line-height: 1;
}

.k-att--running {
  background: var(--k-success);
}

// The one mark that moves: it is the only state where an agent sits idle until the operator
// answers, and the house pulse (KStatusDot, KToolRow) is what «look here» reads as.
.k-att--input {
  background: var(--k-warning);
  animation: k-att-pulse 1.1s ease-in-out infinite;
}

// The two presence marks share the 7px footprint the old idle dot had.
.k-att--error,
.k-att--result {
  min-width: 0;
  width: 7px;
  height: 7px;
  padding: 0;
}

.k-att--error {
  background: var(--k-danger);
}

// Framed, not filled — the same «settled, a human owes it something» shape KStatusDot gives
// `waiting`, so a finished card and its project's mark look alike.
.k-att--result {
  background: transparent;
  border: 1.5px solid var(--k-warning);
}

@keyframes k-att-pulse {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0.45;
  }
}

@media (prefers-reduced-motion: reduce) {
  .k-att--input {
    animation: none;
  }
}
</style>
