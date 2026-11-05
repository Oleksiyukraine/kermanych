<template>
  <div class="k-view-mode" role="group" :aria-label="t('kit.viewMode.label')">
    <button
      v-for="m in MODES"
      :key="m"
      type="button"
      class="k-view-mode__btn"
      :class="{ 'k-view-mode__btn--on': modelValue === m }"
      :aria-pressed="modelValue === m"
      :aria-label="t(`kit.viewMode.${m}`)"
      v-tip="t(`kit.viewMode.${m}`)"
      @click="emit('update:modelValue', m)"
    >
      <KIcon :name="ICONS[m]" />
    </button>
  </div>
</template>

<script setup lang="ts">
// Source / split / preview for a file that has a rendered form (lib/doc-preview.ts). Drawn
// icons rather than glyphs: Unicode has no mark for «code beside a page», and the trio is the
// one users know from an IDE's Markdown editor.
import { useI18n } from 'vue-i18n';
import type { ViewMode } from '../../lib/doc-preview';
import KIcon, { type KIconName } from './KIcon.vue';

defineProps<{ modelValue: ViewMode }>();
const emit = defineEmits<{ 'update:modelValue': [mode: ViewMode] }>();

const { t } = useI18n();

const MODES: readonly ViewMode[] = ['source', 'split', 'preview'];
const ICONS: Record<ViewMode, KIconName> = {
  source: 'viewSource',
  split: 'viewSplit',
  preview: 'viewPreview',
};
</script>

<style scoped lang="scss">
.k-view-mode {
  display: inline-flex;
  flex: none;
  gap: 2px;
}
.k-view-mode__btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  padding: 0;
  border: none;
  border-radius: var(--k-r-sm);
  background: transparent;
  color: var(--k-muted);
  --k-icon-size: var(--k-icon-md);
  cursor: pointer;
  transition: background-color 0.12s, color 0.12s;

  &:hover { color: var(--k-text); }
  &:focus-visible {
    outline: 1px solid var(--k-accent);
    outline-offset: 1px;
  }
}
.k-view-mode__btn--on {
  background: var(--k-surface2);
  color: var(--k-text);
}
</style>
