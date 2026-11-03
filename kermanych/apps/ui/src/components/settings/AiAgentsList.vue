<template>
  <section class="agl">
    <p v-if="error" class="agl__error mono">{{ t('aiTeam.agents.loadFailed', { error }) }}</p>
    <template v-for="g in groups" :key="g.key">
      <p class="agl__cap">{{ t('aiTeam.agents.groups.' + g.key) }}</p>
      <ul class="agl__list">
        <li v-for="def in g.defs" :key="def.id">
          <RouterLink class="agl__row" :to="{ name: 'ai-team', params: { section: 'agents', item: def.id } }">
            <span class="agl__disc" aria-hidden="true"><KIcon :name="AGENT_ICONS[def.id] ?? 'minion'" /></span>
            <span class="agl__text">
              <span class="agl__name">{{ t(def.labelKey) }}</span>
              <span class="agl__tagline">{{ t('aiTeam.agents.about.' + def.id + '.tagline') }}</span>
            </span>
            <!-- The marks need the rows; until they land the row is complete without them — the
                 name and the sentence are compile-time — so nothing stands in their place. -->
            <span v-if="loaded" class="agl__marks">
              <span v-if="resolved[def.id]?.instructionFrom !== 'default' && def.instruction" class="agl__badge agl__badge--own">{{ t('aiTeam.agents.overridden') }}</span>
              <span v-if="resolved[def.id]?.skills.length" class="agl__badge">
                {{ t('aiTeam.agents.skillCount', { n: resolved[def.id]!.skills.length }, resolved[def.id]!.skills.length) }}
              </span>
            </span>
            <span class="agl__chevron" aria-hidden="true"><KIcon name="chevronRight" /></span>
          </RouterLink>
        </li>
      </ul>
    </template>
  </section>
</template>

<script setup lang="ts">
// «ШІ-команда → Агенти»: the short list (docs/specs/2026-11-03-ai-team-agent-pages.md, decisions
// 3-4). One line per agent — its mark, its name, what it does — grouped by the stage of work, each
// row a link to the agent's page. The marks say what a launch here would get: «переписано» when
// the effective instruction is not Kermanych's, «N навичок» when a sequence is assigned. In the
// project scope that is the project's rows over its workspace's, resolved like the launch.
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { AGENTS, type AgentDef } from '@kermanych/core';
import type { AiOwner } from '@kermanych/cloud';
import { AGENT_ICONS, AI_TEAM_AGENT_GROUPS, resolveAgent, type ResolvedAgent } from '../../lib/ai-team';
import { agentOwners, useAiAgentRows } from '../../composables/useAiAgentRows';
import KIcon from 'components/kit/KIcon.vue';

const props = defineProps<{ owner: AiOwner; workspaceId: string | undefined }>();
const { t } = useI18n();

const { agents, skills, loaded, error } = useAiAgentRows(() => agentOwners(props.owner, props.workspaceId));

const groups = computed(() =>
  AI_TEAM_AGENT_GROUPS.map((g) => ({
    key: g.key,
    defs: g.agents.map((id) => AGENTS.find((a) => a.id === id)).filter((a): a is AgentDef => !!a),
  })),
);

const resolved = computed<Record<string, ResolvedAgent>>(() =>
  Object.fromEntries(AGENTS.map((def) => [def.id, resolveAgent(def, agents.value, skills.value)])),
);
</script>

<style scoped lang="scss">
.agl {
  display: flex;
  flex-direction: column;
}

.agl__error {
  margin: 0 0 var(--k-sp-3);
  font-size: 11.5px;
  color: var(--k-accent);
  overflow-wrap: anywhere;
}

// The group caption, the same small spaced type the rail's captions use.
.agl__cap {
  margin: var(--k-sp-4) 0 var(--k-sp-2);
  font-size: 10px;
  letter-spacing: 0.22em;
  color: var(--k-faint);

  &:first-of-type {
    margin-top: 0;
  }
}

.agl__list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.agl__row {
  display: flex;
  align-items: center;
  gap: var(--k-sp-3);
  padding: var(--k-sp-2) var(--k-sp-3);
  color: inherit;
  text-decoration: none;
  border-radius: var(--k-r);
  transition: background 0.12s;

  &:hover {
    background: color-mix(in srgb, var(--k-surface2) 60%, transparent);
  }

  &:hover .agl__chevron {
    color: var(--k-muted);
  }

  &:focus-visible {
    outline: 1px solid var(--k-accent);
    outline-offset: 1px;
  }
}

// The mark in a disc, as in the «Нова задача» menu (KSplitButton): the eye finds the row by its
// shape before it reads the name.
.agl__disc {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  border-radius: 50%;
  background: color-mix(in srgb, var(--k-accent) 16%, transparent);
  color: var(--k-accent);
  --k-icon-size: var(--k-icon-md);
}

.agl__text {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.agl__name {
  font-size: var(--k-fs-base);
  font-weight: var(--k-fw-semibold);
  color: var(--k-text);
}

.agl__tagline {
  font-size: var(--k-fs-sm);
  color: var(--k-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.agl__marks {
  flex: none;
  display: flex;
  gap: 6px;
}

.agl__badge {
  font-size: 10.5px;
  padding: 1px 6px;
  border: 1px solid var(--k-line-strong);
  border-radius: var(--k-r);
  color: var(--k-muted);
  white-space: nowrap;
}

// Accent for the owner's own text, as the library marks a «проєкт» skill.
.agl__badge--own {
  color: var(--k-accent);
  border-color: var(--k-accent);
}

.agl__chevron {
  flex: none;
  color: var(--k-faint);
  --k-icon-size: var(--k-icon-sm);
}
</style>
