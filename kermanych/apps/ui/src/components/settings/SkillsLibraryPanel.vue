<template>
  <section class="sk">
    <i18n-t keypath="settings.skillsLibrary.lead" tag="p" class="sk__lead">
      <template #project><span class="sk__lead-project mono">{{ ownerName }}</span></template>
    </i18n-t>
    <!-- The library is opt-in by the agent. Handing a skill to a role or a trigger
         unconditionally is what «Агенти» and «Тригери» are for, and the distinction is easy to
         miss from here. -->
    <p class="sk__lead">{{ t('settings.skillsLibrary.assignHint') }}</p>

    <p v-if="error" class="sk__error mono">{{ error }}</p>

    <!-- Skeleton cards until the first read for this owner lands, so the wait is not a blank
         pane — and never the empty-state line, which is only true once the read succeeded. -->
    <KSkeleton v-if="phase === 'skeleton'" variant="card" :rows="3" />
    <ul v-else-if="phase === 'ready' && rows.length" class="sk__list">
      <li
        v-for="row in rows"
        :key="row.name"
        class="sk__row"
        :class="{ 'sk__row--off': row.off, 'sk__row--pending': rowAction.busyFor(row.name) }"
        :aria-busy="rowAction.busyFor(row.name) || undefined"
      >
        <div class="sk__head">
          <span class="sk__name mono">{{ row.name }}</span>
          <span class="sk__badge" :class="`sk__badge--${badgeKind(row)}`">{{ badgeLabel(row) }}</span>
        </div>
        <p class="sk__desc">{{ row.description }}</p>
        <p v-if="row.shadowedByRepo" class="sk__shadow mono">{{ row.shadowedByRepo }}</p>
        <!-- Keyed per row and held through the reload: a second press on «Видалити» used to send
             a second delete, which then failed because the first had already removed the row. -->
        <div class="sk__actions">
          <!-- A tombstone offers exactly one action: switching the default back on. Editing
               the body of a skill the session does not get would be theatre. -->
          <button
            v-if="row.off"
            type="button"
            class="sk__btn"
            :disabled="!canWrite || rowAction.busyFor(row.name)"
            :aria-busy="rowAction.busyFor(row.name) || undefined"
            @click="rowAction.run(row.name, 'drop')"
          >
            <KSpinner v-if="rowAction.busyFor(row.name)" :size="10" />
            {{ t('settings.skillsLibrary.enable') }}
          </button>
          <template v-else>
            <button
              type="button"
              class="sk__btn"
              :disabled="!canWrite || rowAction.busyFor(row.name)"
              @click="edit(row)"
            >{{ t('settings.skillsLibrary.edit') }}</button>
            <button
              v-if="row.source !== 'default'"
              type="button"
              class="sk__btn"
              :disabled="!canWrite || rowAction.busyFor(row.name)"
              :aria-busy="rowAction.busyFor(row.name) || undefined"
              @click="rowAction.run(row.name, 'drop')"
            >
              <KSpinner v-if="rowAction.busyFor(row.name)" :size="10" />
              {{ t('settings.skillsLibrary.delete') }}
            </button>
            <button
              v-else
              type="button"
              class="sk__btn"
              :disabled="!canWrite || rowAction.busyFor(row.name)"
              :aria-busy="rowAction.busyFor(row.name) || undefined"
              @click="rowAction.run(row.name, 'disable')"
            >
              <KSpinner v-if="rowAction.busyFor(row.name)" :size="10" />
              {{ t('settings.skillsLibrary.disable') }}
            </button>
          </template>
        </div>
        <AiProvenance
          v-if="!row.off && provenanceOf(row.name)"
          :owner="owner"
          :created-at="provenanceOf(row.name)!.createdAt"
          :created-by="provenanceOf(row.name)!.createdBy"
          :updated-at="provenanceOf(row.name)!.updatedAt"
          :updated-by="provenanceOf(row.name)!.updatedBy"
        />
      </li>
    </ul>
    <!-- Only when the read actually succeeded: after a failure the error line stands alone,
         because «бібліотека порожня» under a failed read is a lie about the project. -->
    <p v-else-if="phase === 'ready' && !error" class="sk__empty mono">{{ t('settings.skillsLibrary.empty') }}</p>

    <!-- The checkout's own skills, read-only (spec 2026-10-22-skill-import, decision 2): a session
         gets them anyway, and «Агенти» / «Тригери» can assign them. Project scope only — no
         other owner has a checkout. A name already listed above as a shadowed own row is not
         repeated here. -->
    <section v-if="repoRows.length" class="sk__repo">
      <h4 class="sk__repo-title">{{ t('settings.skillsLibrary.repoTitle') }}</h4>
      <p class="sk__lead">{{ t('settings.skillsLibrary.repoLead') }}</p>
      <ul class="sk__list">
        <li v-for="r in repoRows" :key="r.name" class="sk__row sk__row--repo">
          <div class="sk__head">
            <span class="sk__name mono">{{ r.name }}</span>
            <span class="sk__badge sk__badge--repo">{{ t('settings.skillStatus.repo') }}</span>
            <span v-if="r.overridesDefault" class="sk__badge">{{ t('settings.skillsLibrary.repoOverridesDefault') }}</span>
          </div>
          <p v-if="r.description" class="sk__desc">{{ r.description }}</p>
          <p class="sk__shadow mono">{{ r.path }}</p>
        </li>
      </ul>
    </section>

    <div class="sk__add">
      <button type="button" class="sk__btn sk__btn--primary" :disabled="!canWrite" @click="create">
        {{ t('settings.skillsLibrary.add') }}
      </button>
      <button type="button" class="sk__btn" :disabled="!canWrite" @click="importOpen = true">
        {{ t('settings.skillsLibrary.importBtn') }}
      </button>
    </div>

    <SkillImportPicker v-model="importOpen" :existing="storedRows.map((s) => s.name)" @pick="startImport" />

    <!-- Persistent while the save runs: closing mid-write would hide its refusal. -->
    <KModal
      v-model="editorOpen"
      :title="editing ? t('settings.skillsLibrary.editTitle', { name: draftName }) : t('settings.skillsLibrary.newTitle')"
      :persistent="saving"
    >
      <!-- The name is a directory name under ~/.kermanych/skills/<project>/, so it is fixed
           once the row exists: renaming would orphan the materialised directory. -->
      <KField
        v-model="draftName"
        :label="t('settings.skillsLibrary.nameLabel')"
        :disabled="editing"
        placeholder="opening-a-pr"
      />
      <KField
        v-model="draftDescription"
        :label="t('settings.skillsLibrary.descLabel')"
        :placeholder="t('settings.skillsLibrary.descPlaceholder')"
      />
      <!-- The stored body is read when an existing skill opens; until it lands the field is a
           skeleton under its label rather than an empty box that looks like the skill's text.
           A failed read leaves the disabled field and the reason on the error line below. -->
      <div v-if="bodyPhase !== 'ready'" class="sk__body-wait">
        <span class="sk__body-label">{{ t('settings.skillsLibrary.bodyLabel') }}</span>
        <KSkeleton v-if="bodyPhase === 'skeleton'" variant="lines" :rows="5" />
      </div>
      <KField v-else v-model="draftBody" :label="t('settings.skillsLibrary.bodyLabel')" multiline :disabled="bodyPending" />
      <!-- An import: what the copy leaves behind, and what its name would collide with. -->
      <div v-if="importing && importExtras.count" class="sk__extra">
        <p class="sk__extra-note">{{ t('settings.skillsLibrary.extraNote') }}</p>
        <ul class="sk__extra-list mono">
          <li v-for="f in importExtras.files" :key="f">{{ f }}</li>
          <li v-if="importExtras.count > importExtras.files.length">
            {{ t('settings.skillsLibrary.extraMore', { n: importExtras.count - importExtras.files.length }) }}
          </li>
        </ul>
      </div>
      <p v-if="importMessage" class="mono" :class="importCheck.error ? 'sk__error' : 'sk__warn'">{{ importMessage }}</p>
      <p v-if="formError" class="sk__error mono">{{ formError }}</p>
      <template #controls>
        <button type="button" class="sk__btn" :disabled="saving" @click="editorOpen = false">{{ t('settings.modal.cancel') }}</button>
        <!-- Saving while the stored body has not been read would write the empty draft over
             it, so the editor is not savable until that read lands — and stays unsavable if
             it failed, with the reason on the form's error line. `canWrite` is checked here
             too, like every list action: the modal must never be the one surface where a
             non-owner's write reaches postgrest only to be refused there. -->
        <button
          type="button"
          class="sk__btn sk__btn--primary"
          :disabled="saving || bodyPending || !canWrite || !!importCheck.error"
          :aria-busy="saving || undefined"
          @click="save"
        >
          <KSpinner v-if="saving" :size="10" />
          {{ t('settings.skillsLibrary.save') }}
        </button>
      </template>
    </KModal>
  </section>
</template>

<script setup lang="ts">
// The project's skill library. Reads the RESOLVED view from the local API (only it can see
// whether the bound checkout already defines a skill of the same name) and writes rows
// straight to Supabase, where RLS enforces owner-only edits — the same split the .env editor
// uses for values-vs-names.
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import {
  DEFAULT_SKILLS,
  SKILL_NAME_RE,
  type ProjectSkillsPayload,
  type RepoSkill,
  type SkillImportRead,
  type SkillView,
} from '@kermanych/core';
import { deleteAiSkill, listAiSkills, upsertAiSkill, type AiOwner, type AiSkill } from '@kermanych/cloud';
import { api } from '../../lib/api';
import { useAuth } from 'stores/auth';
import { useProjects } from 'stores/projects';
import { importNameProblem, ownerLibraryView } from '../../lib/ai-team';
import KModal from 'components/kit/KModal.vue';
import KField from 'components/kit/KField.vue';
import KSkeleton from 'components/kit/KSkeleton.vue';
import KSpinner from 'components/kit/KSpinner.vue';
import { errorText, useAsyncAction, useKeyedAction } from '../../composables/useAsyncAction';
import { useLoadPhase } from '../../composables/useLoadPhase';
import AiProvenance from './AiProvenance.vue';
import SkillImportPicker from './SkillImportPicker.vue';

const { t } = useI18n();

// `workspace` is the project's workspace, at project scope only: an import under one of its
// skill names is warned about, since it overrides that skill for this project.
const props = defineProps<{ owner: AiOwner; ownerName: string; workspace?: AiOwner | undefined }>();

// What the list renders. The endpoint answers "what the session gets", which by design does
// NOT include a Kermanych default this project switched off — so those rows are added here,
// from the project's own cloud rows, marked `off`. The endpoint's type stays untouched: a
// disabled skill is not part of a session's library and has no place in `SkillView`.
type Row = SkillView & { off?: boolean };

const auth = useAuth();
const projects = useProjects();
const rows = ref<Row[]>([]);
// The owner's own cloud rows, kept beside the resolved view so each own skill can show its
// author and last editor — the resolved SkillView carries no audit, the AiSkill row does.
const storedRows = ref<AiSkill[]>([]);
const error = ref('');
// The checkout's own skills, keyed by name (project scope; empty elsewhere).
const repo = ref<Record<string, RepoSkill>>({});
const importOpen = ref(false);
// The draft in the editor came from the import picker: the name checks and the extra-files note
// apply, and only to it — an ordinary «Додати» keeps its own behaviour.
const importing = ref(false);
const importExtras = ref<{ files: string[]; count: number }>({ files: [], count: 0 });
// The project's workspace skill names, read when an import opens at project scope.
const workspaceNames = ref<string[]>([]);
// The owner whose read last finished, either way. Anything else means «not loaded for the owner
// on screen», which is what the skeleton stands for; a refresh of the same owner keeps the list.
const loadedFor = ref('');
const editorOpen = ref(false);
const editing = ref(false);
const formError = ref('');
const draftName = ref('');
const draftDescription = ref('');
const draftBody = ref('');
// Carried through the editor and echoed on every upsert. `upsertProjectSkill` applies
// `enabled ?? true` on the UPDATE branch as well, so omitting it here would silently
// re-enable a default that this project had turned off — losing the one bit that
// `Вимкнути` writes.
const draftEnabled = ref(true);
// The stored body is fetched when an existing skill is opened; until it arrives (or if the
// fetch failed) the draft body is NOT the skill's text and must not be written back.
const bodyPending = ref(false);
// Which draft the refs above currently hold. A body read is asynchronous, so it captures this
// number before its await and drops its result if the number has moved on — otherwise a read
// started for one skill (or one project) would land in whatever draft the operator opened
// next, making it savable with another skill's body under a different name.
let draftToken = 0;

function ownerKeyNow(): string {
  return props.owner.scope + ':' + props.owner.id;
}
const phase = useLoadPhase(() => loadedFor.value !== ownerKeyNow());
// A failed body read sets `formError` and leaves `bodyPending` up: that is a reason, not a wait.
const bodyPhase = useLoadPhase(() => bodyPending.value && !formError.value);

const canWrite = computed(() =>
  props.owner.scope === 'user'
    ? true
    : props.owner.scope === 'workspace'
      ? projects.isWorkspaceOwner(props.owner.id)
      : projects.isOwner(props.owner.id),
);

// The stored row behind a library entry, when this owner has one — a compile-time default
// has no row and so no author to show.
function provenanceOf(name: string): AiSkill | undefined {
  return storedRows.value.find((s) => s.name === name);
}

// The repository block: every checkout skill not already on screen as a shadowed own row.
const repoRows = computed(() => {
  if (props.owner.scope !== 'project') return [];
  const shown = new Set(rows.value.filter((r) => r.shadowedByRepo).map((r) => r.name));
  return Object.entries(repo.value)
    .filter(([name]) => !shown.has(name))
    .map(([name, r]) => ({ name, ...r, overridesDefault: DEFAULT_SKILLS.some((d) => d.name === name) }))
    .sort((a, b) => a.name.localeCompare(b.name));
});

const importCheck = computed(() =>
  importing.value
    ? importNameProblem(draftName.value, {
        scope: props.owner.scope,
        stored: storedRows.value.map((s) => s.name),
        workspace: workspaceNames.value,
        repo: repo.value,
      })
    : {},
);
const importMessage = computed(() => {
  const c = importCheck.value;
  const name = draftName.value;
  if (c.error === 'exists') return t('settings.skillsLibrary.errExists', { name });
  if (c.error === 'repo') return t('settings.skillsLibrary.errRepo');
  if (c.warn === 'default') return t('settings.skillsLibrary.warnDefault', { name });
  if (c.warn === 'workspace') return t('settings.skillsLibrary.warnWorkspace', { name });
  return '';
});

// The resolved library view for this owner. Only a project has a checkout, so only it can be
// shadowed by repo files and only it has the api endpoint that sees them; every other scope
// resolves the view from its own cloud rows, with no repo shadow.
async function libraryView(owner: AiOwner): Promise<ProjectSkillsPayload> {
  if (owner.scope === 'project') return await api.projectSkills(owner.id);
  return { view: ownerLibraryView(await listAiSkills(auth.client, owner)), repo: {} };
}

function badgeKind(row: Row): string {
  if (row.off) return 'off';
  return row.shadowedByRepo ? 'repo' : row.source;
}
function badgeLabel(row: Row): string {
  if (row.off) return t('settings.skillsLibrary.badgeOff');
  if (row.shadowedByRepo) return t('settings.skillsLibrary.badgeRepo');
  return t(`settings.skillStatus.${row.source}`);
}

// A row with `enabled: false` whose name is one of Kermanych's own defaults is a TOMBSTONE:
// it exists only to keep that default out of the library. The description comes from the
// default itself, so the screen still says what the switched-off skill does. A disabled row
// under any other name is not shown — it suppresses nothing, so there is nothing to switch.
function tombstones(stored: readonly AiSkill[]): Row[] {
  const off: Row[] = [];
  for (const row of stored) {
    if (row.enabled) continue;
    const def = DEFAULT_SKILLS.find((d) => d.name === row.name);
    if (def) off.push({ name: def.name, description: def.description, source: 'default', off: true });
  }
  return off;
}

// Bumped per read: row actions each end in a reload, and those can overlap within one owner —
// only the newest read may paint, or an older reply would put back a dropped or toggled row.
let loadRun = 0;
async function load(): Promise<void> {
  // Pinned for the whole read: the prop can change mid-flight (see the watcher below), which
  // also means two loads can overlap. A load that finishes after the project moved on drops
  // its result — the list must never show a library the header does not name.
  const ownerKey = props.owner.scope + ':' + props.owner.id;
  const run = ++loadRun;
  const stale = (): boolean => run !== loadRun || ownerKey !== props.owner.scope + ':' + props.owner.id;
  error.value = '';
  try {
    // Both reads, together: the resolved view is what the session gets, the cloud rows are
    // the only place a switched-off default is still recorded. The payload's `repo` half feeds
    // the read-only «З репозиторію» block — a name only the repository defines is not in this
    // project's library, so it is never listed as an editable row.
    const [library, stored] = await Promise.all([
      libraryView(props.owner),
      listAiSkills(auth.client, props.owner),
    ]);
    if (stale()) return;
    // Workspace is the base: it shows the system defaults (with a «Вимкнути») plus its own
    // skills. Project and user show ONLY their OWN skills in the editable list — the defaults
    // and the workspace's skills are inherited, and live read-only in the «Успадковано» block
    // below (AiInherited). Filtering by source keeps repo-shadowed OWN rows and drops defaults.
    rows.value =
      props.owner.scope === 'workspace'
        ? [...library.view, ...tombstones(stored)]
        : library.view.filter((v) => v.source !== 'default');
    storedRows.value = stored;
    repo.value = library.repo;
  } catch (e) {
    if (stale()) return;
    // The endpoint refuses rather than degrade to the defaults, so a failed read must not
    // leave a list on screen either: what is shown would not be this project's library.
    rows.value = [];
    repo.value = {};
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    if (!stale()) loadedFor.value = ownerKey;
  }
}

// `projectId` is a LIVE prop, not a mount-time constant: SettingsPage renders its panes with
// no `:key` and the sidebar's project rows only move the selection, never the route
// (MainLayout.selectProject), so picking another project swaps the prop under a
// component that stays mounted. Reading once on mount would leave the PREVIOUS project's
// library on screen under the new project's name, and every action would then write the old
// project's data into the new one. Re-read on every change, and close the editor with it: a
// modal left open across the switch would save its draft into a project it was never opened
// for.
watch(
  () => props.owner.scope + ':' + props.owner.id,
  () => {
    // Synchronously, not by way of the `editorOpen` watcher below (which is pre-flush): the
    // instant the project changes, the modal is shut AND the draft is emptied, so there is no
    // tick in which a live draft could be saved into a project it was not opened for, and any
    // body read still in flight is invalidated.
    editorOpen.value = false;
    resetDraft();
    // The previous project's rows must not stay on screen under the new project's name for the
    // length of the reload: every row action pins the LIVE prop, so a click in that window
    // would write the old project's data into the new one. `loadedFor` still names the old
    // owner, so the skeleton — never the empty-state line — renders while the read is in flight.
    rows.value = [];
    repo.value = {};
    void load();
  },
  { immediate: true },
);

// Empties the draft and invalidates any body read still in flight, returning the new token
// for the caller that is about to start one. Every close goes through the watcher below —
// «Скасувати», a successful save, the backdrop and Esc (KModal closes itself), and the project
// switch above — so there is no call site left to forget.
function resetDraft(): number {
  draftToken += 1;
  editing.value = false;
  draftName.value = '';
  draftDescription.value = '';
  draftBody.value = '';
  draftEnabled.value = true;
  bodyPending.value = false;
  importing.value = false;
  importExtras.value = { files: [], count: 0 };
  formError.value = '';
  return draftToken;
}
watch(editorOpen, (open) => {
  if (!open) resetDraft();
});

function create(): void {
  resetDraft();
  editorOpen.value = true;
}

// A skill picked from disk: the editor opens on its text, under the suggested name, with the
// import checks on. The workspace names are read here, at project scope only; a failed read
// only costs the «overrides the workspace» warning, never the import.
function startImport(skill: SkillImportRead): void {
  resetDraft();
  importing.value = true;
  draftName.value = skill.suggestedName;
  draftDescription.value = skill.description;
  draftBody.value = skill.body;
  importExtras.value = { files: skill.extraFiles, count: skill.extraCount };
  editorOpen.value = true;
  workspaceNames.value = [];
  const ws = props.workspace;
  if (props.owner.scope === 'project' && ws) {
    const token = draftToken;
    listAiSkills(auth.client, ws)
      .then((list) => {
        if (token === draftToken) workspaceNames.value = list.filter((s) => s.enabled).map((s) => s.name);
      })
      .catch(() => {});
  }
}

async function edit(row: Row): Promise<void> {
  const token = resetDraft();
  editing.value = true;
  draftName.value = row.name;
  draftDescription.value = row.description;
  bodyPending.value = true;
  editorOpen.value = true;
  // A default has no row yet: its body comes from the library constant, so the editor opens
  // on the cloud row when one exists and on an empty body when it does not. A default that
  // is being edited into a project row is enabled by definition — it is in the view.
  try {
    const stored = (await listAiSkills(auth.client, props.owner)).find((s) => s.name === row.name);
    // The operator cancelled, opened another skill, or switched project while this was in
    // flight: the refs now belong to a different draft, and both the body and the error
    // below would be someone else's.
    if (token !== draftToken) return;
    draftBody.value = stored?.body ?? '';
    draftEnabled.value = stored?.enabled ?? true;
    bodyPending.value = false;
  } catch (e) {
    if (token !== draftToken) return;
    formError.value = e instanceof Error ? e.message : String(e);
  }
}

// The modal's one write path, guarded and spun by `useAsyncAction`; the modal is persistent
// while it runs, so «Скасувати», Esc and the backdrop cannot drop a draft mid-write. The reload
// runs after the modal shut, so a skill opened meanwhile does not see a spinning «Зберегти».
const { run: runSave, busy: saving } = useAsyncAction(saveSkill);
async function save(): Promise<void> {
  if (await runSave()) await load();
}

// True when the editor closed on a stored skill.
async function saveSkill(): Promise<boolean | undefined> {
  // Pinned with the draft token: the write must target the project whose library the operator
  // was looking at when the button was pressed, and a message from this attempt must not be
  // painted onto a draft that has since been replaced (a project switch shuts the editor).
  const owner = props.owner;
  const token = draftToken;
  formError.value = '';
  if (!SKILL_NAME_RE.test(draftName.value)) {
    formError.value = t('settings.skillsLibrary.errName');
    return;
  }
  if (!draftDescription.value.trim()) {
    formError.value = t('settings.skillsLibrary.errNoDesc');
    return;
  }
  // An import never overwrites a row and never lands under a name the checkout owns.
  if (importCheck.value.error) {
    formError.value = importMessage.value;
    return;
  }
  try {
    await upsertAiSkill(auth.client, {
      owner,
      name: draftName.value,
      description: draftDescription.value,
      body: draftBody.value,
      enabled: draftEnabled.value,
    });
  } catch (e) {
    if (token === draftToken) formError.value = errorText(e);
    return;
  }
  // Only the draft that started this save may close the editor: closing fires the `editorOpen`
  // watcher, which would wipe a draft that replaced it.
  if (token !== draftToken) return;
  editorOpen.value = false;
  return true;
}

// The row actions, keyed by skill name and awaited through the reload: the pressed button
// spins, the row dims and takes no second press until the re-read shows the result. Before
// this a second «Видалити» sent a second delete, which failed on the already-gone row.
const rowAction = useKeyedAction(async (name: string, kind: 'drop' | 'disable') => {
  if (kind === 'drop') await dropRow(name);
  else await disable(name);
});

// Both list actions that delete the project's row for a name. What differs is only what the
// row MEANS: «Видалити» drops a skill the project added, while «Увімкнути» drops the
// `enabled: false` tombstone of a Kermanych default — which makes that default reappear from
// DEFAULT_SKILLS with its original text, so the body the tombstone never carried is never
// needed to switch it back on.
//
// `deleteProjectSkill` throws when the delete removed nothing — an RLS refusal or an
// already-gone row. Nothing is dropped from the list here: the endpoint is re-read, so what
// the screen shows is what the library resolves to.
async function dropRow(name: string): Promise<void> {
  // Pinned like every other write on this page: the row belonged to the project on screen
  // when the button was pressed, and a failure of this attempt is not news about a project
  // the operator has since switched to.
  const ownerKey = props.owner.scope + ':' + props.owner.id;
  error.value = '';
  try {
    await deleteAiSkill(auth.client, props.owner, name);
  } catch (e) {
    if (ownerKey !== props.owner.scope + ':' + props.owner.id) return;
    error.value = e instanceof Error ? e.message : String(e);
    return;
  }
  if (ownerKey === ownerKeyNow()) await load();
}

// Turning a Kermanych default off is a row with enabled:false — the resolver drops the name.
async function disable(name: string): Promise<void> {
  const def = rows.value.find((r) => r.name === name);
  if (!def) return;
  const ownerKey = props.owner.scope + ':' + props.owner.id;
  error.value = '';
  try {
    await upsertAiSkill(auth.client, {
      owner: props.owner,
      name,
      description: def.description,
      body: '',
      enabled: false,
    });
  } catch (e) {
    if (ownerKey !== props.owner.scope + ':' + props.owner.id) return;
    error.value = e instanceof Error ? e.message : String(e);
    return;
  }
  if (ownerKey === ownerKeyNow()) await load();
}
</script>

<style scoped lang="scss">
.sk__lead { font-size: 13px; color: var(--k-muted); margin-bottom: 12px; }
.sk__lead-project { color: var(--k-text); }
.sk__list { list-style: none; margin: 0 0 12px; padding: 0; display: grid; gap: 8px; }
.sk__row { padding: 10px 12px; background: var(--k-surface); border: 1px solid var(--k-line); border-radius: var(--k-r); }
/* A switched-off default: dashed border and a dimmed name, so it reads as a slot the
   project emptied rather than a skill the session has. Its «Увімкнути» stays full strength. */
.sk__row--off { border-style: dashed; background: transparent; }
.sk__row--off .sk__name, .sk__row--off .sk__desc { color: var(--k-muted); }
/* A row whose delete / switch is in flight: dimmed until the reload shows the result. */
.sk__row--pending { opacity: 0.55; }
.sk__head { display: flex; align-items: center; gap: 8px; }
.sk__name { font-size: 12.5px; }
.sk__badge { font-size: 10.5px; padding: 1px 6px; border: 1px solid var(--k-line-strong); border-radius: var(--k-r); color: var(--k-muted); }
.sk__badge--repo { color: var(--k-accent); border-color: var(--k-accent); }
.sk__badge--off { border-style: dashed; }
.sk__desc { margin: 6px 0 0; font-size: 12.5px; }
.sk__shadow { margin: 4px 0 0; font-size: 11px; color: var(--k-muted); }
.sk__actions { display: flex; gap: 6px; margin-top: 8px; }
.sk__btn { font: inherit; font-size: 12px; padding: 3px 10px; background: transparent; color: var(--k-text); border: 1px solid var(--k-line-strong); border-radius: var(--k-r); cursor: pointer; }
.sk__btn:disabled { opacity: 0.45; cursor: default; }
/* Room for the inline spinner an in-flight write puts in front of the label. */
.sk__btn { display: inline-flex; align-items: center; gap: 6px; }
/* The body field's place while its stored text loads: KField's label over a skeleton, laid out
   like the field so the modal does not jump when the textarea arrives. */
.sk__body-wait { display: flex; flex-direction: column; gap: 6px; min-height: 120px; font-family: var(--k-font-ui); }
.sk__body-label { font-size: 13px; color: var(--k-text); }
.sk__btn--primary { border-color: var(--k-accent); color: var(--k-accent); }
.sk__add { display: flex; gap: 8px; }
.sk__repo { margin: 4px 0 14px; }
.sk__repo-title { font-size: 12.5px; font-weight: 600; margin: 0 0 4px; }
.sk__row--repo { background: transparent; border-style: dashed; }
.sk__warn { font-size: 11.5px; color: var(--k-muted); }
.sk__extra { margin-top: 8px; }
.sk__extra-note { font-size: 11.5px; color: var(--k-muted); margin: 0 0 4px; }
.sk__extra-list { font-size: 11px; color: var(--k-faint); margin: 0; padding-left: 16px; max-height: 120px; overflow: auto; }
.sk__error { font-size: 11.5px; color: var(--k-accent); }
.sk__empty { font-size: 12px; color: var(--k-muted); margin-bottom: 12px; }
</style>
