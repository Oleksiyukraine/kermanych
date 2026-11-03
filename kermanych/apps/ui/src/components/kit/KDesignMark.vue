<template>
  <span class="k-design-mark mono" v-tip="t('kit.designMark.tip')" :aria-label="t('kit.designMark.tip')">
    <KIcon name="design" />
    <span class="k-design-mark__label" aria-hidden="true">{{ t('kit.designMark.label') }}</span>
  </span>
</template>

<script setup lang="ts">
import { useI18n } from 'vue-i18n';
import KIcon from './KIcon.vue';

// «Дизайн» on a card, a session or a map node: this agent drafts screens on the project's UI kit
// and saves them to `docs/design/<date>-<slug>/` (docs/specs/2026-10-29-design-tab.md). Styled
// like KAnalysisMark — a mark AND a word — in the muted ink like KMinionMark: it says how this
// agent works, not that anything waits for the operator.
const { t } = useI18n();
</script>

<style scoped lang="scss">
.k-design-mark {
  display: inline-flex;
  flex: none;
  align-items: center;
  gap: 3px;
  padding: 2px 6px 2px 4px;
  border-radius: var(--k-r-pill);
  background: color-mix(in srgb, var(--k-text) 10%, transparent);
  color: var(--k-muted);
  font-size: var(--k-fs-xs);
  line-height: 1;
  white-space: nowrap;
  --k-icon-size: var(--k-icon-xs);
}
</style>
