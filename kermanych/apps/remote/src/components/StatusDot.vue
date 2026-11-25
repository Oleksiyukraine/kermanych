<script setup lang="ts">
// A session's status as a dot: the sidebar's colours (apps/ui statusWord) — a question in the
// accent, a failure in danger, work pulsing, finished in success, the rest faint.
import { computed } from "vue";
import type { SessionStatus } from "@kermanych/core";
import { tierOf } from "../lib/list";

const props = defineProps<{ status: SessionStatus }>();

const tone = computed(() => {
  const tier = tierOf(props.status);
  if (tier === 0) return "ask";
  if (tier === 1) return "fail";
  if (tier === 2) return "work";
  return props.status === "done" || props.status === "in_review" || props.status === "merged" ? "ok" : "idle";
});
</script>

<template>
  <span class="dot" :class="`dot--${tone}`" aria-hidden="true" />
</template>

<style scoped>
.dot {
  display: inline-block;
  width: 10px;
  height: 10px;
  border-radius: 50%;
  flex: none;
  background: var(--k-faint);
}
.dot--ask {
  background: var(--k-accent);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--k-accent) 25%, transparent);
}
.dot--fail {
  background: var(--k-danger);
}
.dot--work {
  background: var(--k-warning);
  animation: pulse 1.4s ease-in-out infinite;
}
.dot--ok {
  background: var(--k-success);
}
</style>
