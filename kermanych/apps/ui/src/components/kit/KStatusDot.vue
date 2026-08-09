<template>
  <span class="k-dot" :class="`k-dot--${kind}`" :title="status" aria-hidden="true" />
</template>

<script setup lang="ts">
import { computed } from 'vue';
import type { SessionStatus } from '@kermanych/core';

// 7x7 status square. Colour carries only "running" and "waiting"; terminal and
// cold states stay grey (design-system section 03).
const props = defineProps<{ status: SessionStatus }>();

type Kind = 'running' | 'waiting' | 'done' | 'cold';

const kind = computed<Kind>(() => {
  switch (props.status) {
    case 'thinking':
    case 'tool':
      return 'running';
    case 'waiting_input':
      return 'waiting';
    case 'done':
    case 'error':
    case 'merged':
      return 'done';
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
  border-radius: 0;
  flex: none;
}

// running — filled accent, pulsing.
.k-dot--running {
  background: var(--k-accent);
  border-color: var(--k-accent);
  animation: k-dot-pulse 1.1s ease-in-out infinite;
}

// waiting — empty square framed in accent.
.k-dot--waiting {
  background: transparent;
  border-color: var(--k-accent);
}

// done — grey filled square.
.k-dot--done {
  background: var(--k-line-strong);
  border-color: var(--k-line-strong);
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
