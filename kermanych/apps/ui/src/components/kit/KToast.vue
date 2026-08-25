<template>
  <div class="k-toasts" aria-live="polite">
    <div
      v-for="t in toasts"
      :key="t.id"
      class="k-toast"
      :class="`k-toast--${t.kind}`"
      :role="t.kind === 'error' ? 'alert' : 'status'"
      @click="emit('dismiss', t.id)"
    >
      {{ t.message }}
    </div>
  </div>
</template>

<script setup lang="ts">
// Transient notification stack (bottom-right). Presentational: the store owns
// the queue and auto-dismiss; here we render it and emit a dismiss on click.
import type { Toast } from 'stores/orchestrator';

defineProps<{ toasts: Toast[] }>();
const emit = defineEmits<{ dismiss: [id: string] }>();
</script>

<style scoped lang="scss">
.k-toasts {
  position: fixed;
  right: 20px;
  bottom: 20px;
  z-index: 7000; // above QDialog overlays
  display: flex;
  flex-direction: column;
  gap: 8px;
  pointer-events: none;
}

.k-toast {
  pointer-events: auto;
  min-width: 240px;
  max-width: 360px;
  padding: 12px 14px;
  background: var(--k-surface2);
  border: 1px solid var(--k-line-strong);
  border-left-width: 3px;
  border-radius: var(--k-r-lg);
  color: var(--k-text);
  font-family: var(--k-font-ui);
  font-size: 13px;
  line-height: 1.5;
  cursor: pointer;
  box-shadow: var(--k-shadow-toast);
}

// error — accent rail; info — neutral rail.
.k-toast--error {
  border-left-color: var(--k-accent);
}

.k-toast--info {
  border-left-color: var(--k-line-strong);
}
</style>
