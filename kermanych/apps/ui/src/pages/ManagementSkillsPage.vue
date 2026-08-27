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
      <li v-for="row in rows" :key="row.name" class="sk__row">
        <div class="sk__head">
          <span class="sk__name mono">{{ row.name }}</span>
          <span class="sk__badge" :class="`sk__badge--${badgeKind(row)}`">{{ badgeLabel(row) }}</span>
        </div>
        <p class="sk__desc">{{ row.description }}</p>
        <p v-if="row.shadowedByRepo" class="sk__shadow mono">{{ row.shadowedByRepo }}</p>
        <div class="sk__actions">
          <button type="button" class="sk__btn" :disabled="!canWrite" @click="edit(row)">Редагувати</button>
          <button
            v-if="row.source === 'project'"
            type="button"
            class="sk__btn"
            :disabled="!canWrite"
            @click="remove(row.name)"
          >Видалити</button>
          <button v-else type="button" class="sk__btn" :disabled="!canWrite" @click="disable(row.name)">
            Вимкнути
          </button>
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
             it failed, with the reason on the form's error line. -->
        <button
          type="button"
          class="sk__btn sk__btn--primary"
          :disabled="saving || bodyPending"
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
import { computed, onMounted, ref } from 'vue';
import { SKILL_NAME_RE, type SkillView } from '@kermanych/core';
import { deleteProjectSkill, listProjectSkills, upsertProjectSkill } from '@kermanych/cloud';
import { api } from '../lib/api';
import { useAuth } from '../stores/auth';
import { useProjects } from '../stores/projects';
import KModal from '../components/kit/KModal.vue';
import KField from '../components/kit/KField.vue';

const props = defineProps<{ projectId: string; projectName: string }>();

const auth = useAuth();
const projects = useProjects();
const rows = ref<SkillView[]>([]);
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

const canWrite = computed(() => projects.isOwner(props.projectId));

function badgeKind(row: SkillView): string {
  return row.shadowedByRepo ? 'repo' : row.source;
}
function badgeLabel(row: SkillView): string {
  if (row.shadowedByRepo) return 'перекрито репо';
  return row.source === 'default' ? 'дефолт' : 'проєкт';
}

async function load(): Promise<void> {
  error.value = '';
  loading.value = true;
  try {
    rows.value = await api.projectSkills(props.projectId);
  } catch (e) {
    // The endpoint refuses rather than degrade to the defaults, so a failed read must not
    // leave a list on screen either: what is shown would not be this project's library.
    rows.value = [];
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    loading.value = false;
  }
}
onMounted(load);

function create(): void {
  editing.value = false;
  draftName.value = '';
  draftDescription.value = '';
  draftBody.value = '';
  bodyPending.value = false;
  draftEnabled.value = true;
  formError.value = '';
  editorOpen.value = true;
}

async function edit(row: SkillView): Promise<void> {
  editing.value = true;
  draftName.value = row.name;
  draftDescription.value = row.description;
  draftBody.value = '';
  draftEnabled.value = true;
  bodyPending.value = true;
  formError.value = '';
  editorOpen.value = true;
  // A default has no row yet: its body comes from the library constant, so the editor opens
  // on the cloud row when one exists and on an empty body when it does not. A default that
  // is being edited into a project row is enabled by definition — it is in the view.
  try {
    const stored = (await listProjectSkills(auth.client, [props.projectId])).find((s) => s.name === row.name);
    draftBody.value = stored?.body ?? '';
    draftEnabled.value = stored?.enabled ?? true;
    bodyPending.value = false;
  } catch (e) {
    formError.value = e instanceof Error ? e.message : String(e);
  }
}

async function save(): Promise<void> {
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
      projectId: props.projectId,
      name: draftName.value,
      description: draftDescription.value,
      body: draftBody.value,
      enabled: draftEnabled.value,
    });
    editorOpen.value = false;
    await load();
  } catch (e) {
    formError.value = e instanceof Error ? e.message : String(e);
  } finally {
    saving.value = false;
  }
}

// `deleteProjectSkill` throws when the delete removed nothing — an RLS refusal or an
// already-gone skill. Nothing is dropped from the list here: the endpoint is re-read, so
// what the screen shows is what the library resolves to.
async function remove(name: string): Promise<void> {
  error.value = '';
  try {
    await deleteProjectSkill(auth.client, props.projectId, name);
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
    return;
  }
  await load();
}

// Turning a Kermanych default off is a row with enabled:false — the resolver drops the name.
async function disable(name: string): Promise<void> {
  const def = rows.value.find((r) => r.name === name);
  if (!def) return;
  error.value = '';
  try {
    await upsertProjectSkill(auth.client, {
      projectId: props.projectId,
      name,
      description: def.description,
      body: '',
      enabled: false,
    });
  } catch (e) {
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
.sk__head { display: flex; align-items: center; gap: 8px; }
.sk__name { font-size: 12.5px; }
.sk__badge { font-size: 10.5px; padding: 1px 6px; border: 1px solid var(--k-line-strong); border-radius: var(--k-r); color: var(--k-muted); }
.sk__badge--repo { color: var(--k-accent); border-color: var(--k-accent); }
.sk__desc { margin: 6px 0 0; font-size: 12.5px; }
.sk__shadow { margin: 4px 0 0; font-size: 11px; color: var(--k-muted); }
.sk__actions { display: flex; gap: 6px; margin-top: 8px; }
.sk__btn { font: inherit; font-size: 12px; padding: 3px 10px; background: transparent; color: var(--k-text); border: 1px solid var(--k-line-strong); border-radius: var(--k-r); cursor: pointer; }
.sk__btn:disabled { opacity: 0.45; cursor: default; }
.sk__btn--primary { border-color: var(--k-accent); color: var(--k-accent); }
.sk__error { font-size: 11.5px; color: var(--k-accent); }
.sk__empty { font-size: 12px; color: var(--k-muted); margin-bottom: 12px; }
</style>
