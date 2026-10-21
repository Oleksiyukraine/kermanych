<template>
  <div class="k-toggle" :class="{ 'k-toggle--busy': loading }" role="tablist" :aria-busy="loading || undefined">
    <button
      v-for="opt in options"
      :key="opt"
      type="button"
      role="tab"
      class="k-toggle__seg"
      :class="{ 'k-toggle__seg--active': opt === modelValue }"
      :aria-selected="opt === modelValue"
      :disabled="disabled || loading"
      @click="emit('update:modelValue', opt)"
    >
      <KSpinner v-if="loading && opt === modelValue" :size="10" class="k-toggle__spinner" />
      {{ opt }}
    </button>
  </div>
</template>

<script setup lang="ts">
import KSpinner from './KSpinner.vue';
// Segmented control (OMP/zsh style). Active segment carries the single accent. `loading` (the
// picked segment is being saved) disables every segment and spins on the active one.
defineProps<{ options: string[]; modelValue?: string | undefined; disabled?: boolean | undefined; loading?: boolean | undefined }>();
const emit = defineEmits<{ 'update:modelValue': [value: string] }>();
</script>

<style scoped lang="scss">
.k-toggle {
  display: inline-flex;
  border: 1px solid var(--k-line-strong);
  border-radius: var(--k-r);
  background: var(--k-surface);
}

.k-toggle__seg {
  font-family: var(--k-font-ui);
  font-size: 12px;
  font-weight: 800;
  line-height: 1;
  padding: 8px 14px;
  background: transparent;
  color: var(--k-muted);
  border: none;
  border-right: 1px solid var(--k-line-strong);
  border-radius: var(--k-r);
  cursor: pointer;
  transition: background 0.12s, color 0.12s;

  &:last-child {
    border-right: none;
  }

  &:hover:not(.k-toggle__seg--active) {
    color: var(--k-text);
  }
}

.k-toggle__seg:disabled {
  cursor: not-allowed;
  opacity: 0.6;
}

.k-toggle--busy .k-toggle__seg:disabled {
  cursor: progress;
  opacity: 1;
}

.k-toggle__spinner {
  margin-right: 6px;
  vertical-align: -1px;
}

.k-toggle__seg--active {
  background: var(--k-accent);
  color: var(--k-on-accent);
}
</style>
