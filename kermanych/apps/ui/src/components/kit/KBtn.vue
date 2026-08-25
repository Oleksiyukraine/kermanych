<template>
  <button
    class="k-btn"
    :class="[`k-btn--${variant}`, { 'k-btn--disabled': disabled }]"
    :disabled="disabled"
    type="button"
    v-tip="title"
    :aria-label="variant === 'icon' ? title : undefined"
  >
    <slot />
  </button>
</template>

<script setup lang="ts">
// Modernist button. Radius 0, label flush-left, weight 800.
// Accent is reserved for the primary action only (per design-system rules).
//
// `title` feeds the app tooltip (`v-tip`, src/lib/tip.ts), never the native
// attribute — one bubble style across the whole UI. It also becomes the
// `aria-label` for `variant="icon"` only: that variant's slot is a bare glyph,
// while the other variants carry a visible text label that must not be shadowed.
withDefaults(
  defineProps<{
    variant?: 'primary' | 'secondary' | 'ghost' | 'icon';
    disabled?: boolean;
    title?: string;
  }>(),
  { variant: 'secondary', disabled: false },
);
</script>

<style scoped lang="scss">
.k-btn {
  display: inline-flex;
  align-items: center;
  justify-content: flex-start; // labels flush-left, never centered
  text-align: left;
  font-family: var(--k-font-ui);
  font-size: 13px;
  font-weight: 800;
  line-height: 1;
  padding: 10px 16px;
  border: 1px solid transparent;
  background: transparent;
  color: var(--k-text);
  cursor: pointer;
  border-radius: var(--k-r);
  transition: background 0.12s, border-color 0.12s, color 0.12s;

  &:focus-visible {
    outline: 1px solid var(--k-accent);
    outline-offset: 1px;
  }
}

// primary — the single accent action.
.k-btn--primary {
  background: var(--k-accent);
  color: var(--k-canvas);
  border-color: var(--k-accent);

  &:hover:not(.k-btn--disabled) {
    background: var(--k-accent-hover);
  }
}

// secondary — surface2 with a strong 1px rule.
.k-btn--secondary {
  background: var(--k-surface2);
  border-color: var(--k-line-strong);
  color: var(--k-text);

  &:hover:not(.k-btn--disabled) {
    border-color: var(--k-text);
  }
}

// ghost — transparent, plain text (no accent).
.k-btn--ghost {
  background: transparent;
  border-color: transparent;
  color: var(--k-text);
  padding: 10px 12px;

  &:hover:not(.k-btn--disabled) {
    background: var(--k-surface2);
  }
}

// icon — square, muted glyph, strong 1px rule.
.k-btn--icon {
  width: 34px;
  height: 34px;
  padding: 0;
  justify-content: center;
  align-items: center;
  background: transparent;
  border-color: var(--k-line);
  color: var(--k-muted);
  font-weight: 400;
  font-size: 15px;

  &:hover:not(.k-btn--disabled) {
    border-color: var(--k-line-strong);
    color: var(--k-text);
  }
}

.k-btn--disabled {
  opacity: 0.45;
  cursor: not-allowed;
}
</style>
