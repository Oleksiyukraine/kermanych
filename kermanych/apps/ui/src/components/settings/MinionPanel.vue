<template>
  <section class="mn">
    <div class="mn__row">
      <div class="mn__head">
        <span class="mn__name">{{ t('agents.role.minion') }}</span>
        <span class="mn__id mono">{{ MINION_AGENT_ID }}</span>
        <span v-if="active" class="mn__badge mn__badge--on">{{ t('minion.panel.active') }}</span>
      </div>
      <p class="mn__lead">{{ t('minion.panel.lead') }}</p>

      <!-- Activation is this machine's own fact (SQLite `minion_projects`), never the cloud's:
           another machine of the same account does not start taking cards because of it. -->
      <div class="mn__actions">
        <KBtn
          :variant="active ? 'secondary' : 'primary'"
          :loading="activation.busy.value"
          :disabled="!minion.state || (!active && !bound)"
          @click="activation.run()"
        >{{ active ? t('minion.panel.deactivate') : t('minion.panel.activate') }}</KBtn>
      </div>
      <p v-if="!active && !bound" class="mn__hint">{{ t('minion.panel.notBound') }}</p>
      <p v-else-if="active" class="mn__hint">{{ t('minion.panel.deactivateHint') }}</p>
    </div>

    <!-- НА ЦІЙ МАШИНІ — one cap and one pause for every active project of this machine. -->
    <div class="mn__row">
      <p class="mn__title">{{ t('minion.panel.machineTitle') }}</p>
      <p v-if="minion.loadError && !minion.state" class="mn__error mono">{{ t('minion.panel.loadFailed', { error: minion.loadError }) }}</p>
      <KSkeleton v-else-if="machinePhase === 'skeleton'" variant="lines" :rows="3" />
      <template v-else-if="machinePhase === 'ready' && minion.state">
        <div class="mn__cap">
          <KSelect
            :label="t('minion.panel.cap')"
            :model-value="cap.value.value"
            :options="capOptions"
            :loading="cap.pending.value"
            @update:model-value="cap.set($event)"
          />
          <p class="mn__hint">{{ t('minion.panel.capHint', { max: MINION_CAP_MAX }) }}</p>
        </div>

        <div class="mn__state">
          <span class="mn__state-text" :class="{ 'mn__state-text--paused': minion.state.pause }">
            {{
              minion.state.pause
                ? t('minion.panel.paused', { reason: minionPauseText(t, minion.state.pause) })
                : t('minion.panel.working', { running: minion.state.running, cap: minion.state.cap, waiting: minion.state.waiting })
            }}
          </span>
          <KBtn
            variant="secondary"
            :loading="pausing.busy.value"
            @click="pausing.run(!minion.state.pause)"
          >{{ minion.state.pause ? t('minion.strip.resume') : t('minion.strip.pause') }}</KBtn>
        </div>

        <p class="mn__caption">{{ t('minion.panel.projects') }}</p>
        <p class="mn__projects">{{ activeNames.length ? activeNames.join(', ') : t('minion.panel.noProjects') }}</p>
        <p v-if="minion.state.pollError" class="mn__error mono">{{ t('minion.panel.pollError', { error: minion.state.pollError }) }}</p>
      </template>
    </div>

    <!-- What the minion is told, read-only: the instruction and the skill sequence are the
         WORKSPACE's rows (decision 11), edited only at the workspace scope. -->
    <div class="mn__row">
      <p class="mn__title">{{ t('minion.panel.instructionTitle') }}</p>
      <p v-if="!workspaceId" class="mn__hint">{{ t('minion.panel.noWorkspace') }}</p>
      <template v-else>
        <p v-if="teamError" class="mn__error mono">{{ teamError }}</p>
        <KSkeleton v-else-if="teamPhase === 'skeleton'" variant="lines" :rows="4" />
        <template v-else-if="teamPhase === 'ready' && team">
          <p class="mn__caption">{{ team.overridden ? t('minion.panel.instructionOverride') : t('minion.panel.instructionDefault') }}</p>
          <pre class="mn__text mono">{{ team.instruction }}</pre>
          <p class="mn__caption">{{ t('minion.panel.skills') }}</p>
          <ol v-if="team.skills.length" class="mn__skills mono">
            <li v-for="name in team.skills" :key="name">{{ name }}</li>
          </ol>
          <p v-else class="mn__hint">{{ t('minion.panel.noSkills') }}</p>
        </template>
        <button type="button" class="mn__link" @click="emit('open-workspace')">{{ t('minion.panel.editInWorkspace') }}</button>
      </template>
    </div>
  </section>
</template>

<script setup lang="ts">
// «ШІ-команда» → project → «Агенти»: the «Посіпака» card (docs/specs/2026-10-23-minion-auto-run.md,
// decisions 6, 8 and 11). Three blocks: switching it on for THIS project on THIS machine; the
// machine's own cap, state and active projects (stores/minion, fed by the api's socket); and,
// read-only, what the workspace tells it — the instruction and the skill sequence are edited only
// at the workspace scope, where AiAgentsPanel lists the minion like every other agent.
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { MINION_AGENT_ID, MINION_CAP_MAX, agentById, effectiveInstruction } from '@kermanych/core';
import { listAiAgentSkills, listAiAgents } from '@kermanych/cloud';
import { useAuth } from 'stores/auth';
import { useMinion } from 'stores/minion';
import { useOrchestrator } from 'stores/orchestrator';
import { useProjects } from 'stores/projects';
import { minionPauseText, minionProjectNames } from '../../lib/minion';
import { useAsyncAction } from '../../composables/useAsyncAction';
import { useOptimisticValue } from '../../composables/useOptimisticValue';
import { useLoadPhase } from '../../composables/useLoadPhase';
import KBtn from 'components/kit/KBtn.vue';
import KSelect from 'components/kit/KSelect.vue';
import KSkeleton from 'components/kit/KSkeleton.vue';

const props = defineProps<{ projectId: string; workspaceId: string | undefined }>();
const emit = defineEmits<{ 'open-workspace': [] }>();

const { t } = useI18n();
const auth = useAuth();
const minion = useMinion();
const store = useOrchestrator();
const projects = useProjects();

// ── Activation ───────────────────────────────────────────────────────────
const active = computed(() => !!minion.state?.projects.includes(props.projectId));
// The api refuses `project not bound` too; this greys the button out before the refusal. A
// project already active stays deactivatable whatever its binding.
const bound = computed(() => !!store.projects.find((p) => p.id === props.projectId)?.localRepoPath);
const activation = useAsyncAction(() => minion.setProjectActive(props.projectId, !active.value));

// ── This machine ─────────────────────────────────────────────────────────
const machinePhase = useLoadPhase(() => !minion.state && !minion.loadError);
const capOptions = Array.from({ length: MINION_CAP_MAX }, (_, i) => String(i + 1));
const cap = useOptimisticValue(
  () => String(minion.state?.cap ?? ''),
  (next: string) => minion.setCap(Number(next)),
);
const pausing = useAsyncAction((paused: boolean) => minion.setPaused(paused));
const activeNames = computed(() =>
  minion.state
    ? minionProjectNames(minion.state, (id) => projects.byId.get(id)?.name ?? store.projects.find((p) => p.id === id)?.name)
    : [],
);

// ── The workspace's instruction and skills ───────────────────────────────
// `undefined` until the read for the current workspace answers.
const team = ref<{ instruction: string; overridden: boolean; skills: string[] } | undefined>(undefined);
const teamError = ref('');
const teamPhase = useLoadPhase(() => !!props.workspaceId && !team.value && !teamError.value);
const minionDef = agentById(MINION_AGENT_ID)!;

watch(
  () => props.workspaceId,
  async (workspaceId) => {
    team.value = undefined;
    teamError.value = '';
    if (!workspaceId) return;
    const owner = { scope: 'workspace' as const, id: workspaceId };
    try {
      const [rows, assignments] = await Promise.all([listAiAgents(auth.client, owner), listAiAgentSkills(auth.client, owner)]);
      // A late reply for a workspace the operator has since left must not paint here.
      if (workspaceId !== props.workspaceId) return;
      const stored = rows.find((r) => r.agentId === MINION_AGENT_ID)?.instruction;
      // The same resolution the launch uses: a broken or empty row falls back to the default.
      const instruction = effectiveInstruction(minionDef, stored) ?? '';
      team.value = {
        instruction,
        overridden: instruction !== minionDef.instruction,
        // The comparator SkillsService.assignedFor sorts by, as AiAgentsPanel shows it.
        skills: assignments
          .filter((a) => a.agentId === MINION_AGENT_ID)
          .sort((a, b) => a.position - b.position || a.skillName.localeCompare(b.skillName))
          .map((a) => a.skillName),
      };
    } catch (e) {
      if (workspaceId === props.workspaceId) teamError.value = e instanceof Error ? e.message : String(e);
    }
  },
  { immediate: true },
);
</script>

<style scoped lang="scss">
.mn { display: grid; gap: 10px; }
.mn__row { padding: 10px 12px; background: var(--k-surface); border: 1px solid var(--k-line); border-radius: var(--k-r); }
.mn__head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.mn__name { font-size: 12.5px; }
.mn__id { font-size: 11px; color: var(--k-faint); }
.mn__badge { font-size: 10.5px; padding: 1px 6px; border: 1px solid var(--k-line-strong); border-radius: var(--k-r); color: var(--k-muted); white-space: nowrap; }
.mn__badge--on { color: var(--k-accent); border-color: var(--k-accent); }
.mn__lead { margin: 8px 0 0; font-size: 13px; color: var(--k-muted); }
.mn__title { margin: 0 0 8px; font-size: 12.5px; }
.mn__caption { margin: 12px 0 4px; font-size: 11.5px; color: var(--k-muted); }
.mn__hint { margin: 6px 0 0; font-size: 11px; color: var(--k-muted); }
.mn__error { margin: 6px 0 0; font-size: 11.5px; color: var(--k-accent); overflow-wrap: anywhere; }
.mn__actions { display: flex; gap: 6px; margin-top: 10px; }
.mn__cap { max-width: 220px; }
.mn__state { display: flex; align-items: center; gap: 10px; margin-top: 12px; flex-wrap: wrap; }
.mn__state-text { font-size: 12.5px; }
.mn__state-text--paused { color: var(--k-accent); }
.mn__projects { margin: 0; font-size: 12.5px; }
/* The verbatim treatment every model-facing text gets on this screen (AiAgentsPanel's header). */
.mn__text {
  margin: 0;
  padding: 8px 10px;
  font-size: 11.5px;
  line-height: 1.5;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  background: var(--k-surface2);
  border-radius: var(--k-r);
  max-height: 320px;
  overflow-y: auto;
}
.mn__skills { margin: 0; padding-left: 20px; font-size: 12px; }
.mn__link {
  margin-top: 10px;
  padding: 0;
  font: inherit;
  font-size: 12px;
  color: var(--k-accent);
  background: none;
  border: 0;
  cursor: pointer;
}
</style>
