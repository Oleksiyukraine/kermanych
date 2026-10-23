<template>
  <span class="k-decision-mark mono" v-tip="reason" :aria-label="`${t('kit.decisionMark.label')}: ${reason}`">
    <KIcon name="decision" />
    <span class="k-decision-mark__label" aria-hidden="true">{{ t('kit.decisionMark.label') }}</span>
  </span>
</template>

<script setup lang="ts">
import { useI18n } from 'vue-i18n';
import KIcon from './KIcon.vue';

// «Потрібне рішення» (docs/specs/2026-10-23-minion-auto-run.md, decision 12): a «Посіпака» run
// stopped on something only the operator can decide, and the card waits «На ревʼю» for them.
// `reason` is already worded (lib/minion.ts minionReasonText) and is the tooltip: the mark is
// the call to act, the reason says on what. In the accent, because it is the operator's turn.
defineProps<{ reason: string }>();
const { t } = useI18n();
</script>

<style scoped lang="scss">
.k-decision-mark {
  display: inline-flex;
  flex: none;
  align-items: center;
  gap: 3px;
  padding: 2px 6px 2px 4px;
  border-radius: var(--k-r-pill);
  border: 1px solid var(--k-accent);
  color: var(--k-accent);
  font-size: var(--k-fs-xs);
  line-height: 1;
  white-space: nowrap;
  --k-icon-size: var(--k-icon-xs);
}
</style>
