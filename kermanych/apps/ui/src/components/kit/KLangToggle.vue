<template>
  <div class="k-lang-toggle" role="group" aria-label="Мова / Language">
    <button
      type="button"
      class="k-lang-toggle__opt"
      :class="{ 'k-lang-toggle__opt--active': locale === 'uk' }"
      :aria-pressed="locale === 'uk'"
      @click="locale = 'uk'"
    >Українська</button>
    <button
      type="button"
      class="k-lang-toggle__opt"
      :class="{ 'k-lang-toggle__opt--active': locale === 'en' }"
      :aria-pressed="locale === 'en'"
      @click="locale = 'en'"
    >English</button>
  </div>
</template>

<script setup lang="ts">
// The two option labels are the ONE place a language name appears in its own
// language, so they are literals, not i18n keys.
import { locale } from '../../lib/locale';
</script>

<style scoped lang="scss">
// Mirrors the theme segmented control in SettingsPage.vue (.set__seg).
.k-lang-toggle {
  display: flex;
  gap: 2px;
  width: max-content;
  padding: 3px;
  background: var(--k-surface);
  border: var(--k-rule-thin) solid var(--k-line);
  border-radius: var(--k-r);
}

.k-lang-toggle__opt {
  font-family: var(--k-font-ui);
  font-size: var(--k-fs-base);
  font-weight: var(--k-fw-medium);
  color: var(--k-muted);
  background: transparent;
  border: 0;
  border-radius: var(--k-r-sm);
  padding: 6px 14px;
  cursor: pointer;
  transition: background 0.12s, color 0.12s;

  &:hover {
    color: var(--k-text);
  }

  &:focus-visible {
    outline: 1px solid var(--k-accent);
    outline-offset: 1px;
  }
}

.k-lang-toggle__opt--active {
  color: var(--k-text);
  background: var(--k-surface2);
  font-weight: var(--k-fw-semibold);
}
</style>
