<template>
  <section class="rel">
    <p class="rel__lead">
      Реліз-ноти воркспейсу
      <span class="rel__lead-workspace mono">{{ workspaceName }}</span>
      — що змінилося для користувачів, написане простою мовою. Все згенероване зберігається
      тут, у воркспейсі, і його бачить уся команда.
    </p>

    <div class="rel__toolbar">
      <span class="rel__count mono">{{ notes.length ? `нотаток: ${notes.length}` : '' }}</span>
      <KBtn variant="primary" @click="openGenerate">+ Згенерувати реліз-ноти</KBtn>
    </div>

    <p v-if="store.loadError" class="rel__error">
      Історія не прочиталась: {{ store.loadError }}
    </p>

    <div v-else-if="!notes.length" class="rel__blank">
      <span class="rel__blank-eyebrow mono">РЕЛІЗ-НОТИ</span>
      <p class="rel__blank-text">
        Ще жодної нотатки. Оберіть проєкт, гілку й період — документ буде написано з
        git-історії так, щоб його зрозуміла й нетехнічна людина.
      </p>
    </div>

    <!-- The history. One row per note, newest first — the answer to «що ми відвантажили
         востаннє» is the first line on the screen. -->
    <ol v-else class="rel__list">
      <li v-for="n in notes" :key="n.id" class="rel__row" @click="openNote(n)">
        <div class="rel__row-main">
          <span class="rel__row-title">{{ n.title }}</span>
          <span class="rel__row-meta">
            <KTag>{{ n.projectName }}</KTag>
            <KTag>{{ n.branch }}</KTag>
            <span class="rel__row-range mono">{{ n.rangeFrom }} — {{ n.rangeTo }}</span>
          </span>
        </div>
        <span class="rel__row-when mono">{{ relativeTime(n.createdAt, now) }}</span>
      </li>
    </ol>

    <!-- ── Generation form ─────────────────────────────────────────────────────
         Persistent while a generation is in flight: an accidental backdrop click must not
         orphan a running omp child with nobody left to receive its document. -->
    <KModal v-model="genOpen" title="Згенерувати реліз-ноти" width="600px" :persistent="genBusy">
      <div class="rel__form">
        <!-- One picker, full width: the project IS the release's shape — its repository is
             the front-end, the back-end or an app — so naming it is the whole answer to
             «which product does this note cover?». -->
        <KSelect
          v-model="gen.projectId"
          label="Проєкт"
          :options="projectOptions"
          placeholder="— оберіть проєкт —"
          :disabled="genBusy"
        />
        <div class="rel__form-row">
          <KSelect
            v-model="gen.branch"
            label="Гілка"
            :options="branches"
            :placeholder="branchPlaceholder"
            :disabled="genBusy || !branches.length"
          />
          <div class="rel__form-range">
            <KDateField v-model="gen.rangeFrom" label="Період з" :disabled="genBusy" />
            <KDateField v-model="gen.rangeTo" label="по" :disabled="genBusy" />
          </div>
        </div>

        <!-- Where the material comes from, said before the button is pressed: the commits
             are read from THIS machine's clone, and the writing spends the same provider
             plan every agent spends. -->
        <p class="rel__form-hint">
          Генерація читає git-історію привʼязаного репозиторію на цій машині й витрачає ту
          саму підписку, що й агенти. Гілку взято з налаштувань проєкту — за потреби
          виберіть іншу.
        </p>

        <p v-if="genError" class="rel__form-error">{{ genError }}</p>
      </div>

      <template #controls>
        <KBtn variant="ghost" :disabled="genBusy" @click="genOpen = false">Скасувати</KBtn>
        <KBtn variant="primary" :disabled="!canGenerate" @click="generate">
          {{ genLabel }}
        </KBtn>
      </template>
    </KModal>

    <!-- ── One note: read, copy, edit ──────────────────────────────────────────
         Persistent while editing: a click past the modal's edge must not discard a
         half-rewritten document. -->
    <KModal
      :model-value="!!current"
      :title="current?.title ?? ''"
      width="820px"
      :persistent="editing || saving"
      @update:model-value="(v: boolean) => { if (!v) closeNote(); }"
    >
      <template #head-meta>
        <span v-if="current" class="rel__doc-meta">
          <KTag>{{ current.projectName }}</KTag>
          <KTag>{{ current.branch }}</KTag>
          <KTag>{{ current.rangeFrom }} — {{ current.rangeTo }}</KTag>
        </span>
      </template>

      <template v-if="current">
        <div v-if="!editing" class="rel__doc">
          <!-- renderMarkdown escapes raw HTML (markdown-it html:false), so v-html is a
               controlled tag set — the same guarantee the assistant transcript relies on. -->
          <div class="k-log__markdown" v-html="renderMarkdown(current.bodyMd)"></div>
          <p class="rel__doc-audit mono">
            згенеровано {{ memberName(current.createdBy) }} · {{ relativeTime(current.createdAt, now) }}
            <template v-if="current.updatedAt !== current.createdAt">
              · змінено {{ memberName(current.updatedBy) }} · {{ relativeTime(current.updatedAt, now) }}
            </template>
          </p>
        </div>

        <div v-else class="rel__edit">
          <KField v-model="draftTitle" label="Заголовок" :disabled="saving" />
          <KField
            v-model="draftBody"
            label="Текст (markdown)"
            multiline
            :rows="18"
            :disabled="saving"
          />
          <p v-if="editError" class="rel__form-error">{{ editError }}</p>
        </div>
      </template>

      <template #controls>
        <template v-if="!editing">
          <KBtn variant="secondary" @click="startEdit">Редагувати</KBtn>
          <KBtn variant="primary" @click="copy">{{ copied ? 'Скопійовано ✓' : 'Копіювати' }}</KBtn>
        </template>
        <template v-else>
          <KBtn variant="ghost" :disabled="saving" @click="cancelEdit">Скасувати</KBtn>
          <KBtn variant="primary" :disabled="saving || !draftTitle.trim() || !draftBody.trim()" @click="saveEdit">
            {{ saving ? 'Зберігаємо…' : 'Зберегти' }}
          </KBtn>
        </template>
      </template>
    </KModal>
  </section>
</template>

<script setup lang="ts">
// Release Notes — the Менеджмент section that turns a branch's git history into a document
// a non-technical reader can use. The shell above (ManagementPage) already renders the
// heading, the workspace chip and the «pick a workspace» gate, so this component renders
// only the section itself and can assume a workspace.
//
// The feature is split across three parties and this component only wires them together:
//   * the local api WRITES the document (api.generateReleaseNotes — git history and a
//     one-shot omp child live behind that call, so generation needs the repo bound HERE);
//   * stores/release-notes.ts STORES it in the workspace under the operator's own JWT,
//     which is what makes the history below visible to every member on every machine;
//   * this screen reads, copies and edits what is stored.
import { computed, reactive, ref, watch } from 'vue';
import type { WorkspaceReleaseNote } from '@kermanych/cloud';
import KModal from 'components/kit/KModal.vue';
import KSelect, { type KSelectOption } from 'components/kit/KSelect.vue';
import KDateField from 'components/kit/KDateField.vue';
import KField from 'components/kit/KField.vue';
import KBtn from 'components/kit/KBtn.vue';
import KTag from 'components/kit/KTag.vue';
import { useReleaseNotes } from 'stores/release-notes';
import { useProjects } from 'stores/projects';
import { useOrchestrator } from 'stores/orchestrator';
import { api } from '../lib/api';
import { renderMarkdown } from '../lib/markdown';
import { relativeTime } from '../lib/time';
import { useNow } from '../composables/useNow';

const props = defineProps<{ workspaceId: string; workspaceName: string }>();

const store = useReleaseNotes();
const projects = useProjects();
const local = useOrchestrator();
const now = useNow(60_000);

// The history is read on open and whenever the sidebar moves to another workspace. No
// Realtime channel: see the header of stores/release-notes.ts.
watch(
  () => props.workspaceId,
  (id) => {
    if (id) void store.load(id);
  },
  { immediate: true },
);

// Author names for the audit line. Same source the risks page uses.
watch(
  () => props.workspaceId,
  (id) => {
    if (id && !projects.members[id]) void projects.loadMembers(id);
  },
  { immediate: true },
);

const notes = computed<WorkspaceReleaseNote[]>(() => store.byWorkspace[props.workspaceId] ?? []);

function memberName(id: string | undefined): string {
  if (!id) return '—';
  const m = (projects.members[props.workspaceId] ?? []).find((x) => x.userId === id);
  return m?.profile?.displayName ?? m?.profile?.githubUsername ?? id;
}

// ── Generation ────────────────────────────────────────────────────────────────

function isoDaysAgo(days: number): string {
  const d = new Date(Date.now() - days * 86_400_000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

const genOpen = ref(false);
const genBusy = ref(false);
const genError = ref('');
const genSec = ref(0);
const gen = reactive({
  projectId: '',
  branch: '',
  rangeFrom: '',
  rangeTo: '',
});

// The workspace's projects, with the binding state said IN the picker: an unbound project
// is still choosable (the error will name the machine), but the operator should not have
// to press «Згенерувати» to learn why nothing can come back.
const projectOptions = computed<KSelectOption[]>(() =>
  projects.projects
    .filter((p) => p.workspaceId === props.workspaceId)
    .map((p) => {
      const bound = !!local.projects.find((lp) => lp.id === p.id)?.localRepoPath;
      return { value: p.id, label: bound ? p.name : `${p.name} · не привʼязаний на цій машині` };
    }),
);

// Branches of the chosen project's local clone. The DEFAULT selection is the project's
// default branch from its settings — the user's requirement — falling back to the repo's
// current HEAD; the picker then lets the operator switch to any local branch.
const branches = ref<string[]>([]);
const branchesFailed = ref(false);

const branchPlaceholder = computed(() => {
  if (!gen.projectId) return '— спершу оберіть проєкт —';
  return branchesFailed.value ? 'гілки недоступні — проєкт не привʼязаний тут' : '— гілок не знайдено —';
});

watch(
  () => gen.projectId,
  async (id) => {
    branches.value = [];
    branchesFailed.value = false;
    gen.branch = '';
    if (!id) return;
    try {
      const info = await local.listBranches(id);
      branches.value = info.branches;
      gen.branch = info.default ?? info.current ?? info.branches[0] ?? '';
    } catch {
      // GET /projects/:id/branches answers `project not bound` without a binding — the
      // placeholder says so, and the generate button stays disabled without a branch.
      branchesFailed.value = true;
    }
  },
);

function openGenerate(): void {
  genError.value = '';
  gen.rangeFrom = gen.rangeFrom || isoDaysAgo(30);
  gen.rangeTo = gen.rangeTo || isoDaysAgo(0);
  genOpen.value = true;
}

const canGenerate = computed(
  () =>
    !genBusy.value &&
    gen.projectId !== '' &&
    gen.branch !== '' &&
    gen.rangeFrom !== '' &&
    gen.rangeTo !== '',
);

// Honest waiting: a generation legitimately runs for tens of seconds (the model may read
// the code behind vague commits), and a frozen button label reads as a hang.
const genLabel = computed(() => {
  if (!genBusy.value) return 'Згенерувати';
  return genSec.value < 3 ? 'Генеруємо…' : `Генеруємо… ${genSec.value} с`;
});

async function generate(): Promise<void> {
  if (!canGenerate.value) return;
  genBusy.value = true;
  genError.value = '';
  genSec.value = 0;
  const startedAt = Date.now();
  const timer = setInterval(() => (genSec.value = Math.round((Date.now() - startedAt) / 1000)), 1000);
  try {
    const reply = await api.generateReleaseNotes({
      projectId: gen.projectId,
      workspaceName: props.workspaceName,
      branch: gen.branch,
      rangeFrom: gen.rangeFrom,
      rangeTo: gen.rangeTo,
    });
    // The document exists only in this browser until this line lands it in the workspace —
    // which is the section's promise, so a failed save keeps the modal open and the error
    // names the reason rather than quietly dropping a note that cost a model turn.
    const projectName =
      projects.projects.find((p) => p.id === gen.projectId)?.name ?? gen.projectId;
    const created = await store.create(props.workspaceId, {
      projectId: gen.projectId,
      projectName,
      branch: gen.branch,
      rangeFrom: gen.rangeFrom,
      rangeTo: gen.rangeTo,
      title: reply.title,
      bodyMd: reply.markdown,
    });
    genOpen.value = false;
    openNote(created);
    local.notify(`Реліз-ноти згенеровано з ${reply.commitCount} комітів`);
  } catch (e) {
    genError.value = e instanceof Error ? e.message : String(e);
  } finally {
    clearInterval(timer);
    genBusy.value = false;
  }
}

// ── One note ─────────────────────────────────────────────────────────────────

const current = ref<WorkspaceReleaseNote | undefined>(undefined);
const editing = ref(false);
const saving = ref(false);
const editError = ref('');
const copied = ref(false);
const draftTitle = ref('');
const draftBody = ref('');

function openNote(n: WorkspaceReleaseNote): void {
  current.value = n;
  editing.value = false;
  copied.value = false;
}

function closeNote(): void {
  current.value = undefined;
  editing.value = false;
}

async function copy(): Promise<void> {
  if (!current.value) return;
  try {
    await navigator.clipboard.writeText(current.value.bodyMd);
    // Feedback on the button itself — the cursor is already there — then the label returns
    // so the button never permanently claims a clipboard it may no longer hold.
    copied.value = true;
    setTimeout(() => (copied.value = false), 2000);
  } catch (e) {
    local.notify(e instanceof Error ? e.message : String(e), 'error');
  }
}

function startEdit(): void {
  if (!current.value) return;
  draftTitle.value = current.value.title;
  draftBody.value = current.value.bodyMd;
  editError.value = '';
  editing.value = true;
}

function cancelEdit(): void {
  editing.value = false;
  editError.value = '';
}

async function saveEdit(): Promise<void> {
  const note = current.value;
  if (!note) return;
  saving.value = true;
  editError.value = '';
  try {
    current.value = await store.save(props.workspaceId, note.id, {
      title: draftTitle.value.trim(),
      bodyMd: draftBody.value,
    });
    editing.value = false;
  } catch (e) {
    // The document stays in the fields: a refused write must not cost the rewrite.
    editError.value = e instanceof Error ? e.message : String(e);
  } finally {
    saving.value = false;
  }
}
</script>

<style scoped lang="scss">
.rel {
  display: flex;
  flex-direction: column;
  gap: var(--k-sp-4);
  // A comfortable reading measure, unlike the full-width register: a note row carries a
  // sentence, not thirteen facts.
  width: 100%;
  max-width: 960px;
  padding: var(--k-sp-3) 0;
}

.rel__lead {
  margin: 0;
  font-family: var(--k-font-ui);
  font-size: var(--k-fs-base);
  line-height: 1.5;
  color: var(--k-muted);
}

.rel__lead-workspace {
  color: var(--k-text);
}

.rel__toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--k-sp-3);
}

.rel__count {
  font-size: var(--k-fs-xs);
  color: var(--k-faint);
}

.rel__error {
  margin: 0;
  font-size: var(--k-fs-sm);
  color: var(--k-danger);
}

.rel__blank {
  display: flex;
  flex-direction: column;
  gap: var(--k-sp-2);
  padding: var(--k-sp-5) var(--k-sp-4);
  border: var(--k-rule-thin) dashed var(--k-line);
  border-radius: var(--k-r-lg);
}

.rel__blank-eyebrow {
  font-size: 10px;
  letter-spacing: 0.12em;
  color: var(--k-faint);
}

.rel__blank-text {
  margin: 0;
  max-width: 560px;
  font-size: var(--k-fs-sm);
  line-height: 1.55;
  color: var(--k-muted);
}

.rel__list {
  display: flex;
  flex-direction: column;
  gap: var(--k-sp-2);
  margin: 0;
  padding: 0;
  list-style: none;
}

.rel__row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--k-sp-3);
  padding: var(--k-sp-3);
  background: color-mix(in srgb, var(--k-surface2) 40%, transparent);
  border: var(--k-rule-thin) solid var(--k-line);
  border-radius: var(--k-r-lg);
  cursor: pointer;
  transition: border-color 120ms ease;

  &:hover {
    border-color: color-mix(in srgb, var(--k-accent) 45%, var(--k-line));
  }
}

.rel__row-main {
  display: flex;
  flex-direction: column;
  gap: var(--k-sp-1);
  min-width: 0;
}

.rel__row-title {
  font-family: var(--k-font-ui);
  font-size: var(--k-fs-base);
  font-weight: 650;
  color: var(--k-text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.rel__row-meta {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--k-sp-1);
}

.rel__row-range {
  font-size: var(--k-fs-xs);
  color: var(--k-muted);
}

.rel__row-when {
  flex-shrink: 0;
  font-size: var(--k-fs-xs);
  color: var(--k-faint);
}

// ── Generation form ───────────────────────────────────────────────────────────

.rel__form {
  display: flex;
  flex-direction: column;
  gap: var(--k-sp-3);
}

.rel__form-row {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: var(--k-sp-3);
}

.rel__form-range {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: var(--k-sp-2);
}

.rel__form-hint {
  margin: 0;
  font-size: var(--k-fs-xs);
  line-height: 1.5;
  color: var(--k-faint);
}

.rel__form-error {
  margin: 0;
  font-size: var(--k-fs-sm);
  color: var(--k-danger);
}

// ── One note ──────────────────────────────────────────────────────────────────

.rel__doc {
  display: flex;
  flex-direction: column;
  gap: var(--k-sp-3);
}

.rel__doc-meta {
  display: flex;
  flex-wrap: wrap;
  gap: var(--k-sp-1);
}

.rel__doc-audit {
  margin: 0;
  padding-top: var(--k-sp-2);
  border-top: var(--k-rule-thin) solid var(--k-line);
  font-size: var(--k-fs-xs);
  color: var(--k-faint);
}

.rel__edit {
  display: flex;
  flex-direction: column;
  gap: var(--k-sp-3);
}
</style>
