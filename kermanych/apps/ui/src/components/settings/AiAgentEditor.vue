<template>
  <div class="aed">
    <!-- Said once, at the top: every control below is disabled for a member. -->
    <p v-if="!canWrite" class="aed__readonly">{{ t('settings.aiAgents.readOnly') }}</p>
    <p v-if="error" class="aed__error mono">{{ error }}</p>

    <!-- Gated on the read having SUCCEEDED: after a failed read the box would hold the
         compile-time default and nothing assigned — a confident claim about a workspace it could
         not read, and one the operator could then SAVE. -->
    <KSkeleton v-if="phase === 'skeleton'" variant="card" :rows="2" />
    <template v-else-if="phase === 'ready' && loaded">
      <section class="aed__section">
        <h2 class="aed__h">
          {{ t('aiTeam.agents.instructionTitle') }}
          <span v-if="override" class="aed__badge aed__badge--own">{{ t('aiTeam.agents.overridden') }}</span>
        </h2>
        <p class="aed__caption">{{ t('settings.aiAgents.instructionCaption') }}</p>
        <!-- The FULL text, editable, in the language the agent receives it in. -->
        <KField
          multiline
          :rows="14"
          :model-value="draft"
          :disabled="!canWrite || busy"
          @update:model-value="onEdit"
        />
        <!-- v-pre: the braces here are literal text, not an interpolation. -->
        <i18n-t keypath="settings.aiAgents.holesHint" tag="p" class="aed__hint">
          <template #braces><span class="mono" v-pre>{{…}}</span></template>
        </i18n-t>
        <!-- The declared holes, named: they are what `instructionErrors` measures the edited
             text against, so an operator who drops one must be able to see which. -->
        <i18n-t v-if="def.holes?.length" keypath="settings.aiAgents.holesRequired" tag="p" class="aed__hint">
          <template #holes><span class="mono">{{ def.holes.join(', ') }}</span></template>
        </i18n-t>
        <!-- Read-only: Kermanych appends this after ANY instruction, default or override, so
             every project syncs the base before pushing. -->
        <template v-if="def.id === 'pull-request' || def.id === 'commit'">
          <p class="aed__caption">{{ t('settings.aiAgents.baseSyncCaption') }}</p>
          <pre class="aed__text mono">{{ BASE_SYNC_PREVIEW }}</pre>
        </template>
        <!-- docs/specs/2026-11-06-skill-improvement-reflection.md: the reflection step, at the
             operator's own level; appended last, after any instruction. -->
        <template v-if="SKILL_REFLECTION_AGENT_IDS.includes(def.id) && reflectionPreview">
          <p class="aed__caption">{{ t('settings.aiAgents.reflectionCaption') }}</p>
          <pre class="aed__text mono">{{ reflectionPreview }}</pre>
        </template>

        <p v-if="rowError" class="aed__error mono">{{ rowError }}</p>
        <p v-else-if="saved" class="aed__saved">{{ t('settings.aiAgents.saved') }}</p>

        <div class="aed__actions">
          <KBtn variant="primary" :disabled="!canWrite || busy || !dirty" :loading="saving.busy.value" @click="saving.run()">
            {{ t('settings.aiAgents.save') }}
          </KBtn>
          <KBtn variant="secondary" :disabled="!canWrite || busy || !dirty" @click="cancelEdit">
            {{ t('settings.aiAgents.cancel') }}
          </KBtn>
          <!-- Only with a row to delete: with no override there is nothing to reset TO. -->
          <KBtn
            v-if="override"
            class="aed__reset"
            variant="secondary"
            :disabled="!canWrite || busy"
            :loading="resetting.busy.value"
            @click="askReset"
          >{{ t('settings.aiAgents.resetDefault') }}</KBtn>
        </div>
        <AiProvenance
          v-if="override"
          :owner="owner"
          :created-at="override.createdAt"
          :created-by="override.createdBy"
          :updated-at="override.updatedAt"
          :updated-by="override.updatedBy"
        />
      </section>

      <section class="aed__section">
        <h2 class="aed__h">{{ t('aiTeam.agents.skillsTitle') }}</h2>
        <p class="aed__caption">{{ t('settings.aiAgents.skillsCaption') }}</p>
        <!-- Optimistic: the reordered list shows at once and the editor locks with a spinner
             until the replace-all lands; a refusal puts the stored order back. -->
        <SkillSequence
          :names="sequenceSave.value.value"
          :view="view"
          :body-bytes="bodyBytes"
          :repo="{}"
          :disabled="!canWrite || busy"
          :loading="sequenceSave.pending.value"
          @update:names="sequenceSave.set($event)"
        />
        <!-- The literal header the agent receives above its assigned bodies. Imported, never
             retyped: this string is also what the launcher pastes (core/skills.ts). -->
        <p class="aed__caption">{{ t('settings.aiAgents.headerCaption') }}</p>
        <pre class="aed__text mono">{{ ASSIGNED_BLOCK_HEADER }}</pre>
        <p v-if="def.id === MINION_AGENT_ID" class="aed__hint">{{ t('minion.panel.findingsSkill', { name: MINION_FINDINGS_SKILL }) }}</p>
      </section>
    </template>
  </div>
</template>

<script setup lang="ts">
// «ШІ-команда» → workspace → «Агенти» → an agent: the workspace's instruction and skill sequence
// for ONE agent (docs/specs/2026-11-03-ai-team-agent-pages.md, decision 5). The same writes the
// former all-agents panel made, for the agent the page is about.
//
// A MISSING `ai_agents` ROW IS NOT AN EMPTY INSTRUCTION. It means «use the compile-time default»,
// which is why the box is seeded through `effectiveInstruction` and why saving text that equals
// the default deletes the row rather than storing a copy of it: a stored duplicate would silently
// stop tracking the harness the next time a default is improved.
//
// Keyed on the agent AND the owner by the page, so another agent or another workspace is a fresh
// mount: a draft typed for one is never savable into the other, and no write has to check that
// the owner it started for is still the one on screen. Leaving the page by a route with an
// unsaved draft asks first (decision 7).
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { onBeforeRouteLeave, onBeforeRouteUpdate } from 'vue-router';
import {
  ASSIGNED_BLOCK_HEADER,
  MINION_AGENT_ID,
  MINION_FINDINGS_SKILL,
  DEFAULT_SKILL_IMPROVEMENT_LEVEL,
  SKILL_REFLECTION_AGENT_IDS,
  baseSyncBlock,
  skillReflectionBlock,
  effectiveInstruction,
  instructionErrors,
  type AgentDef,
  type SkillView,
} from '@kermanych/core';
import {
  deleteAiAgent,
  listAiAgentSkills,
  listAiAgents,
  listAiSkills,
  setAiAgentSkills,
  upsertAiAgent,
  type AiAgent,
  type AiOwner,
} from '@kermanych/cloud';
import { useAuth } from 'stores/auth';
import { useProjects } from 'stores/projects';
import { confirmAction } from '../../lib/confirm';
import { ownerLibraryView, resolveAgent } from '../../lib/ai-team';
import { errorText, useAsyncAction } from '../../composables/useAsyncAction';
import { useOptimisticValue } from '../../composables/useOptimisticValue';
import { useLoadPhase } from '../../composables/useLoadPhase';
import KBtn from 'components/kit/KBtn.vue';
import KField from 'components/kit/KField.vue';
import KSkeleton from 'components/kit/KSkeleton.vue';
import SkillSequence, { measureSkillBytes } from './SkillSequence.vue';
import AiProvenance from './AiProvenance.vue';

const props = defineProps<{ def: AgentDef; owner: AiOwner }>();

const auth = useAuth();
const projects = useProjects();
const { t } = useI18n();
// Rendered here, not in the template: a literal `<base>` inside a mustache trips the SFC parser.
const BASE_SYNC_PREVIEW = baseSyncBlock('<base>');
// The reflection step at the operator's own level, as Kermanych appends it now; none at `off`.
const reflectionPreview = computed(() => {
  const level = auth.skillImprovementLevel ?? DEFAULT_SKILL_IMPROVEMENT_LEVEL;
  return level === 'off' ? '' : skillReflectionBlock(level);
});

const view = ref<SkillView[]>([]);
const bodyBytes = ref<Record<string, number>>({});
const override = ref<AiAgent | undefined>(undefined);
const sequence = ref<string[]>([]);
// What is in the box, and what «unchanged» means for it: the effective text as of the last read.
const draft = ref('');
const baseline = ref('');
const rowError = ref('');
const saved = ref(false);
const error = ref('');
const loaded = ref(false);
const phase = useLoadPhase(() => !loaded.value && !error.value);

const canWrite = computed(() => projects.isWorkspaceOwner(props.owner.id));
const dirty = computed(() => draft.value !== baseline.value);

function onEdit(value: string): void {
  draft.value = value;
  // Both notices belong to the text as it was when they were shown.
  rowError.value = '';
  saved.value = false;
}

function cancelEdit(): void {
  draft.value = baseline.value;
  rowError.value = '';
  saved.value = false;
}

// Bumped per read: a save and a reset each end in a reload, and only the newest may paint.
let loadRun = 0;
async function load(): Promise<void> {
  const run = ++loadRun;
  error.value = '';
  try {
    const [stored, assignments, rows] = await Promise.all([
      listAiSkills(auth.client, props.owner),
      listAiAgentSkills(auth.client, props.owner),
      listAiAgents(auth.client, props.owner),
    ]);
    if (run !== loadRun) return;
    const library = ownerLibraryView(stored);
    view.value = library;
    bodyBytes.value = measureSkillBytes(library, stored);
    sequence.value = resolveAgent(props.def, [], assignments).skills;
    override.value = rows.find((r) => r.agentId === props.def.id);
    // `effectiveInstruction` is the seed, not the stored text: a row that got into the database
    // broken runs the default at launch, so the box shows the default too. A dirty draft survives
    // a reload (a refused save must not throw the operator's typing away).
    const base = effectiveInstruction(props.def, override.value?.instruction) ?? '';
    if (!dirty.value) draft.value = base;
    baseline.value = base;
    loaded.value = true;
  } catch (e) {
    if (run !== loadRun) return;
    loaded.value = false;
    error.value = errorText(e);
  }
}
void load();

// The three ways an edited template can be wrong, refused HERE rather than written: a blank text
// leaves the agent with no instruction at all, a dropped hole means the runtime's variable never
// reaches the model, and an invented hole makes `renderInstruction` throw at launch.
function validate(text: string): string {
  if (!text.trim()) return t('settings.aiAgents.errEmpty');
  const { missing, unknown } = instructionErrors(props.def, text);
  if (missing.length) return t('settings.aiAgents.errMissing', { holes: missing.join(', ') });
  if (unknown.length) return t('settings.aiAgents.errUnknown', { holes: unknown.join(', ') });
  return '';
}

// «Збережено» shows only once the reload has brought the stored text back, so it is a receipt for
// what the box now holds rather than for the request.
const saving = useAsyncAction(async () => {
  const text = draft.value;
  saved.value = false;
  rowError.value = validate(text);
  if (rowError.value) return;
  try {
    // Byte-for-byte the harness default: the honest way to store «no change» is no row.
    if (text === props.def.instruction) {
      if (override.value) await deleteAiAgent(auth.client, props.owner, props.def.id);
    } else {
      await upsertAiAgent(auth.client, { owner: props.owner, agentId: props.def.id, instruction: text });
    }
  } catch (e) {
    rowError.value = errorText(e);
    return;
  }
  // The re-read owns the box again: the stored text, not the string sent, is what it must show.
  baseline.value = text;
  draft.value = text;
  await load();
  if (loaded.value) saved.value = true;
});

// Reset deletes the edited instruction, so it asks first; only a «yes» starts the spinner.
async function askReset(): Promise<void> {
  const ok = await confirmAction({
    title: t('confirmations.resetAgent.title'),
    message: t('confirmations.resetAgent.message', { name: t(props.def.labelKey) }),
    confirmLabel: t('confirmations.label.reset'),
  });
  if (ok) void resetting.run();
}

// Reset IS the delete: with no row the effective instruction falls back to the default.
// `deleteAiAgent` throws when it matched nothing — an RLS refusal reads like success otherwise.
const resetting = useAsyncAction(async () => {
  rowError.value = '';
  saved.value = false;
  try {
    await deleteAiAgent(auth.client, props.owner, props.def.id);
  } catch (e) {
    rowError.value = errorText(e);
    return;
  }
  // The operator's text is what they just asked to throw away: it must not survive as a draft.
  baseline.value = draft.value;
  await load();
});

// `setAiAgentSkills` is a replace-all of exactly this list, so on success the local state IS what
// the cloud holds. Throws on failure: the optimistic value puts the stored order back.
const sequenceSave = useOptimisticValue(
  () => sequence.value,
  async (names: string[]) => {
    error.value = '';
    await setAiAgentSkills(auth.client, props.owner, props.def.id, names);
    sequence.value = names;
  },
  { onError: (e) => (error.value = errorText(e)) },
);

const busy = computed(() => saving.busy.value || resetting.busy.value || sequenceSave.pending.value);

// Leaving the page — another agent, the list, another section or screen — with an unsaved
// instruction asks first. A sidebar switch changes no route and remounts this editor, dropping
// the draft on purpose: text typed for one workspace is never saved into another.
async function confirmLeave(): Promise<boolean> {
  if (!dirty.value) return true;
  return await confirmAction({
    title: t('confirmations.leaveAgent.title'),
    message: t('confirmations.leaveAgent.message', { name: t(props.def.labelKey) }),
    confirmLabel: t('confirmations.label.leave'),
  });
}
onBeforeRouteLeave(confirmLeave);
onBeforeRouteUpdate(confirmLeave);
</script>

<style scoped lang="scss">
.aed { display: flex; flex-direction: column; gap: var(--k-sp-5); }
.aed__section { display: flex; flex-direction: column; }
.aed__h {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0 0 var(--k-sp-2);
  font-size: var(--k-fs-md);
  font-weight: var(--k-fw-semibold);
  line-height: 1.3;
  color: var(--k-text);
}
.aed__badge { font-size: 10.5px; font-weight: var(--k-fw-regular); padding: 1px 6px; border: 1px solid var(--k-line-strong); border-radius: var(--k-r); color: var(--k-muted); white-space: nowrap; }
.aed__badge--own { color: var(--k-accent); border-color: var(--k-accent); }
.aed__readonly { margin: 0; font-size: 12px; color: var(--k-muted); }
.aed__caption { margin: 12px 0 4px; font-size: 11.5px; color: var(--k-muted); }
.aed__hint { margin: 6px 0 0; font-size: 11px; color: var(--k-muted); }
/* `pre-wrap` and `--k-surface2`, the treatment every verbatim block on this screen gets: text a
   model receives, shown exactly as it receives it. */
.aed__text {
  margin: 0;
  padding: 8px 10px;
  font-size: 11.5px;
  line-height: 1.5;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  background: var(--k-surface2);
  border-radius: var(--k-r);
}
.aed__actions { display: flex; align-items: center; gap: 6px; margin-top: 10px; }
/* «Повернути дефолт» discards the stored row rather than the current edit, so it sits against
   the right edge, away from Save/Cancel. */
.aed__reset { margin-left: auto; }
.aed__error { margin: 6px 0 0; font-size: 11.5px; color: var(--k-accent); overflow-wrap: anywhere; }
/* Muted, not accent: a save that worked is a receipt, not something to look at. */
.aed__saved { margin: 6px 0 0; font-size: 11.5px; color: var(--k-muted); }
</style>
