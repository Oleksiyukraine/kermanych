<template>
  <div class="mcpc" role="alert">
    <p class="mcpc__lead">{{ t('aiTeam.mcp.conflict.lead', { name }) }}</p>
    <div class="mcpc__cols">
      <div>
        <span class="mcpc__cap">{{ t('aiTeam.mcp.conflict.current') }}</span>
        <pre class="mcpc__code mono">{{ codexTableText(conflict.current) }}</pre>
      </div>
      <div>
        <span class="mcpc__cap">{{ t('aiTeam.mcp.conflict.next') }}</span>
        <pre class="mcpc__code mono">{{ codexTableText(conflict.next) }}</pre>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
// A write stopped at a codex table someone wrote by hand (docs/specs/2026-11-14-project-mcp-servers.md,
// decision 5): what the file has, and what Kermanych would write in its place.
import { useI18n } from 'vue-i18n';
import type { McpCodexConflict } from '@kermanych/core';
import { codexTableText } from '../../lib/mcp';

defineProps<{ conflict: McpCodexConflict; name: string }>();
const { t } = useI18n();
</script>

<style scoped lang="scss">
.mcpc {
  margin-top: var(--k-sp-3);
  padding: var(--k-sp-2) var(--k-sp-3);
  border: var(--k-rule-thin) solid var(--k-accent);
  border-radius: var(--k-r);
}

.mcpc__lead {
  margin: 0 0 var(--k-sp-2);
  font-size: var(--k-fs-sm);
  line-height: 1.5;
}

.mcpc__cols {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: var(--k-sp-2);
}

.mcpc__cap {
  font-size: var(--k-fs-xs);
  color: var(--k-faint);
}

.mcpc__code {
  margin: var(--k-sp-1) 0 0;
  padding: var(--k-sp-2);
  font-size: var(--k-fs-xs);
  white-space: pre-wrap;
  word-break: break-all;
  background: var(--k-surface2);
  border-radius: var(--k-r-sm);
}
</style>
