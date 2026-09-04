<template>
  <span class="k-dot" :class="`k-dot--${kind}`" aria-hidden="true" />
</template>

<script setup lang="ts">
import { computed } from 'vue';
import type { SessionStatus } from '@kermanych/core';

// 7x7 status square. Colour carries only "running" and "waiting"; terminal and
// cold states stay grey (design-system section 03).
//
// No tooltip on purpose: the dot is decoration that always sits beside the
// spelled-out status (board status cell, panel header, gallery row), so a bubble
// would only repeat the neighbouring word — in raw enum form at that.
const props = defineProps<{ status: SessionStatus }>();
type Kind = 'running' | 'waiting' | 'done' | 'error' | 'cold';

const kind = computed<Kind>(() => {
  switch (props.status) {
    case 'thinking':
    case 'tool':
      return 'running';
    // Both cases where the work is settled but a HUMAN still owes it something: an answer,
    // or a review. Framed in warning rather than filled green — nothing is finished yet.
    case 'waiting_input':
    case 'in_review':
    case 'conflict':
      return 'waiting';
    case 'done':
    case 'merged':
      return 'done';
    case 'error':
      return 'error';
    case 'queued':
    case 'stopped':
    default:
      return 'cold';
  }
});
</script>

<style scoped lang="scss">
.k-dot {
  display: inline-block;
  width: 7px;
  height: 7px;
  border: 1px solid var(--k-line-strong);
  background: var(--k-line-strong);
  border-radius: 50%;
  flex: none;
}

// running — filled accent, pulsing.
.k-dot--running {
  background: var(--k-accent);
  border-color: var(--k-accent);
  animation: k-dot-pulse 1.1s ease-in-out infinite;
}

// waiting — empty square framed in warning.
.k-dot--waiting {
  background: transparent;
  border-color: var(--k-warning);
}

// done — success green filled.
.k-dot--done {
  background: var(--k-success);
  border-color: var(--k-success);
}

// error — danger red filled.
.k-dot--error {
  background: var(--k-danger);
  border-color: var(--k-danger);
}

// cold — grey outline, no fill.
.k-dot--cold {
  background: transparent;
  border-color: var(--k-line-strong);
}

@keyframes k-dot-pulse {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0.35;
  }
}
</style>
