<template>
  <span class="k-not-needed-mark mono" v-tip="reason" :aria-label="`${t('kit.notNeededMark.label')}: ${reason}`">
    <KIcon name="notNeeded" />
    <span class="k-not-needed-mark__label" aria-hidden="true">{{ t('kit.notNeededMark.label') }}</span>
  </span>
</template>

<script setup lang="ts">
import { useI18n } from 'vue-i18n';
import KIcon from './KIcon.vue';

// «Не потрібно» (docs/specs/2026-10-23-minion-auto-run.md, decision 14): a «Посіпака» run found
// nothing to change — the problem is already fixed, the card repeats another, or the code is
// gone — and closed the card «Завершені». `reason` is the agent's evidence (lib/minion.ts
// cardNotNeededReason / sessionNotNeededReason) and is the tooltip. Muted, never the accent:
// it is a closed result, not the operator's turn (that is KDecisionMark).
defineProps<{ reason: string }>();
const { t } = useI18n();
</script>

<style scoped lang="scss">
.k-not-needed-mark {
  display: inline-flex;
  flex: none;
  align-items: center;
  gap: 3px;
  padding: 2px 6px 2px 4px;
  border-radius: var(--k-r-pill);
  border: 1px solid var(--k-line);
  color: var(--k-muted);
  font-size: var(--k-fs-xs);
  line-height: 1;
  white-space: nowrap;
  --k-icon-size: var(--k-icon-xs);
}
</style>
