<template>
  <div class="aro">
    <p v-if="error" class="aro__error mono">{{ t('aiTeam.agents.loadFailed', { error }) }}</p>
    <KSkeleton v-else-if="phase === 'skeleton'" variant="lines" :rows="6" />
    <template v-else-if="phase === 'ready' && view">
      <section class="aro__section">
        <h2 class="aro__h">{{ t('aiTeam.agents.instructionTitle') }}</h2>
        <p class="aro__caption">{{ t('aiTeam.agents.source.' + view.instructionFrom, { name: workspaceName ?? '' }) }}</p>
        <pre class="aro__text mono">{{ view.instruction }}</pre>
        <!-- Read-only everywhere: Kermanych appends it after ANY instruction, default or override. -->
        <template v-if="def.id === 'pull-request' || def.id === 'commit'">
          <p class="aro__caption">{{ t('settings.aiAgents.baseSyncCaption') }}</p>
          <pre class="aro__text mono">{{ BASE_SYNC_PREVIEW }}</pre>
        </template>
      </section>

      <section class="aro__section">
        <h2 class="aro__h">{{ t('aiTeam.agents.skillsTitle') }}</h2>
        <template v-if="view.skills.length">
          <p class="aro__caption">{{ t('aiTeam.agents.skillsSource.' + view.skillsFrom, { name: workspaceName ?? '' }) }}</p>
          <ol class="aro__skills mono">
            <li v-for="name in view.skills" :key="name">{{ name }}</li>
          </ol>
        </template>
        <p v-else class="aro__hint">{{ t('aiTeam.agents.noSkills') }}</p>
        <!-- Cards filed from «Знахідки» get one more default skill, pasted by Kermanych itself
             (docs/specs/2026-10-23-minion-auto-run.md, decision 14) — not part of the sequence. -->
        <p v-if="def.id === MINION_AGENT_ID" class="aro__hint">{{ t('minion.panel.findingsSkill', { name: MINION_FINDINGS_SKILL }) }}</p>
      </section>

      <p v-if="!workspaceId" class="aro__hint">{{ t('aiTeam.agents.noWorkspace') }}</p>
      <button v-else type="button" class="aro__link" @click="emit('open-workspace')">{{ t('aiTeam.agents.editInWorkspace') }}</button>
    </template>
  </div>
</template>

<script setup lang="ts">
// «ШІ-команда» → project → «Агенти» → an agent: what this project's agent gets, read-only
// (docs/specs/2026-11-03-ai-team-agent-pages.md, decision 1). The instruction and the sequence are
// resolved from the project's rows over its workspace's over Kermanych's default, as the launch
// resolves them (lib/ai-team.ts resolveAgent), and the caption names the source. Edited only at
// the workspace scope, which the link switches to.
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { MINION_AGENT_ID, MINION_FINDINGS_SKILL, baseSyncBlock, type AgentDef } from '@kermanych/core';
import type { AiOwner } from '@kermanych/cloud';
import { resolveAgent } from '../../lib/ai-team';
import { agentOwners, useAiAgentRows } from '../../composables/useAiAgentRows';
import { useLoadPhase } from '../../composables/useLoadPhase';
import KSkeleton from 'components/kit/KSkeleton.vue';

const props = defineProps<{ def: AgentDef; owner: AiOwner; workspaceId: string | undefined; workspaceName: string | undefined }>();
const emit = defineEmits<{ 'open-workspace': [] }>();
const { t } = useI18n();
// Rendered here, not in the template: a literal `<base>` inside a mustache trips the SFC parser.
const BASE_SYNC_PREVIEW = baseSyncBlock('<base>');

const { agents, skills, loaded, error } = useAiAgentRows(() => agentOwners(props.owner, props.workspaceId));
const phase = useLoadPhase(() => !loaded.value && !error.value);
const view = computed(() => (loaded.value ? resolveAgent(props.def, agents.value, skills.value) : undefined));
</script>

<style scoped lang="scss">
.aro { display: flex; flex-direction: column; gap: var(--k-sp-5); }
.aro__section { display: flex; flex-direction: column; }
.aro__h { margin: 0 0 var(--k-sp-2); font-size: var(--k-fs-md); font-weight: var(--k-fw-semibold); line-height: 1.3; color: var(--k-text); }
.aro__caption { margin: 8px 0 4px; font-size: 11.5px; color: var(--k-muted); }
.aro__hint { margin: 6px 0 0; font-size: 12px; color: var(--k-muted); }
.aro__error { margin: 0; font-size: 11.5px; color: var(--k-accent); overflow-wrap: anywhere; }
/* The verbatim treatment every model-facing text gets on this screen. */
.aro__text {
  margin: 0;
  padding: 8px 10px;
  font-size: 11.5px;
  line-height: 1.5;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  background: var(--k-surface2);
  border-radius: var(--k-r);
}
.aro__skills { margin: 0; padding-left: 20px; font-size: 12px; }
.aro__link {
  align-self: flex-start;
  padding: 0;
  font: inherit;
  font-size: 12px;
  color: var(--k-accent);
  background: none;
  border: 0;
  cursor: pointer;
}
</style>
