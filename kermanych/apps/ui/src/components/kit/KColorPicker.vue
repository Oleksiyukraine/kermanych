<template>
  <div class="k-color">
    <span v-if="label" class="k-color__label">{{ label }}</span>
    <div class="k-color__swatches">
      <button
        v-for="c in PALETTE"
        :key="c"
        type="button"
        class="k-color__swatch"
        :class="{ 'k-color__swatch--active': c === modelValue }"
        :style="{ '--swatch': c }"
        v-tip="c"
        :aria-label="c"
        :aria-pressed="c === modelValue"
        @click="emit('update:modelValue', c)"
      />
      <button
        type="button"
        class="k-color__swatch k-color__swatch--none"
        :class="{ 'k-color__swatch--active': !modelValue }"
        v-tip="t('kit.colorPicker.noColor')"
        :aria-label="t('kit.colorPicker.noColor')"
        :aria-pressed="!modelValue"
        @click="emit('update:modelValue', '')"
      >×</button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { useI18n } from 'vue-i18n';
// Curated swatch palette for a project's accent color (design-system dark theme).
// Stores a hex string; the trailing "×" clears the color (empty string). Radius 0.
const PALETTE = [
  '#ff563c', '#f2994a', '#e6c84f', '#28c840',
  '#2dd4bf', '#4a9eff', '#a78bfa', '#f472b6',
] as const;

defineProps<{ label?: string; modelValue?: string }>();
const emit = defineEmits<{ 'update:modelValue': [value: string] }>();

const { t } = useI18n();
</script>

<style scoped lang="scss">
.k-color {
  display: flex;
  flex-direction: column;
  gap: 6px;
  font-family: var(--k-font-ui);
}

.k-color__label {
  text-align: left;
  font-size: 13px;
  font-weight: 400;
  color: var(--k-text);
}

.k-color__swatches {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.k-color__swatch {
  width: 26px;
  height: 26px;
  padding: 0;
  background: var(--swatch, transparent);
  border: 1px solid var(--k-line-strong);
  cursor: pointer;
  border-radius: var(--k-r-sm);
  transition: box-shadow 0.12s, border-color 0.12s;

  &:hover {
    border-color: var(--k-text);
  }

  &:focus-visible {
    outline: 1px solid var(--k-accent);
    outline-offset: 2px;
  }
}

// selected — dark gap ring then a light ring, so it reads on any swatch hue.
.k-color__swatch--active {
  box-shadow: 0 0 0 1px var(--k-canvas), 0 0 0 3px var(--k-text);
}

// clear — no fill, a muted ×.
.k-color__swatch--none {
  display: flex;
  align-items: center;
  justify-content: center;
  background: transparent;
  color: var(--k-muted);
  font-size: 14px;
  line-height: 1;
}
</style>
