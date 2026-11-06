<template>
  <span class="k-schedule-mark mono" v-tip="t('kit.scheduleMark.tip', { name })" :aria-label="t('kit.scheduleMark.tip', { name })">
    <KIcon name="clock" />
    <span class="k-schedule-mark__label" aria-hidden="true">{{ t('kit.scheduleMark.label', { name }) }}</span>
  </span>
</template>

<script setup lang="ts">
import { useI18n } from 'vue-i18n';
import KIcon from './KIcon.vue';

// «Розклад · <назва>» on a session a scheduled agent task ran (docs/specs/2026-11-06-scheduled-tasks.md,
// decision 5): the run is an ordinary session the operator archives himself, and this says where
// it came from. Styled like KMinionMark — a mark AND a word, in the muted ink: it says who started
// the agent, not that anything waits for the operator.
defineProps<{ name: string }>();
const { t } = useI18n();
</script>

<style scoped lang="scss">
.k-schedule-mark {
  display: inline-flex;
  flex: none;
  align-items: center;
  gap: 3px;
  max-width: 180px;
  padding: 2px 6px 2px 4px;
  border-radius: var(--k-r-pill);
  background: color-mix(in srgb, var(--k-text) 10%, transparent);
  color: var(--k-muted);
  font-size: var(--k-fs-xs);
  line-height: 1;
  white-space: nowrap;
  --k-icon-size: var(--k-icon-xs);
}

// A long task name is cut, not wrapped: the mark sits in a one-line row.
.k-schedule-mark__label {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}
</style>
