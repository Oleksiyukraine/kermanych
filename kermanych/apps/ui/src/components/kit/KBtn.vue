<template>
  <button
    class="k-btn"
    :class="[`k-btn--${variant}`, { 'k-btn--disabled': isBusy, 'k-btn--loading': loading }]"
    :disabled="isBusy"
    type="button"
    v-tip="title"
    :aria-label="variant === 'icon' ? title : undefined"
    :aria-busy="loading || undefined"
  >
    <span v-if="loading" class="k-btn__spinner" aria-hidden="true" />
    <slot />
  </button>
</template>

<script setup lang="ts">
import { computed } from 'vue';
// Modernist button. Radius 0, label flush-left, weight 800.
// Accent is reserved for the primary action only (per design-system rules).
//
// `loading` is the busy affordance for async actions (create PR, finish, merge…):
// it prepends an inline spinner and forces the disabled state, so a single flag
// both blocks the double-click and shows the operation is running. The caller keeps
// its own label — the spinner is the only thing that changes.
//
// `title` feeds the app tooltip (`v-tip`, src/lib/tip.ts), never the native
// attribute — one bubble style across the whole UI. It also becomes the
// `aria-label` for `variant="icon"` only: that variant's slot is a bare glyph,
// while the other variants carry a visible text label that must not be shadowed.
const props = withDefaults(
  defineProps<{
    variant?: 'primary' | 'secondary' | 'ghost' | 'icon';
    disabled?: boolean;
    loading?: boolean;
    title?: string;
  }>(),
  { variant: 'secondary', disabled: false, loading: false },
);
const isBusy = computed(() => props.disabled || props.loading);
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
  color: var(--k-on-accent);
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
  // Glyph-only control, so this is an icon size, not a type size. A step ABOVE KIconButton's
  // `md`: that control is the compact 28px one that packs into clusters, this is the 34px
  // standalone, and the two are only telling apart at a glance if the mark scales with the box.
  font-size: var(--k-icon-lg);

  &:hover:not(.k-btn--disabled) {
    border-color: var(--k-line-strong);
    color: var(--k-text);
  }
}

.k-btn--disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

// loading — busy but readable: less dim than a plain disabled control so the
// spinner stays legible, and a progress cursor instead of the not-allowed bar.
.k-btn--loading {
  opacity: 0.7;
  cursor: progress;
}

.k-btn__spinner {
  flex: none;
  width: 12px;
  height: 12px;
  margin-right: 8px;
  border: 2px solid currentColor;
  border-top-color: transparent;
  border-radius: 50%;
  animation: k-btn-spin 0.6s linear infinite;
}

// icon variant is a glyph-only square: no label to sit beside, so drop the gap.
.k-btn--icon .k-btn__spinner {
  margin-right: 0;
}

@keyframes k-btn-spin {
  to {
    transform: rotate(360deg);
  }
}

@media (prefers-reduced-motion: reduce) {
  .k-btn__spinner {
    animation: none;
  }
}
</style>
