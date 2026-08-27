<template>
  <section class="sk">
    <p class="sk__lead">
      Бібліотека скілів проєкту
      <span class="sk__lead-project mono">{{ projectName }}</span>
      — агент сам вирішує, коли їх узяти. Скіл із таким же імʼям у репозиторії завжди
      перемагає: Керманич його не підміняє.
    </p>

    <p v-if="error" class="sk__error mono">{{ error }}</p>

    <ul v-if="rows.length" class="sk__list">
      <li v-for="row in rows" :key="row.name" class="sk__row" :class="{ 'sk__row--off': row.off }">
        <div class="sk__head">
          <span class="sk__name mono">{{ row.name }}</span>
          <span class="sk__badge" :class="`sk__badge--${badgeKind(row)}`">{{ badgeLabel(row) }}</span>
        </div>
        <p class="sk__desc">{{ row.description }}</p>
        <p v-if="row.shadowedByRepo" class="sk__shadow mono">{{ row.shadowedByRepo }}</p>
        <div class="sk__actions">
          <!-- A tombstone offers exactly one action: switching the default back on. Editing
               the body of a skill the session does not get would be theatre. -->
          <button
            v-if="row.off"
            type="button"
            class="sk__btn"
            :disabled="!canWrite"
            @click="dropRow(row.name)"
          >Увімкнути</button>
          <template v-else>
            <button type="button" class="sk__btn" :disabled="!canWrite" @click="edit(row)">Редагувати</button>
            <button
              v-if="row.source === 'project'"
              type="button"
              class="sk__btn"
              :disabled="!canWrite"
              @click="dropRow(row.name)"
            >Видалити</button>
            <button v-else type="button" class="sk__btn" :disabled="!canWrite" @click="disable(row.name)">
              Вимкнути
            </button>
          </template>
        </div>
      </li>
    </ul>
    <!-- Only when the read actually succeeded: after a failure the error line stands alone,
         because «бібліотека порожня» under a failed read is a lie about the project. -->
    <p v-else-if="!error && !loading" class="sk__empty mono">Бібліотека порожня.</p>

    <button type="button" class="sk__btn sk__btn--primary" :disabled="!canWrite" @click="create">
      Додати скіл
    </button>

    <KModal v-model="editorOpen" :title="editing ? `Скіл · ${draftName}` : 'Новий скіл'">
      <!-- The name is a directory name under ~/.kermanych/skills/<project>/, so it is fixed
           once the row exists: renaming would orphan the materialised directory. -->
      <KField
        v-model="draftName"
        label="Імʼя (латиниця, цифри, дефіс)"
        :disabled="editing"
        placeholder="opening-a-pr"
      />
      <KField
        v-model="draftDescription"
        label="Коли застосовувати (обовʼязково)"
        placeholder="Use when … — без опису omp проігнорує скіл"
      />
      <KField v-model="draftBody" label="Текст скіла (Markdown)" multiline :disabled="bodyPending" />
      <p v-if="formError" class="sk__error mono">{{ formError }}</p>
      <template #controls>
        <button type="button" class="sk__btn" @click="editorOpen = false">Скасувати</button>
        <!-- Saving while the stored body has not been read would write the empty draft over
             it, so the editor is not savable until that read lands — and stays unsavable if
             it failed, with the reason on the form's error line. `canWrite` is checked here
             too, like every list action: the modal must never be the one surface where a
             non-owner's write reaches postgrest only to be refused there. -->
        <button
          type="button"
          class="sk__btn sk__btn--primary"
          :disabled="saving || bodyPending || !canWrite"
          @click="save"
        >Зберегти</button>
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
import { DEFAULT_SKILLS, SKILL_NAME_RE, type SkillView } from '@kermanych/core';
import { deleteProjectSkill, listProjectSkills, upsertProjectSkill, type ProjectSkill } from '@kermanych/cloud';
import { api } from '../lib/api';
import { useAuth } from '../stores/auth';
import { useProjects } from '../stores/projects';
import KModal from '../components/kit/KModal.vue';
import KField from '../components/kit/KField.vue';

const props = defineProps<{ projectId: string; projectName: string }>();

// What the list renders. The endpoint answers "what the session gets", which by design does
// NOT include a Kermanych default this project switched off — so those rows are added here,
// from the project's own cloud rows, marked `off`. The endpoint's type stays untouched: a
// disabled skill is not part of a session's library and has no place in `SkillView`.
type Row = SkillView & { off?: boolean };

const auth = useAuth();
const projects = useProjects();
const rows = ref<Row[]>([]);
const error = ref('');
const loading = ref(true);
const editorOpen = ref(false);
const editing = ref(false);
const saving = ref(false);
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

const canWrite = computed(() => projects.isOwner(props.projectId));

function badgeKind(row: Row): string {
  if (row.off) return 'off';
  return row.shadowedByRepo ? 'repo' : row.source;
}
function badgeLabel(row: Row): string {
  if (row.off) return 'вимкнено';
  if (row.shadowedByRepo) return 'перекрито репо';
  return row.source === 'default' ? 'дефолт' : 'проєкт';
}

// A row with `enabled: false` whose name is one of Kermanych's own defaults is a TOMBSTONE:
// it exists only to keep that default out of the library. The description comes from the
// default itself, so the screen still says what the switched-off skill does. A disabled row
// under any other name is not shown — it suppresses nothing, so there is nothing to switch.
function tombstones(stored: readonly ProjectSkill[]): Row[] {
  const off: Row[] = [];
  for (const row of stored) {
    if (row.enabled) continue;
    const def = DEFAULT_SKILLS.find((d) => d.name === row.name);
    if (def) off.push({ name: def.name, description: def.description, source: 'default', off: true });
  }
  return off;
}

async function load(): Promise<void> {
  // Pinned for the whole read: the prop can change mid-flight (see the watcher below), which
  // also means two loads can overlap. A load that finishes after the project moved on drops
  // its result — the list must never show a library the header does not name.
  const projectId = props.projectId;
  error.value = '';
  loading.value = true;
  try {
    // Both reads, together: the resolved view is what the session gets, the cloud rows are
    // the only place a switched-off default is still recorded.
    const [view, stored] = await Promise.all([
      api.projectSkills(projectId),
      listProjectSkills(auth.client, [projectId]),
    ]);
    if (projectId !== props.projectId) return;
    rows.value = [...view, ...tombstones(stored)];
  } catch (e) {
    if (projectId !== props.projectId) return;
    // The endpoint refuses rather than degrade to the defaults, so a failed read must not
    // leave a list on screen either: what is shown would not be this project's library.
    rows.value = [];
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    if (projectId === props.projectId) loading.value = false;
  }
}

// `projectId` is a LIVE prop, not a mount-time constant: the Менеджмент shell renders its
// sections with no `:key` (ManagementPage.vue) and the rail deliberately does not navigate on
// a Менеджмент route (MainLayout.vue), so picking another project swaps the prop under a
// component that stays mounted. Reading once on mount would leave the PREVIOUS project's
// library on screen under the new project's name, and every action would then write the old
// project's data into the new one. Re-read on every change, and close the editor with it: a
// modal left open across the switch would save its draft into a project it was never opened
// for.
watch(
  () => props.projectId,
  () => {
    // Synchronously, not by way of the `editorOpen` watcher below (which is pre-flush): the
    // instant the project changes, the modal is shut AND the draft is emptied, so there is no
    // tick in which a live draft could be saved into a project it was not opened for, and any
    // body read still in flight is invalidated.
    editorOpen.value = false;
    resetDraft();
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
  const projectId = props.projectId;
  try {
    const stored = (await listProjectSkills(auth.client, [projectId])).find((s) => s.name === row.name);
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

async function save(): Promise<void> {
  // Pinned with the draft token: the write must target the project whose library the operator
  // was looking at when the button was pressed, and a message from this attempt must not be
  // painted onto a draft that has since been replaced.
  const projectId = props.projectId;
  const token = draftToken;
  formError.value = '';
  if (!SKILL_NAME_RE.test(draftName.value)) {
    formError.value = 'Імʼя: лише малі латинські літери, цифри та дефіс (до 64 символів).';
    return;
  }
  if (!draftDescription.value.trim()) {
    formError.value = 'Без опису omp проігнорує скіл.';
    return;
  }
  saving.value = true;
  try {
    await upsertProjectSkill(auth.client, {
      projectId,
      name: draftName.value,
      description: draftDescription.value,
      body: draftBody.value,
      enabled: draftEnabled.value,
    });
    editorOpen.value = false;
    await load();
  } catch (e) {
    if (token !== draftToken) return;
    formError.value = e instanceof Error ? e.message : String(e);
  } finally {
    saving.value = false;
  }
}

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
  const projectId = props.projectId;
  error.value = '';
  try {
    await deleteProjectSkill(auth.client, projectId, name);
  } catch (e) {
    if (projectId !== props.projectId) return;
    error.value = e instanceof Error ? e.message : String(e);
    return;
  }
  await load();
}

// Turning a Kermanych default off is a row with enabled:false — the resolver drops the name.
async function disable(name: string): Promise<void> {
  const def = rows.value.find((r) => r.name === name);
  if (!def) return;
  const projectId = props.projectId;
  error.value = '';
  try {
    await upsertProjectSkill(auth.client, {
      projectId,
      name,
      description: def.description,
      body: '',
      enabled: false,
    });
  } catch (e) {
    if (projectId !== props.projectId) return;
    error.value = e instanceof Error ? e.message : String(e);
    return;
  }
  await load();
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
.sk__btn--primary { border-color: var(--k-accent); color: var(--k-accent); }
.sk__error { font-size: 11.5px; color: var(--k-accent); }
.sk__empty { font-size: 12px; color: var(--k-muted); margin-bottom: 12px; }
</style>
