<template>
  <section class="tg">
    <!-- Deliberately NOT a restatement of the pane blurb sixty pixels above it: that line
         already says «без рішення моделі», so this one earns its place by drawing the
         distinction the operator actually has to hold — library versus trigger. -->
    <i18n-t keypath="settings.triggers.lead" tag="p" class="tg__lead">
      <template #project><span class="tg__lead-project mono">{{ projectName }}</span></template>
    </i18n-t>

    <!-- The two halves are not interchangeable and the operator picks between them in the
         source field, so the difference is stated before they get there. -->
    <ol class="tg__how">
      <li>
        <span class="mono">{{ translate('settings.triggers.howOperatorTerm') }}</span> {{ translate('settings.triggers.howOperator') }}
      </li>
      <li>{{ translate('settings.triggers.howRest') }}</li>
    </ol>

    <p v-if="error" class="tg__error mono">{{ error }}</p>

    <!-- Gated on the read having SUCCEEDED, not on the list being empty: «тригерів немає» after
         a failed read is a claim about the project this pane could not read, and it is the
         claim that would keep an operator from looking for the trigger that did fire. A refused
         WRITE leaves the list up — the error line says what was refused, and every row on
         screen is still true. -->
    <template v-if="loaded">
      <ul v-if="triggers.length" class="tg__list">
        <li
          v-for="t in triggers"
          :key="t.id"
          class="tg__row"
          :class="{ 'tg__row--off': !t.enabled }"
        >
          <div class="tg__head">
            <span class="tg__name">{{ t.label }}</span>
            <span class="tg__id mono">{{ t.id }}</span>
            <span class="tg__badge">{{ sourceLabel(t.source) }}</span>
            <!-- Only the deliberate choices are badged, and only where they are consumed. The
                 defaults — soft, once — are the ordinary case and a badge on every row would say
                 nothing; a stored `interrupt` on an OPERATOR row says nothing either, because
                 nothing reads it. -->
            <template v-if="triggerUsesRuleFile(t.source)">
              <span v-if="t.mode === 'interrupt'" class="tg__badge tg__badge--hard">{{ translate('settings.triggers.badgeInterrupt') }}</span>
              <span v-if="t.repeat === 'after-gap'" class="tg__badge">{{ translate('settings.triggers.badgeRepeat') }}</span>
            </template>
          </div>

          <p class="tg__pattern mono">{{ t.pattern }}</p>
          <p v-if="t.pathGlobs.length" class="tg__globs mono">{{ t.pathGlobs.join(', ') }}</p>

          <p class="tg__does">
            <template v-if="t.action === 'agent'">
              {{ translate('settings.triggers.doesAgent') }} <span class="mono">{{ agentLabel(t.agentId) }}</span>
            </template>
            <template v-else>
              {{ translate('settings.triggers.doesPrompt') }}
              <!-- The sequence itself, in delivery order: a count alone would leave the operator
                   opening the editor to find out WHICH skills a trigger carries, and the names are
                   the only part of a prompt trigger the list cannot otherwise show. -->
              <span v-if="t.skills.length" class="mono">· {{ t.skills.join(', ') }}</span>
            </template>
          </p>
          <!-- The same dangling reference the runtime reports as an error notice mid-session,
               shown here where it can actually be fixed. Only the agent case survives the move to
               sequences: a skill name that resolves to nothing is shown, and removable, inside
               the editor's sequence list — this row would have nowhere to act on it. -->
          <p v-if="danglingAgent(t)" class="tg__warn">{{ danglingAgent(t) }}</p>

          <div class="tg__actions">
            <KCheckbox
              :model-value="t.enabled"
              :label="translate('settings.triggers.enabledLabel')"
              :disabled="!canWrite || busy"
              @update:model-value="toggle(t)"
            />
            <button type="button" class="tg__btn" :disabled="!canWrite || busy" @click="edit(t)">
              {{ translate('settings.triggers.edit') }}
            </button>
            <button type="button" class="tg__btn" :disabled="!canWrite || busy" @click="drop(t.id)">
              {{ translate('settings.triggers.delete') }}
            </button>
          </div>
        </li>
      </ul>
      <p v-else class="tg__empty mono">{{ translate('settings.triggers.empty') }}</p>

      <!-- Only with the list on screen: a trigger is saved with an upsert on (проєкт, id), so
           creating one against a list that failed to load could silently overwrite a trigger
           the operator cannot see. -->
      <button type="button" class="tg__btn tg__btn--primary" :disabled="!canWrite || busy" @click="create">
        {{ translate('settings.triggers.add') }}
      </button>
    </template>

    <KModal
      v-model="editorOpen"
      :title="editing ? translate('settings.triggers.editTitle', { id: draft.id }) : translate('settings.triggers.newTitle')"
      width="560px"
    >
      <div class="tg__form">
        <!-- The id names the rule file the session loads (`rules/<id>.md`), so it is fixed
             once the row exists: renaming would leave the old rule behind and write a second. -->
        <KField
          v-model="draft.id"
          :label="translate('settings.triggers.idLabel')"
          :disabled="editing"
          placeholder="env-guard"
        />
        <KField v-model="draft.label" :label="translate('settings.triggers.nameLabel')" :placeholder="translate('settings.triggers.namePlaceholder')" />
        <p class="tg__note">{{ translate('settings.triggers.nameNote') }}</p>

        <KSelect
          :model-value="draft.source"
          :label="translate('settings.triggers.sourceLabel')"
          :options="sourceOptions"
          @update:model-value="onSource"
        />

        <KField v-model="draft.pattern" :label="translate('settings.triggers.patternLabel')" :placeholder="translate('settings.triggers.patternPlaceholder')" />
        <i18n-t keypath="settings.triggers.patternNote" tag="p" class="tg__note">
          <template #env><span class="mono">env</span></template>
          <template #dotenv><span class="mono">.env</span></template>
          <template #environment><span class="mono">environment</span></template>
          <template #envoy><span class="mono">Envoy</span></template>
        </i18n-t>

        <!-- The test field. An unparseable pattern is invisible at launch — Керманич skips past
             it and omp simply never fires the rule — so this line is the only place it is ever
             seen. It renders as soon as there is a pattern, with or without a sample. -->
        <KField
          v-model="sample"
          :label="translate('settings.triggers.sampleLabel')"
          multiline
          :rows="2"
          :placeholder="translate('settings.triggers.samplePlaceholder')"
        />
        <p v-if="patternError" class="tg__error mono">{{ translate('settings.triggers.patternBroken', { error: patternError }) }}</p>
        <p v-else-if="matched === true" class="tg__hit">{{ translate('settings.triggers.matchHit') }}</p>
        <p v-else-if="matched === false" class="tg__miss">{{ translate('settings.triggers.matchMiss') }}</p>
        <p class="tg__note">
          <template v-if="draft.source === 'operator'">{{ translate('settings.triggers.caseNoteOperator') }}</template>
          <template v-else>{{ translate('settings.triggers.caseNoteRule') }}</template>
        </p>

        <!-- Globs scope a rule to the files a tool touched, so they have nothing to scope on any
             other source. Cleared on the way out (see the source watcher) rather than merely
             hidden: a value the operator can no longer see must not keep being written. -->
        <template v-if="draft.source === 'tool'">
          <KField
            v-model="globs"
            :label="translate('settings.triggers.globsLabel')"
            placeholder="apps/api/**, packages/**"
          />
        </template>

        <KSelect
          :model-value="draft.action"
          :label="translate('settings.triggers.actionLabel')"
          :options="actionOptions"
          @update:model-value="onAction"
        />
        <KSelect
          v-if="draft.action === 'agent'"
          v-model="draft.agentId"
          :label="translate('settings.triggers.agentLabelField')"
          :options="agentOptions"
          :placeholder="translate('settings.triggers.agentPlaceholder')"
        />
        <!-- A prompt trigger carries BOTH halves and needs neither: the instruction is free text
             the runtime injects verbatim, the sequence is library skills pasted under it in this
             order, and the two are joined into one body (SkillsService.materializeTriggers /
             SupervisorService.matchOperatorTriggers). Either alone is a complete trigger; both
             empty is nothing at all, which is what `errNoBody` refuses. -->
        <template v-else>
          <KField
            v-model="draft.instruction"
            :label="translate('settings.triggers.instructionLabel')"
            multiline
            :rows="4"
          />
          <p class="tg__note">{{ translate('settings.triggers.instructionNote') }}</p>

          <p class="tg__caption">{{ translate('settings.triggers.skillsLabel') }}</p>
          <SkillSequence
            :names="draft.skills"
            :view="view"
            :body-bytes="bodyBytes"
            :repo="repo"
            :disabled="saving"
            @update:names="draft.skills = $event"
          />
          <!-- The library read fails on its own terms — the local api is down, the project is
               unbound — and costs only the picker, so its message sits with the picker. -->
          <p v-if="libraryError" class="tg__error mono">{{ libraryError }}</p>
        </template>

        <!-- `mode` and `repeat` exist ONLY in the TTSR rule file, and an operator trigger has
             none: Kermanych matches it before the message is forwarded, so there is no turn to
             abort, and matchOperatorTriggers checks every message rather than counting firings.
             Rendering the hard-mode warning here would promise an abort the runtime cannot
             perform — the same contradiction a broken pattern at launch is. -->
        <template v-if="triggerUsesRuleFile(draft.source)">
          <KSelect v-model="draft.mode" :label="translate('settings.triggers.modeLabel')" :options="MODE_OPTIONS" />
          <p v-if="draft.mode === 'interrupt'" class="tg__warn">{{ translate('settings.triggers.hardWarn') }}</p>
          <KSelect v-model="draft.repeat" :label="translate('settings.triggers.repeatLabel')" :options="REPEAT_OPTIONS" />
        </template>
        <!-- Said rather than silently omitted: two controls that vanish without explanation read
             as a rendering fault, and the reason is a fact about the trigger worth knowing. -->
        <p v-else class="tg__note">{{ translate('settings.triggers.modeRepeatNote') }}</p>

        <p v-if="formError" class="tg__error mono">{{ formError }}</p>
      </div>
      <template #controls>
        <button type="button" class="tg__btn" @click="editorOpen = false">{{ translate('settings.modal.cancel') }}</button>
        <!-- `canWrite` here as well as on every list action: the modal must not be the one
             surface where a non-owner's write reaches postgrest only to be refused there. -->
        <button
          type="button"
          class="tg__btn tg__btn--primary"
          :disabled="saving || !canWrite"
          @click="save"
        >{{ translate('settings.triggers.save') }}</button>
      </template>
    </KModal>
  </section>
</template>

<script setup lang="ts">
// The trigger list: the content that fires without the model choosing to. Same split as the
// two panes before it — the rows are cloud rows written straight to Supabase, where RLS makes
// them owner-only, while the RESOLVED skill view comes from the local API, which is the only
// party that can see whether the bound checkout shadows a name.
//
// The two reads are NOT merged, and that is deliberate: the list is the cloud rows alone, while
// the library only fills the editor's skill sequence — so losing the library costs the sequence
// editor and leaves every trigger on screen exactly as true as it was.
import { computed, reactive, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { AGENTS, SKILL_NAME_RE, type SkillView } from '@kermanych/core';
import {
  deleteTrigger,
  listProjectSkills,
  listTriggers,
  setTriggerSkills,
  upsertTrigger,
  type ProjectTrigger,
} from '@kermanych/cloud';
import { api } from '../../lib/api';
import { useAuth } from 'stores/auth';
import { useProjects } from 'stores/projects';
import KModal from 'components/kit/KModal.vue';
import KField from 'components/kit/KField.vue';
import KSelect from 'components/kit/KSelect.vue';
import KCheckbox from 'components/kit/KCheckbox.vue';
import SkillSequence, { measureSkillBytes } from './SkillSequence.vue';
import {
  triggerActionOptions,
  triggerAgentOptions,
  triggerMatches,
  triggerSourceLabelKey,
  triggerUsesRuleFile,
  TRIGGER_SOURCE_OPTIONS,
} from '../../lib/settings';

const props = defineProps<{ projectId: string; projectName: string }>();

const auth = useAuth();
const projects = useProjects();
const { t: translate } = useI18n();

// `remind` first and `once` first: the defaults a new trigger opens on, and the ones a native
// select would land on anyway. The hard mode discards a partial answer, so it is a choice the
// operator has to reach for rather than one they can fall into.
const MODE_OPTIONS = computed(() => [
  { value: 'remind', label: translate('settings.triggers.modeSoft') },
  { value: 'interrupt', label: translate('settings.triggers.modeHard') },
]);
const REPEAT_OPTIONS = computed(() => [
  { value: 'once', label: translate('settings.triggers.repeatOnce') },
  { value: 'after-gap', label: translate('settings.triggers.repeatGap') },
]);

const triggers = ref<ProjectTrigger[]>([]);
const view = ref<SkillView[]>([]);
// The names the bound checkout's own skill directories define, keyed to the file that owns
// each. Never offered in the sequence editor — they are not this project's library — but a name
// in here does resolve at launch, so the editor needs it to tell a dangling name from a repo one.
const repo = ref<Record<string, string>>({});
// What each library name costs a trigger that carries it, keyed by name. Read together with the
// library view (see `load`): both come from the same pair of reads, and neither is any use to the
// sequence editor without the other.
const bodyBytes = ref<Record<string, number>>({});
// `error` carries the trigger read AND every refused write: both are one line of the same
// postgrest message. `loaded` is what separates them for the list — a failed read has nothing
// trustworthy to show, a refused write leaves the rows it was refused on standing.
const error = ref('');
const loaded = ref(false);
// The library read fails on its own terms (the local api is down, the project is unbound) and
// costs only the editor's skill sequence, so it gets its own line there.
const libraryError = ref('');
const busy = ref(false);
const editorOpen = ref(false);
const editing = ref(false);
const saving = ref(false);
const formError = ref('');
// Editor-only, never stored: the sample the operator pastes to see whether the pattern bites.
const sample = ref('');
// The globs field is a plain line the operator types; `path_globs` is an array. Kept as text
// while editing so a half-typed «apps/, » is not repeatedly re-split under the cursor.
const globs = ref('');

const canWrite = computed(() => projects.isOwner(props.projectId));

// `mode` → remind and `repeat` → once are the defaults in three places at once — here, the
// column defaults in the migration, and renderRuleFile's mapping to interruptMode/repeatMode.
// A new trigger is a soft reminder until someone says otherwise.
function blankDraft(): Omit<ProjectTrigger, 'projectId' | 'pathGlobs'> {
  return {
    id: '',
    label: '',
    enabled: true,
    source: 'operator',
    pattern: '',
    // `prompt` is the action every source can carry, so it is the one a new trigger opens on;
    // `agent` is reachable from an operator trigger alone.
    action: 'prompt',
    instruction: '',
    agentId: '',
    skills: [],
    mode: 'remind',
    repeat: 'once',
  };
}
const draft = reactive(blankDraft());

const actionOptions = computed(() => triggerActionOptions(draft.source).map((o) => ({ value: o.value, label: translate(o.labelKey) })));
// A stored source may predate the DB union; a known one resolves through the catalog, an
// unknown legacy value shows itself rather than a blank cell.
const sourceOptions = computed(() => TRIGGER_SOURCE_OPTIONS.map((o) => ({ value: o.value, label: translate(o.labelKey) })));
function sourceLabel(source: string): string {
  const key = triggerSourceLabelKey(source);
  return key ? translate(key) : source;
}
const agentOptions = computed(() =>
  triggerAgentOptions(AGENTS).map((o) => ({ value: o.value, label: translate(o.labelKey) })),
);

// One evaluation for both lines below: an uncompilable pattern reports its message, anything
// else reports the match. The sample is only consulted for the match — the compile error must
// show the moment the pattern is broken, whether or not there is anything to test it against.
const tested = computed<boolean | string | undefined>(() =>
  draft.pattern ? triggerMatches(draft.pattern, sample.value, draft.source) : undefined,
);
const patternError = computed(() => (typeof tested.value === 'string' ? tested.value : ''));
const matched = computed(() =>
  typeof tested.value === 'boolean' && sample.value.trim() ? tested.value : undefined,
);

// Resolved against the RUNNABLE agents, not the whole registry. `finish` and `summary` are in
// `AGENTS` and have labels, so the full registry would render «запускає Завершити» directly
// above the line saying Kermanych cannot start it — two claims about one row, the friendlier
// of them false. An unrunnable target keeps its raw id, which is what the warning names too.
function agentLabel(id: string): string {
  const key = triggerAgentOptions(AGENTS).find((o) => o.value === id)?.labelKey;
  return key ? translate(key) : id;
}

// The one reference in a trigger that can dangle where only this pane can see it: an agent id.
// The runtime reports it mid-session as an error notice «агента … не існує», and this is the
// surface where it can be fixed instead of merely observed.
//
// A prompt trigger's skill names are NOT checked here: they live in the editor's sequence, which
// badges an unresolvable name and offers the control that removes it. A warning on the row would
// name a problem the row cannot act on.
function danglingAgent(t: ProjectTrigger): string {
  if (t.action !== 'agent') return '';
  if (triggerAgentOptions(AGENTS).some((o) => o.value === t.agentId)) return '';
  return translate('settings.triggers.danglingAgent', { target: t.agentId });
}

async function load(): Promise<void> {
  // Pinned for the whole read: the prop is live (see the watcher), so two loads can overlap and
  // a late one must not paint another project's triggers.
  const projectId = props.projectId;
  error.value = '';
  libraryError.value = '';
  const [rows, library] = await Promise.allSettled([
    listTriggers(auth.client, [projectId]),
    // One outcome for both, because neither half is any use alone: the resolved view is what the
    // sequence editor offers and badges, the stored rows are the only place its byte figures can
    // come from. Splitting them would leave the editor listing names it could not price.
    Promise.all([api.projectSkills(projectId), listProjectSkills(auth.client, [projectId])]),
  ]);
  if (projectId !== props.projectId) return;
  if (rows.status === 'fulfilled') {
    triggers.value = rows.value;
    loaded.value = true;
  } else {
    triggers.value = [];
    loaded.value = false;
    error.value = rows.reason instanceof Error ? rows.reason.message : String(rows.reason);
  }
  if (library.status === 'fulfilled') {
    const [resolved, stored] = library.value;
    view.value = resolved.view;
    repo.value = resolved.repo;
    bodyBytes.value = measureSkillBytes(resolved.view, stored);
  } else {
    view.value = [];
    repo.value = {};
    bodyBytes.value = {};
    libraryError.value =
      library.reason instanceof Error ? library.reason.message : String(library.reason);
  }
}

// `projectId` is a LIVE prop: SettingsPage renders its panes with no `:key` and the sidebar
// only moves the selection, so picking another project swaps the prop under a component that
// stays mounted. The editor is shut synchronously with it — a draft left open across the
// switch would save into a project it was never opened for.
watch(
  () => props.projectId,
  () => {
    editorOpen.value = false;
    resetDraft();
    triggers.value = [];
    view.value = [];
    repo.value = {};
    bodyBytes.value = {};
    loaded.value = false;
    void load();
  },
  { immediate: true },
);

// CHANGING the source or the action drops what no longer applies. Handlers on the selects, NOT
// watchers on the values, and that distinction is the whole fix: a watcher fires on the value
// however it moved, and `flush: 'pre'` means it fires on the NEXT flush — so `edit()`, which
// assigns `action` and then the action's own fields in one synchronous `Object.assign`, had them
// wiped afterwards by a watcher that could not tell a prefill from a keystroke. Every
// operator→agent trigger opened for editing rendered an empty agent picker.
//
// A guard flag around the prefill would have suppressed the symptom; moving the reset onto the
// gesture removes the class. «The operator picked another action, so the old target is stale» is
// a statement about a CLICK, and it is now written where the click arrives — with no scheduling
// left to reason about, and no second path into these fields to forget next time.
//
// Both handlers narrow through the option list they are rendered from, so the draft cannot hold
// an action the source does not permit even if a `<select>` were driven from outside.
function onSource(value: string): void {
  const source = TRIGGER_SOURCE_OPTIONS.find((o) => o.value === value)?.value;
  if (!source) return;
  draft.source = source;
  // `agent` is only reachable from `operator`, and the DB carries the same rule as a check
  // constraint: keeping it would offer a choice the option list no longer contains and a save
  // postgrest would refuse.
  if (source !== 'operator' && draft.action === 'agent') {
    draft.action = 'prompt';
    draft.agentId = '';
  }
  // Globs scope the files a tool touched; nothing else has a path to scope on.
  if (source !== 'tool') globs.value = '';
}

// The two actions share no field: an agent id is not an instruction and not a sequence, so
// keeping either across the switch would leave the editor holding a body the new action never
// delivers — and `save` would write it.
function onAction(value: string): void {
  const action = triggerActionOptions(draft.source).find((o) => o.value === value)?.value;
  if (!action) return;
  draft.action = action;
  if (action === 'agent') {
    draft.instruction = '';
    draft.skills = [];
  } else {
    draft.agentId = '';
  }
}

function resetDraft(): void {
  Object.assign(draft, blankDraft());
  editing.value = false;
  formError.value = '';
  sample.value = '';
  globs.value = '';
}
watch(editorOpen, (open) => {
  if (!open) resetDraft();
});

function create(): void {
  resetDraft();
  editorOpen.value = true;
}

// Everything the editor needs is already in the row this pane read, so opening one is
// synchronous — there is no second fetch that could land in someone else's draft.
function edit(t: ProjectTrigger): void {
  resetDraft();
  editing.value = true;
  Object.assign(draft, {
    id: t.id,
    label: t.label,
    enabled: t.enabled,
    source: t.source,
    pattern: t.pattern,
    action: t.action,
    instruction: t.instruction,
    agentId: t.agentId,
    // Copied, never aliased: the editor mutates this array on every reorder, and the row it came
    // from is what the list behind the modal still renders — «Скасувати» has to leave it alone.
    skills: [...t.skills],
    mode: t.mode,
    repeat: t.repeat,
  });
  globs.value = t.pathGlobs.join(', ');
  editorOpen.value = true;
}

async function save(): Promise<void> {
  // Pinned like every write on this pane: the row belongs to the project the operator was
  // looking at when the button went down.
  const projectId = props.projectId;
  formError.value = '';
  if (!SKILL_NAME_RE.test(draft.id)) {
    formError.value = translate('settings.triggers.errId');
    return;
  }
  if (!draft.label.trim()) {
    formError.value = translate('settings.triggers.errNoLabel');
    return;
  }
  if (!draft.pattern.trim()) {
    formError.value = translate('settings.triggers.errNoPattern');
    return;
  }
  // The one check the runtime cannot make for the operator: a pattern that does not compile is
  // skipped in silence at launch, so it must not be savable from here.
  if (patternError.value) {
    // Points at the line that already carries the message rather than repeating it: the two
    // sit two hundred pixels apart in the same modal, and the same sentence twice reads as two
    // separate problems.
    formError.value = translate('settings.triggers.errPatternBroken');
    return;
  }
  if (draft.action === 'agent' && !SKILL_NAME_RE.test(draft.agentId)) {
    formError.value = translate('settings.triggers.errPickAgent');
    return;
  }
  // A prompt trigger that delivers NOTHING. The runtime skips a blank body — materializeTriggers
  // writes no rule file for it, matchOperatorTriggers injects no notice — so such a row would sit
  // in the list looking like a live rule and fire in silence forever. Either half alone is enough:
  // an instruction with no skills is a reminder, skills with no instruction are the assigned block.
  if (draft.action === 'prompt' && !draft.instruction.trim() && draft.skills.length === 0) {
    formError.value = translate('settings.triggers.errNoBody');
    return;
  }
  saving.value = true;
  try {
    await upsertTrigger(auth.client, {
      projectId,
      id: draft.id,
      label: draft.label,
      // Carried through the editor rather than defaulted: `upsertTrigger` applies
      // `enabled ?? true`, so omitting it would silently switch a disabled trigger back on
      // the first time someone fixed a typo in its pattern.
      enabled: draft.enabled,
      source: draft.source,
      pattern: draft.pattern,
      pathGlobs: draft.source === 'tool' ? parseGlobs(globs.value) : [],
      action: draft.action,
      // Each action stores only its own half: a leftover instruction on an `agent` row would be
      // dead text in the database, and the check constraint refuses an agent id on a `prompt`.
      instruction: draft.action === 'prompt' ? draft.instruction : '',
      agentId: draft.action === 'agent' ? draft.agentId : '',
      mode: draft.mode,
      repeat: draft.repeat,
    });
    // The sequence is a second write — a different table — and it runs for BOTH actions: after a
    // switch to `agent` the rows the trigger used to carry must go, and `setTriggerSkills` with an
    // empty list is what removes them.
    //
    // NOT swallowed, and the modal stays open on failure: the row landed but its sequence did not,
    // so the operator has to know that the trigger will fire with the wrong body. Pressing
    // «Зберегти» again is safe — the row write is an upsert and the sequence write is a
    // replace-all, so a retry converges rather than duplicating anything.
    await setTriggerSkills(
      auth.client,
      projectId,
      draft.id,
      draft.action === 'prompt' ? [...draft.skills] : [],
    );
    if (projectId !== props.projectId) return;
    editorOpen.value = false;
    await load();
  } catch (e) {
    if (projectId !== props.projectId) return;
    formError.value = e instanceof Error ? e.message : String(e);
  } finally {
    saving.value = false;
  }
}

function parseGlobs(text: string): string[] {
  return text
    .split(/[,\n]/)
    .map((g) => g.trim())
    .filter(Boolean);
}

// The switch on the row. A disabled trigger keeps its row — it is still the operator's rule,
// and materializeTriggers simply stops writing a file for it — so this is an upsert of the
// same row with one bit flipped, never a delete.
async function toggle(t: ProjectTrigger): Promise<void> {
  const projectId = props.projectId;
  error.value = '';
  busy.value = true;
  try {
    await upsertTrigger(auth.client, { ...t, enabled: !t.enabled });
    if (projectId !== props.projectId) return;
    await load();
  } catch (e) {
    if (projectId !== props.projectId) return;
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    busy.value = false;
  }
}

// `deleteTrigger` throws when it removed nothing — an RLS refusal on a DELETE reports no error
// otherwise. Nothing is dropped locally: the reload is what the screen reflects.
async function drop(id: string): Promise<void> {
  const projectId = props.projectId;
  error.value = '';
  busy.value = true;
  try {
    await deleteTrigger(auth.client, projectId, id);
    if (projectId !== props.projectId) return;
    await load();
  } catch (e) {
    if (projectId !== props.projectId) return;
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    busy.value = false;
  }
}
</script>

<style scoped lang="scss">
.tg__lead { font-size: 13px; color: var(--k-muted); margin-bottom: 12px; }
.tg__lead-project { color: var(--k-text); }
/* Same treatment as the assignment board's four sentences: a short numbered procedure, not a
   paragraph of small print, because the operator has to act on the distinction it draws. */
.tg__how { margin: 0 0 12px; padding-left: 20px; font-size: 12.5px; line-height: 1.6; color: var(--k-muted); }
.tg__list { list-style: none; margin: 0 0 12px; padding: 0; display: grid; gap: 8px; }
.tg__row { padding: 10px 12px; background: var(--k-surface); border: 1px solid var(--k-line); border-radius: var(--k-r); }
/* A switched-off trigger: dashed and dimmed, the same vocabulary the library pane uses for a
   default a project turned off. The row is still the operator's rule — it just fires nothing. */
.tg__row--off { border-style: dashed; background: transparent; }
.tg__row--off .tg__name, .tg__row--off .tg__pattern, .tg__row--off .tg__does { color: var(--k-muted); }
.tg__head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.tg__name { font-size: 12.5px; }
.tg__id { font-size: 11px; color: var(--k-faint); }
.tg__badge { font-size: 10.5px; padding: 1px 6px; border: 1px solid var(--k-line-strong); border-radius: var(--k-r); color: var(--k-muted); white-space: nowrap; }
/* The one badge that is a warning: this mode throws away a partial answer. */
.tg__badge--hard { color: var(--k-danger); border-color: var(--k-danger); }
/* The pattern gets the verbatim treatment an instruction template gets in the catalogue: it is
   matched character for character, so it is shown character for character. */
.tg__pattern {
  margin: 6px 0 0;
  padding: 4px 8px;
  font-size: 11.5px;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  background: var(--k-surface2);
  border-radius: var(--k-r);
}
.tg__globs { margin: 4px 0 0; font-size: 11px; color: var(--k-muted); overflow-wrap: anywhere; }
.tg__does { margin: 6px 0 0; font-size: 12px; }
.tg__warn { margin: 6px 0 0; font-size: 11.5px; color: var(--k-danger); }
.tg__actions { display: flex; align-items: center; gap: 8px; margin-top: 8px; }
.tg__btn { font: inherit; font-size: 12px; padding: 3px 10px; background: transparent; color: var(--k-text); border: 1px solid var(--k-line-strong); border-radius: var(--k-r); cursor: pointer; }
.tg__btn:disabled { opacity: 0.45; cursor: default; }
.tg__btn--primary { border-color: var(--k-accent); color: var(--k-accent); }
/* «Видалити» and «Редагувати» sit against the right edge so they line up in one column
   whatever the checkbox label did, mirroring the board's «Прибрати». */
.tg__actions .tg__btn:nth-last-child(2) { margin-left: auto; }
.tg__empty { font-size: 12px; color: var(--k-muted); margin-bottom: 12px; }
.tg__error { font-size: 11.5px; color: var(--k-accent); overflow-wrap: anywhere; }
.tg__form { display: grid; gap: 12px; text-align: left; }
.tg__note { margin: -6px 0 0; font-size: 11.5px; line-height: 1.5; color: var(--k-muted); }
/* The sequence editor has no label of its own — it is a list, not a field — so the caption that
   names it matches a KField's label rather than the muted notes around it. */
.tg__caption { margin: -2px 0 -6px; font-size: 13px; color: var(--k-text); }
/* A hit and a miss are both ordinary answers, so only the hit takes the accent — it is the one
   that says «this would fire». Neither is an error; the error line above is. */
.tg__hit { margin: -6px 0 0; font-size: 11.5px; color: var(--k-accent); }
.tg__miss { margin: -6px 0 0; font-size: 11.5px; color: var(--k-muted); }
</style>
