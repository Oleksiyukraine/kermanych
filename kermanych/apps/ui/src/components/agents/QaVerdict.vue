<template>
  <!-- The tester's verdict on one QA item, read-only, beside the human tick (which keeps meaning
       «a person checked it»): ✓ passed / ✗ failed / ⏸ blocked, the note, the screenshot path. -->
  <div class="qa-verdict" :class="`qa-verdict--${verdict.status}`">
    <span class="qa-verdict__badge mono" v-tip="t('tester.verdict.title')">{{ MARKS[verdict.status] }} {{ t(`tester.verdict.${verdict.status}`) }}</span>
    <span v-if="verdict.note" class="qa-verdict__note">{{ verdict.note }}</span>
    <span v-if="verdict.screenshot" class="qa-verdict__shot">
      {{ t('tester.verdict.screenshot') }} <code class="mono">{{ verdict.screenshot }}</code>
    </span>
  </div>
</template>

<script setup lang="ts">
// docs/specs/2026-11-04-qa-tester-agent.md, decision 2. Shared by the QA tab and the board card.
import { useI18n } from 'vue-i18n';
import type { QaAgentVerdict, QaVerdictStatus } from '@kermanych/core';

defineProps<{ verdict: QaAgentVerdict }>();

const { t } = useI18n();
const MARKS: Record<QaVerdictStatus, string> = { passed: '✓', failed: '✗', blocked: '⏸' };
</script>

<style scoped lang="scss">
.qa-verdict {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 4px 8px;
  margin: 4px 0 0 24px;
  font-size: 11.5px;
  line-height: 1.5;
  color: var(--k-muted);
}

.qa-verdict__badge {
  white-space: nowrap;
  padding: 0 6px;
  border: 1px solid currentColor;
  border-radius: var(--k-r-sm);
}

.qa-verdict--passed .qa-verdict__badge { color: var(--k-success); }
.qa-verdict--failed .qa-verdict__badge { color: var(--k-danger); }
.qa-verdict--blocked .qa-verdict__badge { color: var(--k-warning); }

.qa-verdict__note {
  color: var(--k-text);
  overflow-wrap: anywhere;
}

.qa-verdict__shot {
  flex-basis: 100%;
  overflow-wrap: anywhere;
}
</style>
