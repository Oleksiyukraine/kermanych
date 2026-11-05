<template>
  <span class="k-minion-mark mono" v-tip="tip" :aria-label="tip">
    <KIcon name="minion" />
    <span class="k-minion-mark__label" aria-hidden="true">{{ t('kit.minionMark.label') }}</span>
  </span>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import KIcon from './KIcon.vue';

// «Посіпака» (docs/specs/2026-10-23-minion-auto-run.md, decision 12), one mark in two places:
// - `allowed` on a card with «Дозволити автовиконання»: the minion on its author's machine may
//   take it by itself;
// - `running` on a session the minion runs, in «Агенти» and on «Карта агентів».
// The same shape for both, so a card and the run it became read as one thing; only the tooltip
// says which. Styled like KAnalysisMark, in the muted ink: it says who works the card, not that
// anything waits for the operator (that is KDecisionMark).
const props = withDefaults(defineProps<{ kind?: 'allowed' | 'running' }>(), { kind: 'running' });
const { t } = useI18n();
const tip = computed(() => t(props.kind === 'allowed' ? 'kit.minionMark.allowed' : 'kit.minionMark.running'));
</script>

<style scoped lang="scss">
.k-minion-mark {
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
