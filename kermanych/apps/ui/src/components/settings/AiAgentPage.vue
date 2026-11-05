<template>
  <div class="agp">
    <!-- What the agent is: its kind (with what that means) and its id, for a trigger or a log. -->
    <div class="agp__meta">
      <span v-tip="t('aiTeam.agents.kindTip.' + def.kind)" class="agp__badge" :class="`agp__badge--${def.kind}`">
        {{ t('settings.agentKind.' + def.kind) }}
      </span>
      <span class="agp__id mono">{{ def.id }}</span>
    </div>

    <section class="agp__section">
      <h2 class="agp__h">{{ t('aiTeam.agents.how.title') }}</h2>
      <dl class="agp__how">
        <dt>{{ t('aiTeam.agents.how.when') }}</dt>
        <dd>{{ about('when') }}</dd>
        <dt>{{ t('aiTeam.agents.how.steps') }}</dt>
        <dd>
          <ol class="agp__steps">
            <li v-for="(step, i) in steps" :key="i">{{ step }}</li>
          </ol>
        </dd>
        <template v-if="def.holes?.length">
          <dt>{{ t('aiTeam.agents.how.inputs') }}</dt>
          <dd>
            <ul class="agp__inputs">
              <li v-for="hole in def.holes" :key="hole">
                <span class="agp__hole mono" v-text="'{{' + hole + '}}'"></span>
                <span>{{ about('inputs.' + hole) }}</span>
              </li>
            </ul>
          </dd>
        </template>
        <template v-if="adds">
          <dt>{{ t('aiTeam.agents.how.adds') }}</dt>
          <dd>{{ adds }}</dd>
        </template>
        <dt>{{ t('aiTeam.agents.how.ends') }}</dt>
        <dd>{{ about('ends') }}</dd>
      </dl>
    </section>

    <!-- «Посіпака» in a project: switching it on for this project on this machine, and the
         machine's cap and pause. -->
    <MinionMachineBlock v-if="def.id === MINION_AGENT_ID && owner.scope === 'project'" :project-id="owner.id" />
    <!-- «Тестувальник» in a project: this machine's test accounts, sign-in page and notes
         (docs/specs/2026-11-04-qa-tester-agent.md, decision 14). -->
    <TesterPanel v-if="def.id === TESTER_AGENT_ID && owner.scope === 'project'" :project-id="owner.id" />

    <!-- An automation involves no model of its own: there is no instruction to edit and no text
         for an assigned skill to be pasted into, so the page says why rather than offering either. -->
    <p v-if="!def.instruction" class="agp__note">{{ t('settings.aiAgents.automationNote') }}</p>
    <AiAgentEditor v-else-if="owner.scope === 'workspace'" :key="owner.id" :def="def" :owner="owner" />
    <AiAgentReadonly
      v-else
      :def="def"
      :owner="owner"
      :workspace-id="workspaceId"
      :workspace-name="workspaceName"
      @open-workspace="emit('open-workspace')"
    />
  </div>
</template>

<script setup lang="ts">
// «ШІ-команда → Агенти → <агент>» (docs/specs/2026-11-03-ai-team-agent-pages.md, decision 5): what
// the agent is and how it works, then what it is told. The «Як працює» texts are i18n
// (`aiTeam.agents.about.<id>`), written from the code; the instruction is the workspace's editor
// at the workspace scope and a read-only resolution at the project scope (decision 1).
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { MINION_AGENT_ID, TESTER_AGENT_ID, type AgentDef } from '@kermanych/core';
import type { AiOwner } from '@kermanych/cloud';
import AiAgentEditor from './AiAgentEditor.vue';
import AiAgentReadonly from './AiAgentReadonly.vue';
import MinionMachineBlock from './MinionMachineBlock.vue';
import TesterPanel from './TesterPanel.vue';

const props = defineProps<{ def: AgentDef; owner: AiOwner; workspaceId: string | undefined; workspaceName: string | undefined }>();
const emit = defineEmits<{ 'open-workspace': [] }>();
const { t } = useI18n();

function about(key: string): string {
  return t(`aiTeam.agents.about.${props.def.id}.${key}`);
}

// One step per line in the catalogue; the list numbers them.
const steps = computed(() => about('steps').split('\n').filter((s) => s.trim() !== ''));
// Empty when Kermanych appends nothing beyond the assigned skills, which the skills block says.
const adds = computed(() => about('adds'));
</script>

<style scoped lang="scss">
.agp { display: flex; flex-direction: column; gap: var(--k-sp-5); }

.agp__meta { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.agp__id { font-size: 11px; color: var(--k-faint); }
.agp__badge { font-size: 10.5px; padding: 1px 6px; border: 1px solid var(--k-line-strong); border-radius: var(--k-r); color: var(--k-muted); white-space: nowrap; cursor: default; }
/* Agent kinds, the vocabulary the whole «ШІ-команда» group uses: accent for its own session,
   plain for a message into a running one, dashed for the automations. */
.agp__badge--session { color: var(--k-accent); border-color: var(--k-accent); }
.agp__badge--procedure { color: var(--k-text); }
.agp__badge--automation { border-style: dashed; }

.agp__section { display: flex; flex-direction: column; }
/* line-height: Quasar's global h2 one is sized for a display heading. */
.agp__h { margin: 0 0 var(--k-sp-2); font-size: var(--k-fs-md); font-weight: var(--k-fw-semibold); line-height: 1.3; color: var(--k-text); }

// A two-column definition list: the question on the left, the answer beside it. It folds to one
// column on a narrow pane, where a 160px label column would squeeze the answer.
.agp__how {
  display: grid;
  grid-template-columns: 170px 1fr;
  gap: var(--k-sp-3) var(--k-sp-4);
  margin: 0;
  font-size: var(--k-fs-base);
  line-height: 1.5;

  dt {
    color: var(--k-faint);
    font-size: var(--k-fs-sm);
    padding-top: 1px;
  }

  dd {
    margin: 0;
    color: var(--k-text);
  }

  @media (max-width: 900px) {
    grid-template-columns: 1fr;
    gap: 2px;

    dd + dt {
      margin-top: var(--k-sp-3);
    }
  }
}

.agp__steps { margin: 0; padding-left: 20px; display: flex; flex-direction: column; gap: 2px; }
.agp__inputs { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 4px; }
.agp__inputs li { display: flex; gap: var(--k-sp-2); align-items: baseline; }
.agp__hole { flex: none; font-size: 11.5px; color: var(--k-muted); }

.agp__note { margin: 0; font-size: 12px; color: var(--k-muted); }
</style>
