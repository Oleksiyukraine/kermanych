<template>
  <!-- Hidden when there is nothing to say: the usual project has no row of its own, and an empty
       «перевизначення» heading would read as one. Holds its place with a skeleton while reading. -->
  <section
    v-if="error || phase === 'skeleton' || (phase === 'ready' && entries.length)"
    class="ov"
    :aria-label="t('aiTeam.overrides.title')"
  >
    <p class="ov__title">{{ t('aiTeam.overrides.title') }}</p>
    <p class="ov__lead">{{ t('aiTeam.overrides.lead') }}</p>
    <p v-if="error" class="ov__error mono">{{ error }}</p>
    <KSkeleton v-else-if="phase === 'skeleton'" variant="lines" :rows="2" />
    <ul v-else class="ov__list">
      <li v-for="e in entries" :key="keyOf(e)" class="ov__row">
        <div class="ov__head">
          <span class="ov__name">{{ agentName(e.agentId) }}</span>
          <span class="ov__id mono">{{ e.agentId }}</span>
          <span class="ov__badge">{{ t('aiTeam.overrides.source', { scope: t('aiTeam.scope.' + e.owner.scope) }) }}</span>
          <button
            type="button"
            class="ov__btn"
            :disabled="!canWrite(e.owner) || resetting.busyFor(keyOf(e))"
            :aria-busy="resetting.busyFor(keyOf(e)) || undefined"
            @click="askReset(e)"
          >
            <KSpinner v-if="resetting.busyFor(keyOf(e))" :size="10" />
            {{ t('aiTeam.overrides.reset') }}
          </button>
        </div>
        <template v-if="e.instruction !== undefined">
          <p class="ov__caption">{{ t('aiTeam.overrides.instruction') }}</p>
          <pre class="ov__text mono">{{ e.instruction }}</pre>
          <!-- A broken row still beats the workspace: the launch drops it for the DEFAULT, never
               for the workspace's text (SkillsService.instructionFor). -->
          <p v-if="broken(e)" class="ov__hint">{{ t('aiTeam.overrides.broken') }}</p>
        </template>
        <template v-if="e.skills.length">
          <p class="ov__caption">{{ t('aiTeam.overrides.skills') }}</p>
          <ol class="ov__skills mono">
            <li v-for="name in e.skills" :key="name">{{ name }}</li>
          </ol>
        </template>
        <p v-if="!canWrite(e.owner)" class="ov__hint">{{ t('aiTeam.overrides.readOnly') }}</p>
        <p v-if="rowError[keyOf(e)]" class="ov__error mono">{{ rowError[keyOf(e)] }}</p>
      </li>
    </ul>
  </section>
</template>

<script setup lang="ts">
// «ШІ-команда» → project / user → «Агенти»: the agent rows these owners hold BELOW the workspace.
// Agents are edited at the workspace only, yet a launch takes an agent's instruction, and
// separately its skill sequence, from the most specific owner that has one — so a project row
// (a `project_agents` row the 20260908 rescope moved in) or a user row silently wins over every
// workspace edit. This block names each such row with its source and lets the owner who may write
// it delete it, after which the workspace's row applies. Nothing here edits a row: the editor is
// the workspace's.
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { agentById, effectiveInstruction } from '@kermanych/core';
import { deleteAiAgent, listAiAgentSkills, listAiAgents, setAiAgentSkills, type AiOwner } from '@kermanych/cloud';
import { useAuth } from 'stores/auth';
import { useProjects } from 'stores/projects';
import { agentOverrides, type AgentOverride } from '../../lib/ai-team';
import { confirmAction } from '../../lib/confirm';
import { errorText, useKeyedAction } from '../../composables/useAsyncAction';
import { useLoadPhase } from '../../composables/useLoadPhase';
import KSkeleton from 'components/kit/KSkeleton.vue';
import KSpinner from 'components/kit/KSpinner.vue';

const props = defineProps<{ owners: AiOwner[] }>();
// After a row is gone, so whatever shows the resolved agent (MinionPanel) reads again.
const emit = defineEmits<{ reset: [] }>();

const { t } = useI18n();
const auth = useAuth();
const projects = useProjects();

const entries = ref<AgentOverride[]>([]);
const error = ref('');
const rowError = ref<Record<string, string>>({});
// The owners whose read last finished (either way). A different current key is «not loaded yet».
const loadedFor = ref('');
const ownersKey = computed(() => props.owners.map((o) => `${o.scope}:${o.id}`).join(','));
const phase = useLoadPhase(() => loadedFor.value !== ownersKey.value);

function keyOf(e: AgentOverride): string {
  return `${e.owner.scope}:${e.owner.id}:${e.agentId}`;
}

function agentName(agentId: string): string {
  const def = agentById(agentId);
  return def ? t(def.labelKey) : agentId;
}

function broken(e: AgentOverride): boolean {
  const def = agentById(e.agentId);
  return !!def?.instruction && e.instruction !== undefined && effectiveInstruction(def, e.instruction) !== e.instruction.trim();
}

// The same rule every pane of this screen writes by (RLS is the real gate): a user owns their
// own rows, a project's rows belong to its workspace owner.
function canWrite(owner: AiOwner): boolean {
  return owner.scope === 'user' ? owner.id === auth.user?.id : projects.isOwner(owner.id);
}

// Bumped per read: a reset ends in a reload, and only the newest read may paint.
let loadRun = 0;
async function load(): Promise<void> {
  const key = ownersKey.value;
  const owners = props.owners;
  const run = ++loadRun;
  try {
    const [agents, assignments] = await Promise.all([
      Promise.all(owners.map((o) => listAiAgents(auth.client, o))),
      Promise.all(owners.map((o) => listAiAgentSkills(auth.client, o))),
    ]);
    if (run !== loadRun || key !== ownersKey.value) return;
    entries.value = agentOverrides(agents.flat(), assignments.flat());
    error.value = '';
  } catch (e) {
    if (run !== loadRun || key !== ownersKey.value) return;
    entries.value = [];
    error.value = errorText(e);
  } finally {
    if (run === loadRun && key === ownersKey.value) loadedFor.value = key;
  }
}

watch(
  ownersKey,
  () => {
    // Another owner's rows are not these: dropped at once, not after the read.
    entries.value = [];
    error.value = '';
    rowError.value = {};
    void load();
  },
  { immediate: true },
);

// Both halves the owner holds for the agent go: the instruction row (deleteAiAgent throws when
// RLS matched nothing) and the whole sequence. The reload is what the screen reflects, after a
// refusal too: the instruction may be gone while the sequence was refused.
const resetting = useKeyedAction(async (key: string, e: AgentOverride) => {
  rowError.value = { ...rowError.value, [key]: '' };
  try {
    if (e.instruction !== undefined) await deleteAiAgent(auth.client, e.owner, e.agentId);
    if (e.skills.length) await setAiAgentSkills(auth.client, e.owner, e.agentId, []);
  } catch (err) {
    rowError.value = { ...rowError.value, [key]: errorText(err) };
  }
  await load();
  emit('reset');
});

async function askReset(e: AgentOverride): Promise<void> {
  if (resetting.busyFor(keyOf(e))) return;
  const ok = await confirmAction({
    title: t('confirmations.resetAgentOverride.title'),
    message: t('confirmations.resetAgentOverride.message', {
      name: agentName(e.agentId),
      scope: t('aiTeam.scope.' + e.owner.scope),
    }),
    confirmLabel: t('confirmations.label.reset'),
  });
  if (ok) void resetting.run(keyOf(e), e);
}
</script>

<style scoped lang="scss">
.ov { margin-bottom: 10px; padding: 10px 12px; border: 1px solid var(--k-accent); border-radius: var(--k-r); }
.ov__title { margin: 0 0 4px; font-size: 12.5px; color: var(--k-accent); }
.ov__lead { margin: 0 0 8px; font-size: 12px; color: var(--k-muted); }
.ov__list { list-style: none; margin: 0; padding: 0; display: grid; gap: 10px; }
.ov__row { padding-top: 8px; border-top: 1px dashed var(--k-line); }
.ov__head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.ov__name { font-size: 12.5px; }
.ov__id { font-size: 11px; color: var(--k-faint); }
.ov__badge { font-size: 10.5px; padding: 1px 6px; border: 1px solid var(--k-accent); border-radius: var(--k-r); color: var(--k-accent); white-space: nowrap; }
.ov__btn {
  margin-left: auto;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font: inherit;
  font-size: 12px;
  padding: 3px 10px;
  background: transparent;
  color: var(--k-text);
  border: 1px solid var(--k-line-strong);
  border-radius: var(--k-r);
  cursor: pointer;
}
.ov__btn:disabled { opacity: 0.45; cursor: default; }
.ov__caption { margin: 10px 0 4px; font-size: 11.5px; color: var(--k-muted); }
/* The verbatim treatment every model-facing text gets on this screen. */
.ov__text {
  margin: 0;
  padding: 8px 10px;
  font-size: 11.5px;
  line-height: 1.5;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  background: var(--k-surface2);
  border-radius: var(--k-r);
  max-height: 240px;
  overflow-y: auto;
}
.ov__skills { margin: 0; padding-left: 20px; font-size: 12px; }
.ov__hint { margin: 6px 0 0; font-size: 11px; color: var(--k-muted); }
.ov__error { margin: 6px 0 0; font-size: 11.5px; color: var(--k-accent); overflow-wrap: anywhere; }
</style>
