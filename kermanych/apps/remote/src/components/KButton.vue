<script setup lang="ts">
// The phone's one button (the desktop kit's KBtn rule: `loading` = a spinner, a disabled control
// and aria-busy, so a running request can never be sent twice). 44px tall: a thumb's target.
withDefaults(
  defineProps<{
    variant?: "primary" | "secondary" | "ghost" | "danger";
    loading?: boolean;
    disabled?: boolean;
    block?: boolean;
    type?: "button" | "submit";
  }>(),
  { variant: "secondary", loading: false, disabled: false, block: false, type: "button" },
);
</script>

<template>
  <button
    :type="type"
    class="k-btn"
    :class="[`k-btn--${variant}`, { 'k-btn--block': block, 'k-btn--loading': loading }]"
    :disabled="disabled || loading"
    :aria-busy="loading || undefined"
  >
    <span v-if="loading" class="spinner" aria-hidden="true" />
    <slot />
  </button>
</template>

<style scoped>
.k-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: var(--k-sp-2);
  min-height: 44px;
  min-width: 44px;
  padding: 0 var(--k-sp-4);
  border-radius: var(--k-r);
  border: var(--k-rule-thin) solid var(--k-line-strong);
  background: var(--k-surface);
  background-image: var(--k-grad-raise);
  box-shadow: var(--k-sheen);
  font-weight: var(--k-fw-medium);
  cursor: pointer;
  touch-action: manipulation;
  user-select: none;
  -webkit-user-select: none;
}
.k-btn:active:not(:disabled) {
  background-color: var(--k-surface2);
}
.k-btn:disabled {
  opacity: 0.55;
  cursor: default;
}
.k-btn--loading:disabled {
  opacity: 0.8;
}
.k-btn--block {
  display: flex;
  width: 100%;
}
.k-btn--primary {
  background-color: var(--k-accent);
  background-image: var(--k-grad-accent);
  border-color: transparent;
  color: var(--k-on-accent);
}
.k-btn--primary:active:not(:disabled) {
  background-color: var(--k-accent-hover);
}
.k-btn--ghost {
  background: transparent;
  border-color: transparent;
  box-shadow: none;
}
.k-btn--danger {
  color: var(--k-danger);
}
</style>
