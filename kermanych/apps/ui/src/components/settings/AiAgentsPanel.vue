<template>
  <section class="ai">
    <i18n-t keypath="settings.aiAgents.lead" tag="p" class="ai__lead">
      <template #project><span class="ai__lead-project mono">{{ ownerName }}</span></template>
    </i18n-t>

    <!-- The literal header the agent receives above its assigned bodies, so «ordered sequence»
         is verifiable rather than a claim about text the operator cannot see. Imported, never
         retyped: this string is also what the launcher pastes (core/skills.ts, assignedBlock). -->
    <p class="ai__caption">{{ t('settings.aiAgents.headerCaption') }}</p>
    <pre class="ai__header mono">{{ ASSIGNED_BLOCK_HEADER }}</pre>

    <!-- Said once, at the top: every control below is disabled for a member, and four rows of
         dimmed buttons without a reason read as a broken screen. -->
    <p v-if="!canWrite" class="ai__readonly">{{ t('settings.aiAgents.readOnly') }}</p>

    <p v-if="error" class="ai__error mono">{{ error }}</p>

    <!-- Gated on the read having SUCCEEDED, not on the data being non-empty: this pane has a row
         per agent whatever the cloud says, so after a failed read it would render four agents
         with the compile-time defaults in their boxes and nothing assigned — a confident claim
         about a project it could not read, and one the operator could then SAVE. A refused write
         leaves the list up: the error line says what was refused and every row is still true. -->
    <ul v-if="loaded" class="ai__list">
      <li
        v-for="a in AGENTS"
        :key="a.id"
        class="ai__row"
        :class="{ 'ai__row--bare': !a.instruction }"
      >
        <div class="ai__head">
          <span class="ai__name">{{ t(a.labelKey) }}</span>
          <span class="ai__id mono">{{ a.id }}</span>
          <span class="ai__badge" :class="`ai__badge--${a.kind}`">{{ t('settings.agentKind.' + a.kind) }}</span>
          <!-- Only for a row that exists: this is the marker that says «this project's text, not
               Kermanych's», and it is also what makes «Повернути дефолт» meaningful. -->
          <span v-if="hasOverride(a.id)" class="ai__badge ai__badge--own">{{ t('settings.aiAgents.overridden') }}</span>
        </div>

        <!-- An automation involves no model at all: there is no instruction to edit and no text
             for an assigned skill to be pasted into. Offering either would promise a delivery
             that cannot happen, so the row says why it is empty instead. -->
        <p v-if="!a.instruction" class="ai__note">{{ t('settings.aiAgents.automationNote') }}</p>

        <template v-else>
          <p class="ai__caption">{{ t('settings.aiAgents.instructionCaption') }}</p>
          <!-- The FULL text, editable, in the language the agent receives it in. A Ukrainian
               rendering beside it would be a second source of truth that drifts the first time
               either is edited — and this box is the one the model actually reads. -->
          <KField
            multiline
            :rows="14"
            :model-value="drafts[a.id] ?? ''"
            :disabled="!canWrite || busy"
            @update:model-value="onEdit(a.id, $event)"
          />
          <!-- v-pre: the braces here are literal text, not an interpolation. -->
          <i18n-t keypath="settings.aiAgents.holesHint" tag="p" class="ai__hint">
            <template #braces><span class="mono" v-pre>{{…}}</span></template>
          </i18n-t>
          <!-- The declared holes, named: they are what `instructionErrors` measures the edited
               text against, so an operator who drops one must be able to see which. -->
          <i18n-t v-if="a.holes?.length" keypath="settings.aiAgents.holesRequired" tag="p" class="ai__hint">
            <template #holes><span class="mono">{{ a.holes.join(', ') }}</span></template>
          </i18n-t>

          <p v-if="rowError[a.id]" class="ai__error mono">{{ rowError[a.id] }}</p>
          <p v-else-if="savedRow[a.id]" class="ai__saved">{{ t('settings.aiAgents.saved') }}</p>

          <div class="ai__actions">
            <button
              type="button"
              class="ai__btn ai__btn--primary"
              :disabled="!canWrite || busy || !dirty(a.id)"
              @click="saveInstruction(a)"
            >{{ t('settings.aiAgents.save') }}</button>
            <button
              type="button"
              class="ai__btn"
              :disabled="!canWrite || busy || !dirty(a.id)"
              @click="cancelEdit(a.id)"
            >{{ t('settings.aiAgents.cancel') }}</button>
            <!-- Only with a row to delete: with no override there is nothing to reset TO, and a
                 live button that would refuse the delete is worse than no button. -->
            <button
              v-if="hasOverride(a.id)"
              type="button"
              class="ai__btn ai__btn--reset"
              :disabled="!canWrite || busy"
              @click="resetToDefault(a.id)"
            >{{ t('settings.aiAgents.resetDefault') }}</button>
          </div>
          <AiProvenance
            v-if="overrideOf(a.id)"
            :owner="owner"
            :created-at="overrideOf(a.id)!.createdAt"
            :created-by="overrideOf(a.id)!.createdBy"
            :updated-at="overrideOf(a.id)!.updatedAt"
            :updated-by="overrideOf(a.id)!.updatedBy"
          />

          <p class="ai__caption">{{ t('settings.aiAgents.skillsCaption') }}</p>
          <SkillSequence
            :names="sequences[a.id] ?? []"
            :view="view"
            :body-bytes="bodyBytes"
            :repo="repo"
            :disabled="!canWrite || busy"
            @update:names="setSequence(a.id, $event)"
          />
        </template>
      </li>
    </ul>
  </section>
</template>

<script setup lang="ts">
// «Агенти»: Kermanych's own team, as this project has it. Both halves of «who does» live here —
// the INSTRUCTION each agent is given and the ORDERED SEQUENCE of skills pasted under it — and
// both are the project's to edit.
//
// Same split as the panes next door: the RESOLVED library view comes from the local API (only it
// can see whether the bound checkout shadows a name), while the overrides and the assignments are
// cloud rows written straight to Supabase, where RLS makes them owner-only.
//
// A MISSING `project_agents` ROW IS NOT AN EMPTY INSTRUCTION. It means «use the compile-time
// default», which is why the editor is seeded through `effectiveInstruction` and why saving text
// that equals the default deletes the row rather than storing a copy of it: a stored duplicate
// would silently stop tracking the harness the next time a default is improved.
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import {
  AGENTS,
  ASSIGNED_BLOCK_HEADER,
  effectiveInstruction,
  instructionErrors,
  type AgentDef,
  type SkillView,
} from '@kermanych/core';
import {
  deleteAiAgent,
  listAiAgents,
  listAiAgentSkills,
  listAiSkills,
  setAiAgentSkills,
  upsertAiAgent,
  type AiAgent,
  type AiAgentSkill,
  type AiOwner,
} from '@kermanych/cloud';
import { api } from '../../lib/api';
import { useAuth } from 'stores/auth';
import { useProjects } from 'stores/projects';
import { ownerLibraryView } from '../../lib/ai-team';
import KField from 'components/kit/KField.vue';
import SkillSequence, { measureSkillBytes } from './SkillSequence.vue';
import AiProvenance from './AiProvenance.vue';

const props = defineProps<{ owner: AiOwner; ownerName: string }>();

const auth = useAuth();
const projects = useProjects();
const { t } = useI18n();

const view = ref<SkillView[]>([]);
const bodyBytes = ref<Record<string, number>>({});
// The names the bound checkout's own skill directories define, keyed to the file that owns each.
// Handed to the sequence editor so it can tell a dangling name from a repository one.
const repo = ref<Record<string, string>>({});
const overrides = ref<AiAgent[]>([]);
// Each agent's sequence, by agent id, in delivery order. Kept as plain name lists because that
// is what `setAgentSkills` takes and what the editor emits — positions are the array's indices
// and never a stored field on this side.
const sequences = ref<Record<string, string[]>>({});
// What is in each editor, and what «unchanged» means for it. `baseline` is the effective text as
// of the last read: the override when there is one, the compile-time default otherwise.
const drafts = ref<Record<string, string>>({});
const baseline = ref<Record<string, string>>({});
// Per-row, because a refused save belongs to the agent whose button was pressed: one shared line
// would blame all four. The pane-level `error` below is for the reads and for a refused sequence
// write, which has no field of its own to sit under.
const rowError = ref<Record<string, string>>({});
const savedRow = ref<Record<string, boolean>>({});

const error = ref('');
const loaded = ref(false);
// One flag for every write on the pane: a second click while an upsert is in flight would race
// the read that follows it.
const busy = ref(false);

const canWrite = computed(() =>
  props.owner.scope === 'user'
    ? true
    : props.owner.scope === 'workspace'
      ? projects.isWorkspaceOwner(props.owner.id)
      : projects.isOwner(props.owner.id),
);

function hasOverride(agentId: string): boolean {
  return overrides.value.some((o) => o.agentId === agentId);
}

// The stored override row for an agent, or undefined when it runs the compile-time default —
// which is also when there is no author to show.
function overrideOf(agentId: string): AiAgent | undefined {
  return overrides.value.find((o) => o.agentId === agentId);
}

function dirty(agentId: string): boolean {
  const draft = drafts.value[agentId];
  return draft !== undefined && draft !== baseline.value[agentId];
}

function onEdit(agentId: string, value: string): void {
  drafts.value = { ...drafts.value, [agentId]: value };
  // Both notices belong to the text as it was when they were shown; a keystroke makes either a
  // statement about a different draft.
  if (rowError.value[agentId]) rowError.value = { ...rowError.value, [agentId]: '' };
  if (savedRow.value[agentId]) savedRow.value = { ...savedRow.value, [agentId]: false };
}

function cancelEdit(agentId: string): void {
  drafts.value = { ...drafts.value, [agentId]: baseline.value[agentId] ?? '' };
  rowError.value = { ...rowError.value, [agentId]: '' };
  savedRow.value = { ...savedRow.value, [agentId]: false };
}

// The operator's own order, with the name as the tiebreak — the exact comparator
// SkillsService.assignedFor sorts by, so what this pane shows is what the launch pastes.
function toSequences(rows: readonly AiAgentSkill[]): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const agent of AGENTS) {
    if (!agent.instruction) continue;
    out[agent.id] = rows
      .filter((r) => r.agentId === agent.id)
      .sort((a, b) => a.position - b.position || a.skillName.localeCompare(b.skillName))
      .map((r) => r.skillName);
  }
  return out;
}

// Re-seeds the editors from the freshly read overrides — and leaves alone any draft the operator
// has changed and not saved. The pane holds four editors at once: a reload triggered by SAVING
// one of them, or by reordering a sequence, must not throw away typing in another. A draft that
// is clean is simply replaced, so an override written elsewhere still lands on screen.
//
// `effectiveInstruction` is the seed, not the stored text, and that matters for a row that got
// into the database broken — an older UI, a hand-written insert: the launcher falls back to the
// default for it, so the box shows the default too. The pane and the runtime then agree, and
// «Повернути дефолт» is what clears the dead row.
function seed(): void {
  const nextDrafts: Record<string, string> = {};
  const nextBaseline: Record<string, string> = {};
  for (const agent of AGENTS) {
    if (!agent.instruction) continue;
    const stored = overrides.value.find((o) => o.agentId === agent.id)?.instruction;
    const base = effectiveInstruction(agent, stored) ?? '';
    nextBaseline[agent.id] = base;
    const draft = drafts.value[agent.id];
    // Compared against the OLD baseline: that is what «the operator changed it» means, and this
    // runs after `overrides` has already moved on.
    nextDrafts[agent.id] = draft !== undefined && draft !== baseline.value[agent.id] ? draft : base;
  }
  drafts.value = nextDrafts;
  baseline.value = nextBaseline;
}

// The resolved library view for this owner. Only a project has a checkout, so only it can be
// shadowed by repo files and only it has the api endpoint that sees them; every other scope
// resolves the view from its own cloud rows, with no repo shadow.
async function libraryView(owner: AiOwner): Promise<{ view: SkillView[]; repo: Record<string, string> }> {
  if (owner.scope === 'project') return await api.projectSkills(owner.id);
  return { view: ownerLibraryView(await listAiSkills(auth.client, owner)), repo: {} };
}

async function load(): Promise<void> {
  // Pinned for the whole read: the prop is live (see the watcher), so two loads can overlap and a
  // late one must not paint another project's team.
  const ownerKey = props.owner.scope + ':' + props.owner.id;
  error.value = '';
  try {
    const [library, stored, assignments, rows] = await Promise.all([
      libraryView(props.owner),
      listAiSkills(auth.client, props.owner),
      listAiAgentSkills(auth.client, props.owner),
      listAiAgents(auth.client, props.owner),
    ]);
    if (ownerKey !== props.owner.scope + ':' + props.owner.id) return;
    view.value = library.view;
    repo.value = library.repo;
    bodyBytes.value = measureSkillBytes(library.view, stored);
    sequences.value = toSequences(assignments);
    overrides.value = rows;
    seed();
    loaded.value = true;
  } catch (e) {
    if (ownerKey !== props.owner.scope + ':' + props.owner.id) return;
    // Everything, not just the failed half: a pane built from three of four reads would show the
    // harness defaults as this project's texts, or mark every assigned name broken. `loaded` goes
    // back to false with it — that, and not the emptiness of the data, is what takes the list off
    // screen, and with it every button that could write one of those wrong texts back.
    view.value = [];
    repo.value = {};
    bodyBytes.value = {};
    sequences.value = {};
    overrides.value = [];
    drafts.value = {};
    baseline.value = {};
    loaded.value = false;
    error.value = e instanceof Error ? e.message : String(e);
  }
}

// `projectId` is a LIVE prop: SettingsPage renders its panes with no `:key` and the sidebar only
// moves the selection, so picking another project swaps the prop under a component that stays
// mounted. Every draft is dropped with it — an instruction typed for one project must not be
// savable into the next one, which is exactly what preserving dirty drafts here would allow.
watch(
  () => props.owner.scope + ':' + props.owner.id,
  () => {
    view.value = [];
    repo.value = {};
    bodyBytes.value = {};
    sequences.value = {};
    overrides.value = [];
    drafts.value = {};
    baseline.value = {};
    rowError.value = {};
    savedRow.value = {};
    loaded.value = false;
    void load();
  },
  { immediate: true },
);

// The three ways an edited template can be wrong, refused HERE rather than written: a blank text
// leaves the agent with no instruction at all, a dropped hole means the runtime's variable never
// reaches the model, and an invented hole makes `renderInstruction` throw at launch — where the
// operator is not looking and the agent simply never starts.
function validate(def: AgentDef, text: string): string {
  if (!text.trim()) return t('settings.aiAgents.errEmpty');
  const { missing, unknown } = instructionErrors(def, text);
  if (missing.length) return t('settings.aiAgents.errMissing', { holes: missing.join(', ') });
  if (unknown.length) return t('settings.aiAgents.errUnknown', { holes: unknown.join(', ') });
  return '';
}

async function saveInstruction(def: AgentDef): Promise<void> {
  // Pinned like every write on this pane: the row belongs to the project the operator was looking
  // at when the button went down.
  const ownerKey = props.owner.scope + ':' + props.owner.id;
  const text = drafts.value[def.id] ?? '';
  savedRow.value = { ...savedRow.value, [def.id]: false };
  const bad = validate(def, text);
  rowError.value = { ...rowError.value, [def.id]: bad };
  if (bad) return;
  busy.value = true;
  try {
    // Byte-for-byte the harness default: the honest way to store «no change» is no row. Keeping
    // one would freeze this project on today's wording of a text that is maintained in the
    // harness, and the «своя інструкція» badge would claim an edit nobody made.
    if (text === def.instruction) {
      if (hasOverride(def.id)) await deleteAiAgent(auth.client, props.owner, def.id);
    } else {
      await upsertAiAgent(auth.client, { owner: props.owner, agentId: def.id, instruction: text });
    }
    if (ownerKey !== props.owner.scope + ':' + props.owner.id) return;
    // Dropped so the re-read owns this editor again: `seed` preserves a dirty draft, and after a
    // successful write the stored text — not the string this function happened to send — is what
    // the box must show.
    forget(def.id);
    savedRow.value = { ...savedRow.value, [def.id]: true };
    await load();
  } catch (e) {
    if (ownerKey !== props.owner.scope + ':' + props.owner.id) return;
    rowError.value = { ...rowError.value, [def.id]: e instanceof Error ? e.message : String(e) };
  } finally {
    busy.value = false;
  }
}

// Reset IS the delete: with no row the effective instruction falls back to the compile-time
// default, so there is nothing to write. `deleteProjectAgent` throws when it matched nothing — an
// RLS refusal reads identically to success on a DELETE otherwise — and nothing is changed
// locally: the reload is what the screen reflects.
async function resetToDefault(agentId: string): Promise<void> {
  const ownerKey = props.owner.scope + ':' + props.owner.id;
  rowError.value = { ...rowError.value, [agentId]: '' };
  savedRow.value = { ...savedRow.value, [agentId]: false };
  busy.value = true;
  try {
    await deleteAiAgent(auth.client, props.owner, agentId);
    if (ownerKey !== props.owner.scope + ':' + props.owner.id) return;
    // Unconditionally, unlike a save: the operator's text is what they just asked to throw away,
    // so it must not survive the reload as a preserved dirty draft.
    forget(agentId);
    await load();
  } catch (e) {
    if (ownerKey !== props.owner.scope + ':' + props.owner.id) return;
    rowError.value = { ...rowError.value, [agentId]: e instanceof Error ? e.message : String(e) };
  } finally {
    busy.value = false;
  }
}

function forget(agentId: string): void {
  const nextDrafts = { ...drafts.value };
  delete nextDrafts[agentId];
  drafts.value = nextDrafts;
  const nextBaseline = { ...baseline.value };
  delete nextBaseline[agentId];
  baseline.value = nextBaseline;
}

// `setAgentSkills` is a replace-all of exactly this list, so on success the local state IS what
// the cloud holds and there is nothing a re-read would add. Deliberately not a reload: this pane
// keeps four instruction editors open, and re-reading on every reorder would be four chances to
// disturb them for no new information. A failure changes nothing locally — the sequence on screen
// is still the one in the cloud — and says so on the pane's error line.
async function setSequence(agentId: string, names: string[]): Promise<void> {
  const ownerKey = props.owner.scope + ':' + props.owner.id;
  error.value = '';
  busy.value = true;
  try {
    await setAiAgentSkills(auth.client, props.owner, agentId, names);
    if (ownerKey !== props.owner.scope + ':' + props.owner.id) return;
    sequences.value = { ...sequences.value, [agentId]: names };
  } catch (e) {
    if (ownerKey !== props.owner.scope + ':' + props.owner.id) return;
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    busy.value = false;
  }
}
</script>

<style scoped lang="scss">
.ai__lead { font-size: 13px; color: var(--k-muted); margin-bottom: 12px; }
.ai__lead-project { color: var(--k-text); }
.ai__caption { margin: 12px 0 4px; font-size: 11.5px; color: var(--k-muted); }
/* `pre-wrap` and `--k-surface2`, the treatment every verbatim block on this screen gets: text a
   model receives, shown exactly as it receives it. A horizontal scrollbar would hide the
   right-hand half of every long line. */
.ai__header {
  margin: 0 0 16px;
  padding: 8px 10px;
  font-size: 11.5px;
  line-height: 1.5;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  background: var(--k-surface2);
  border-radius: var(--k-r);
}
.ai__readonly { margin: 0 0 12px; font-size: 12px; color: var(--k-muted); }
.ai__list { list-style: none; margin: 0; padding: 0; display: grid; gap: 10px; }
.ai__row { padding: 10px 12px; background: var(--k-surface); border: 1px solid var(--k-line); border-radius: var(--k-r); }
/* An agent with no instruction is not a broken row: dashed border marks it as a member of the
   team that simply has no text to carry, rather than one whose text failed to load. */
.ai__row--bare { border-style: dashed; background: transparent; }
.ai__head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.ai__name { font-size: 12.5px; }
.ai__id { font-size: 11px; color: var(--k-faint); }
.ai__badge { font-size: 10.5px; padding: 1px 6px; border: 1px solid var(--k-line-strong); border-radius: var(--k-r); color: var(--k-muted); white-space: nowrap; }
/* Agent kinds, matching the vocabulary the whole «ШІ-команда» group uses: accent for its own
   session, plain for a message into a running one, dashed for the two with no model at all. */
.ai__badge--session { color: var(--k-accent); border-color: var(--k-accent); }
.ai__badge--procedure { color: var(--k-text); }
.ai__badge--automation { border-style: dashed; }
/* The project's own text — the same accent the library pane gives a «проєкт» skill, because it is
   the same fact about the same kind of row. */
.ai__badge--own { color: var(--k-accent); border-color: var(--k-accent); }
.ai__note { margin: 8px 0 0; font-size: 12px; color: var(--k-muted); }
.ai__hint { margin: 6px 0 0; font-size: 11px; color: var(--k-muted); }
.ai__actions { display: flex; align-items: center; gap: 6px; margin-top: 8px; }
/* «Повернути дефолт» is not a sibling of Save/Cancel: it discards the stored row rather than the
   current edit, so it sits against the right edge, away from the pair. */
.ai__btn--reset { margin-left: auto; }
.ai__btn { font: inherit; font-size: 12px; padding: 3px 10px; background: transparent; color: var(--k-text); border: 1px solid var(--k-line-strong); border-radius: var(--k-r); cursor: pointer; }
.ai__btn:disabled { opacity: 0.45; cursor: default; }
.ai__btn--primary { border-color: var(--k-accent); color: var(--k-accent); }
.ai__error { margin: 6px 0 0; font-size: 11.5px; color: var(--k-accent); overflow-wrap: anywhere; }
/* Muted, not accent: a save that worked is a receipt, not something to look at. */
.ai__saved { margin: 6px 0 0; font-size: 11.5px; color: var(--k-muted); }
</style>
