<template>
  <span class="k-analysis-mark mono" v-tip="t('kit.analysisMark.tip')" :aria-label="t('kit.analysisMark.tip')">
    <KIcon name="analysis" />
    <span class="k-analysis-mark__label" aria-hidden="true">{{ t('kit.analysisMark.label') }}</span>
  </span>
</template>

<script setup lang="ts">
import { useI18n } from 'vue-i18n';
import KIcon from './KIcon.vue';

// «Глибокий аналіз» on a card or a header: this task's agent interviews the operator and writes
// the task document before any code (docs/specs/2026-10-08-deep-analysis-task.md). A mark AND a
// word, in the accent: the two kinds of agent otherwise look identical, and the difference
// decides whether opening one means reading a question or reviewing a diff. The magnifier is
// the same mark the «Нова задача» menu shows for the option, so card and choice match.
const { t } = useI18n();
</script>

<style scoped lang="scss">
.k-analysis-mark {
  display: inline-flex;
  flex: none;
  align-items: center;
  gap: 3px;
  padding: 2px 6px 2px 4px;
  border-radius: var(--k-r-pill);
  background: color-mix(in srgb, var(--k-accent) 14%, transparent);
  color: var(--k-accent);
  font-size: var(--k-fs-xs);
  line-height: 1;
  white-space: nowrap;
  --k-icon-size: var(--k-icon-xs);
}
</style>
