<template>
  <!-- DOCUMENT → CARD — an API request (or handoff) becomes a task on another project's board
       mid-task: the other side's agent starts from the card, this session keeps working. A design
       README becomes the task that implements the screen, with the saved screenshots attached. -->
  <KModal
    :model-value="modelValue"
    :title="t('agents.docTask.title')"
    width="720px"
    :persistent="busy"
    @update:model-value="(v: boolean) => emit('update:modelValue', v)"
  >
    <div class="doc-task">
      <p class="doc-task__hint mono">{{ t('agents.docTask.source', { path }) }}</p>
      <KSelect
        v-model="project"
        :label="t('agents.docTask.project')"
        :options="projectOptions"
        :placeholder="t(screensDir ? 'agents.docTask.projectPlaceholderAny' : 'agents.docTask.projectPlaceholder')"
      />
      <KSkeleton v-if="readPhase === 'skeleton'" variant="line" :label="t('agents.docTask.taskTitle')" />
      <KField v-else v-model="title" :label="t('agents.docTask.taskTitle')" />
      <KSelect
        v-model="assignee"
        :label="t('agents.docTask.assignee')"
        :options="assigneeOptions"
        :placeholder="t('agents.docTask.unassigned')"
        :loading="membersLoading"
      />
      <KSkeleton v-if="readPhase === 'skeleton'" variant="lines" :rows="8" :label="t('agents.docTask.description')" />
      <KField v-else v-model="description" :label="t('agents.docTask.description')" multiline :rows="12" />
      <!-- A design card carries the folder's screenshots, so the implementing agent sees the
           target as images and not only as text. -->
      <div v-if="screensDir" class="doc-task__screens">
        <span class="doc-task__label">{{ t('agents.docTask.screens') }}</span>
        <KSkeleton v-if="screensPhase === 'skeleton'" variant="block" height="72px" :label="t('agents.docTask.screens')" />
        <template v-else-if="screens">
          <p v-if="!screens.length" class="doc-task__hint mono">{{ t('agents.docTask.screensNone', { dir: screensDir }) }}</p>
          <template v-else>
            <p class="doc-task__hint mono">{{ t('agents.docTask.screensCount', { n: screens.length }) }}</p>
            <ul class="doc-task__thumbs">
              <li v-for="s in screens" :key="s.path" class="doc-task__thumb" v-tip="s.path">
                <img :src="s.url" :alt="s.path" />
              </li>
            </ul>
          </template>
        </template>
        <p v-if="screensError" class="doc-task__error" role="alert">{{ t('agents.docTask.screensFailed', { error: screensError }) }}</p>
      </div>
      <p v-if="error" class="doc-task__error" role="alert">{{ error }}</p>
    </div>
    <template #controls>
      <KBtn variant="ghost" :disabled="busy" @click="emit('update:modelValue', false)">{{ t('agents.finish.close') }}</KBtn>
      <KBtn variant="secondary" :disabled="!description.trim()" @click="copy">{{ t('agents.docTask.copy') }}</KBtn>
      <KBtn
        variant="primary"
        :loading="busy"
        :disabled="!title.trim() || !projects.byId.has(project) || screensLoading"
        @click="submit"
      >{{ t('agents.docTask.create') }}</KBtn>
    </template>
  </KModal>
</template>

<script setup lang="ts">
// «Задача з документа»: a document of a running session becomes a card on the board, read from
// the worktree so an uncommitted document can go too.
// - An API request or a handoff goes to ANOTHER project of the same workspace, so the other
//   side's agent starts from it while this session keeps working.
// - A design README (docs/specs/2026-10-29-design-tab.md, «From design to implementation») goes
//   to its own project by default, as web work, with the folder's screenshots as the card's
//   images — widest first, so the agent sees the desktop view before the phone one.
// Which documents, which projects and which platform are lib/doc-task.ts; this is the form.
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { designDirOf, type Session } from '@kermanych/core';
import { useOrchestrator } from 'stores/orchestrator';
import { useProjects } from 'stores/projects';
import { useBoard } from 'stores/board';
import { api } from '../../lib/api';
import { handleOf } from '../../lib/members';
import { docTaskPlatform, docTaskScreensDir, docTaskTargets, docTaskTitle } from '../../lib/doc-task';
import { readDesignScreens } from '../../lib/design-screens';
import { errorText } from '../../composables/useAsyncAction';
import { useLoadPhase } from '../../composables/useLoadPhase';
import KModal from 'components/kit/KModal.vue';
import KSelect, { type KSelectOption } from 'components/kit/KSelect.vue';
import KField from 'components/kit/KField.vue';
import KBtn from 'components/kit/KBtn.vue';
import KSkeleton from 'components/kit/KSkeleton.vue';

const props = defineProps<{ modelValue: boolean; session: Session | null; path: string }>();
const emit = defineEmits<{ 'update:modelValue': [value: boolean] }>();

const { t } = useI18n();
const store = useOrchestrator();
const projects = useProjects();
const board = useBoard();

const project = ref('');
const title = ref('');
const assignee = ref('');
const description = ref('');
const error = ref<string | null>(null);
const busy = ref(false);
// The document text, the workspace's members and a design's screenshots are read after the
// dialog opens; until they answer the title/description are skeletons, the assignee picker
// spins and the screenshot strip is a skeleton. `screens` stays undefined until the listing
// answers, so «no screenshots yet» never shows while they are still being read.
const reading = ref(false);
const membersLoading = ref(false);
const screensLoading = ref(false);
const screens = ref<{ path: string; file: File; url: string }[] | undefined>(undefined);
const screensError = ref<string | null>(null);
const readPhase = useLoadPhase(() => reading.value);
const screensPhase = useLoadPhase(() => screensLoading.value);

const home = computed(() => projects.byId.get(props.session?.projectId ?? ''));
const screensDir = computed(() => docTaskScreensDir(props.path));
const projectOptions = computed<KSelectOption[]>(() =>
  home.value ? docTaskTargets(projects.projects, home.value, props.path).map((p) => ({ value: p.id, label: p.name })) : [],
);
const assigneeOptions = computed<KSelectOption[]>(() =>
  (projects.members[home.value?.workspaceId ?? ''] ?? []).map((m) => ({ value: m.userId, label: handleOf(m) })),
);

// Every open is a fresh read of (session, path); a late reply for an earlier one is dropped.
let generation = 0;

function dropScreens(): void {
  for (const s of screens.value ?? []) URL.revokeObjectURL(s.url);
  screens.value = undefined;
}

watch(
  () => [props.modelValue, props.session?.id, props.path] as const,
  ([open]) => {
    generation += 1;
    if (open) void load(generation);
  },
  { immediate: true },
);
onBeforeUnmount(() => {
  generation += 1;
  dropScreens();
});

async function load(gen: number): Promise<void> {
  const s = props.session;
  const path = props.path;
  const h = home.value;
  if (!s || !h) {
    store.notify(t('agents.docTask.notCloud'), 'error');
    emit('update:modelValue', false);
    return;
  }
  project.value = projectOptions.value[0]?.value ?? '';
  title.value = '';
  assignee.value = '';
  description.value = '';
  error.value = null;
  busy.value = false;
  dropScreens();
  screensError.value = null;
  // A reply dropped for an earlier open never cleared its flag; this open owns them now.
  screensLoading.value = false;
  reading.value = false;
  if (!projects.members[h.workspaceId]) {
    membersLoading.value = true;
    void projects
      .loadMembers(h.workspaceId)
      .catch(() => undefined)
      .finally(() => { membersLoading.value = false; });
  }
  if (screensDir.value) void loadScreens(gen, s.id, designDirOf(path)!);
  reading.value = true;
  try {
    const file = await api.sessionFile(s.id, path);
    if (gen !== generation) return;
    if (file.binary || file.truncated) {
      error.value = t('agents.docTask.unreadable');
      return;
    }
    title.value = docTaskTitle(path, file.content);
    description.value = `${t('agents.docTask.origin', { project: h.name, branch: s.branch, path })}\n\n${file.content.trim()}\n`;
  } catch (e) {
    if (gen === generation) error.value = errorText(e);
  } finally {
    if (gen === generation) reading.value = false;
  }
}

// The design folder's screenshots, read as files the card upload takes, each with an object
// URL for its thumbnail.
async function loadScreens(gen: number, sessionId: string, designDir: string): Promise<void> {
  screensLoading.value = true;
  try {
    const read = await readDesignScreens(sessionId, designDir);
    if (gen !== generation) return;
    screens.value = read.map((s) => ({ ...s, url: URL.createObjectURL(s.file) }));
  } catch (e) {
    if (gen === generation) screensError.value = errorText(e);
  } finally {
    if (gen === generation) screensLoading.value = false;
  }
}

async function copy(): Promise<void> {
  try {
    await navigator.clipboard.writeText(description.value);
    store.notify(t('agents.docTask.copied'), 'info');
  } catch (e) {
    store.notify(errorText(e), 'error');
  }
}

// A card like the board's own «Нова задача»: the target project's default model and effort,
// unassigned unless picked. The platform comes from the document when it decides one.
async function submit(): Promise<void> {
  const target = projects.byId.get(project.value);
  const name = title.value.trim();
  if (!target || !name || busy.value) return;
  const platform = docTaskPlatform(props.path);
  busy.value = true;
  error.value = null;
  try {
    const card = await board.createTask(
      {
        projectId: target.id,
        title: name,
        description: description.value,
        prefix: 'feature',
        worktree: true,
        ...(platform ? { platform } : {}),
        ...(target.defaultModel ? { model: target.defaultModel } : {}),
        ...(target.defaultEffort ? { effort: target.defaultEffort } : {}),
        ...(assignee.value ? { assigneeId: assignee.value } : {}),
      },
      (screens.value ?? []).map((s) => s.file),
    );
    if (!card) return; // the store has already said why
    emit('update:modelValue', false);
    store.notify(t('agents.docTask.created', { title: name, project: target.name }), 'info');
  } finally {
    busy.value = false;
  }
}
</script>

<style scoped lang="scss">
.doc-task {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.doc-task__hint {
  margin: 0;
  font-size: 11px;
  line-height: 1.5;
  color: var(--k-muted);
}

.doc-task__error {
  margin: 0;
  font-size: 12.5px;
  line-height: 1.5;
  color: var(--k-accent);
}

.doc-task__screens {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.doc-task__label {
  font-size: var(--k-fs-xs);
  color: var(--k-muted);
}

.doc-task__thumbs {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.doc-task__thumb {
  height: 72px;
  border: 1px solid var(--k-line);
  border-radius: var(--k-r-sm);
  overflow: hidden;

  img {
    display: block;
    height: 100%;
    width: auto;
  }
}
</style>
