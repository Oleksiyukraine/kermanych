<template>
  <main class="board">
    <header class="board__head">
      <div class="board__title">
        <h1 class="board__heading">Дошка команди</h1>
        <span class="board__count mono">{{ visibleTasks.length }} задач</span>
      </div>
      <div class="board__controls">
        <KSelect v-model="projectFilter" :options="projectNames" placeholder="Усі проєкти" />
        <KBtn variant="primary" :disabled="!cloud.projects.length" @click="openCreate">Нова задача</KBtn>
      </div>
    </header>

    <p v-if="loadHint" class="board__hint mono">{{ loadHint }}</p>
    <p v-if="orphanCount" class="board__hint mono">
      Локальних проєктів поза хмарою: {{ orphanCount }} — дошка їх не показує.
    </p>

    <div v-if="cloud.projects.length" class="board__columns">
      <section v-for="col in COLUMNS" :key="col.key" class="board__column">
        <header class="board__column-head">
          <span class="board__column-title">{{ col.label }}</span>
          <span class="board__column-count mono">{{ byColumn[col.key]?.length ?? 0 }}</span>
        </header>

        <div class="board__column-body">
          <article v-for="task in byColumn[col.key]" :key="task.id" class="board__card">
            <header class="board__card-head">
              <KStatusDot :status="task.status" />
              <span class="board__card-title">{{ task.title }}</span>
            </header>

            <p v-if="task.description" class="board__card-desc">{{ task.description }}</p>

            <div class="board__card-tags">
              <KTag v-if="!projectFilter">{{ projectName(task.projectId) }}</KTag>
              <KTag v-if="task.model">{{ task.model }}</KTag>
              <KTag v-if="task.prefix">{{ task.prefix }}</KTag>
              <KTag v-if="task.platform">{{ task.platform }}</KTag>
              <KTag v-if="task.branch">⑂ {{ task.branch }}</KTag>
            </div>

            <div class="board__card-assignee">
              <img v-if="avatarOf(task)" :src="avatarOf(task)" class="board__avatar" alt="" />
              <KSelect
                :model-value="handleOfAssignee(task)"
                :options="memberHandles(task.projectId)"
                placeholder="не призначено"
                :disabled="isActiveTask(task)"
                @update:model-value="(handle: string) => onAssign(task, handle)"
              />
            </div>

            <footer class="board__card-foot">
              <span class="board__card-age mono">оновлено {{ relativeTime(task.updatedAt, now) }}</span>
              <span class="board__spacer"></span>
              <KBtn variant="ghost" @click="openEdit(task)">Змінити</KBtn>
              <KBtn variant="ghost" @click="onDelete(task)">Видалити</KBtn>
              <KBtn
                variant="primary"
                :disabled="launching !== null"
                :title="isBound(task) ? 'Запустити локальну сесію' : 'Проєкт не звʼязано з локальною текою — вкажи її'"
                @click="launch(task)"
              >Запустити</KBtn>
            </footer>
          </article>

          <p v-if="!byColumn[col.key]?.length" class="board__column-empty mono">—</p>
        </div>
      </section>
    </div>

    <div v-else class="board__blank">
      <div class="board__blank-eyebrow mono">КЕРМАНИЧ</div>
      <p class="board__blank-text">
        Ви ще не в жодному проєкті. Створіть проєкт або попросіть колегу додати вас до свого.
      </p>
    </div>

    <!-- CREATE / EDIT TASK — same launch vocabulary as the local launcher -->
    <KModal v-model="editorOpen" :title="editingId ? 'Змінити задачу' : 'Нова задача'" width="720px">
      <template #head-meta>
        <span class="board__esc mono">Esc — закрити</span>
      </template>

      <div class="board__form">
        <KSelect
          v-if="!editingId"
          v-model="draftProject"
          label="Проєкт"
          :options="projectNames"
          placeholder="виберіть проєкт"
        />
        <KField v-model="draftTitle" label="Назва задачі" placeholder="що саме треба зробити" />
        <KField
          v-model="draftDescription"
          label="Опис"
          placeholder="Один абзац — далі агент поставить уточнення."
          multiline
          :rows="6"
        />
        <div class="board__form-row">
          <KSelect v-model="draftModel" label="Модель" :options="MODEL_OPTIONS" placeholder="за замовчуванням" />
          <KSelect v-model="draftPrefix" label="Тип" :options="PREFIX_OPTIONS" placeholder="feature" />
          <KSelect
            v-model="draftPlatform"
            label="Платформа"
            :options="PLATFORM_OPTIONS"
            placeholder="необовʼязково"
          />
        </div>
        <KField v-model="draftBranch" label="Базова гілка" placeholder="за замовчуванням проєкту" />
        <p v-if="editorError" class="board__error" role="alert">{{ editorError }}</p>
      </div>

      <template #controls>
        <KBtn variant="ghost" @click="editorOpen = false">Скасувати</KBtn>
        <KBtn variant="primary" :disabled="!canSubmit" @click="submitEditor">
          {{ editingId ? 'Зберегти' : 'Створити' }}
        </KBtn>
      </template>
    </KModal>

    <!-- LOCAL BINDING: a cloud task only runs where its repo actually lives -->
    <KModal v-model="bindingOpen" title="Звʼязати проєкт з локальною текою">
      <div class="board__bind">
        <p class="board__bind-note">
          Задача «{{ pendingLaunch?.title ?? '' }}» виконується на цій машині. Вкажи локальний
          git-репозиторій проєкту «{{ bindingProjectId ? projectName(bindingProjectId) : '' }}» —
          шлях лишається лише тут і в хмару не потрапляє.
        </p>
        <KField v-model="bindingPath" label="Локальна тека" placeholder="/Users/me/code/project" />
        <KBtn variant="secondary" @click="pickerOpen = true">Обрати теку…</KBtn>
        <p v-if="bindingError" class="board__bind-error" role="alert">{{ bindingError }}</p>
      </div>
      <template #controls>
        <KBtn variant="ghost" @click="bindingOpen = false">Скасувати</KBtn>
        <KBtn variant="primary" :disabled="!bindingPath.trim()" @click="confirmBinding">
          Звʼязати і запустити
        </KBtn>
      </template>
    </KModal>
    <KDirPicker v-model="pickerOpen" :start="bindingPath" @select="bindingPath = $event" />
  </main>
</template>

<script setup lang="ts">
// The shared cloud board (design deviation D6): a NEW page with status columns, kept apart
// from WorkspacePage's LOCAL session table. Cards are cloud tasks; execution still happens
// on the assignee's own machine, which is why «Запустити» needs a local binding.
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import type { ProjectMember, Task, TaskStatus } from '@kermanych/cloud';
import { ACTIVE_STATUSES } from '@kermanych/core/status';
import { useBoard } from 'stores/board';
import { useProjects } from 'stores/projects';
import { useOrchestrator } from 'stores/orchestrator';
import KBtn from 'components/kit/KBtn.vue';
import KField from 'components/kit/KField.vue';
import KModal from 'components/kit/KModal.vue';
import KSelect from 'components/kit/KSelect.vue';
import KStatusDot from 'components/kit/KStatusDot.vue';
import KTag from 'components/kit/KTag.vue';
import KDirPicker from 'components/kit/KDirPicker.vue';
import { useNow } from '../composables/useNow';
import { relativeTime } from '../lib/time';
import { api } from '../lib/api';

const board = useBoard();
const cloud = useProjects();
const local = useOrchestrator();
const now = useNow();
const router = useRouter();

// Ten task statuses, five columns: `thinking` and `tool` are one human state («агент
// працює»), and the five end states are all «не рухається». Ten lanes would be ten
// mostly-empty columns.
type Column = { key: string; label: string; statuses: TaskStatus[] };
const COLUMNS: Column[] = [
  { key: 'backlog', label: 'Беклог', statuses: ['backlog'] },
  { key: 'queued', label: 'У черзі', statuses: ['queued'] },
  { key: 'running', label: 'В роботі', statuses: ['thinking', 'tool'] },
  { key: 'waiting', label: 'Чекає відповіді', statuses: ['waiting_input'] },
  { key: 'closed', label: 'Завершені', statuses: ['done', 'merged', 'stopped', 'error', 'conflict'] },
];

// subscribe() refetches then opens the channel; leaving the page closes it, so Realtime
// traffic is scoped to the screen that shows it. The task list survives in the store, which
// is what lets WorkspacePage name a session's task without subscribing.
//
// The FIRST subscribe is the page's job. The store's project-set watcher deliberately only
// REBUILDS a channel that already exists ("before the board mounts there is nothing to
// rebuild"), so a board opened by a user with no cloud project yet would otherwise stay
// silent — no Realtime, no reconcile timer — even after a project arrives from the rail.
//
// `opening` is component-local and not reactive: the project list growing BECAUSE of
// open()'s own load is not a project arriving, and must not queue a second subscribe on top
// of the one already building. The in-flight subscribe reads the project set after that
// load, so it already covers those projects.
let opening = false;

async function open(): Promise<void> {
  opening = true;
  try {
    // Also performs the initial project load, which is why it runs even with an empty
    // project list.
    await board.subscribe();
    await loadMembers();
  } finally {
    opening = false;
  }
}

onMounted(open);
onUnmounted(() => board.unsubscribe());

// 0 → n only: once a channel exists the store rebuilds it on every project-set change, and
// a board that never had one is exactly the case the store skips.
watch(
  () => cloud.projects.length,
  (count, prev) => {
    if (count && !prev && !opening) void open();
  },
);

// Cards show assignees by GitHub handle, which lives in `profiles` and reaches the UI
// through the membership join. One project's failure must not blank the whole board.
async function loadMembers(): Promise<void> {
  for (const p of cloud.projects) {
    try {
      await cloud.loadMembers(p.id);
    } catch {
      /* membership is decoration here; the cards render with raw ids instead */
    }
  }
}

// ── Project scope ─────────────────────────────────────────────────────────────
const projectFilter = ref('');
const projectNames = computed(() => cloud.projects.map((p) => p.name));

function projectName(id: string): string {
  return cloud.projects.find((p) => p.id === id)?.name ?? '—';
}

function projectIdByName(name: string): string | undefined {
  return cloud.projects.find((p) => p.name === name)?.id;
}

const visibleTasks = computed(() => {
  const id = projectFilter.value ? projectIdByName(projectFilter.value) : undefined;
  return id ? board.tasks.filter((t) => t.projectId === id) : board.tasks;
});

const byColumn = computed<Record<string, Task[]>>(() => {
  const out: Record<string, Task[]> = {};
  for (const col of COLUMNS) out[col.key] = visibleTasks.value.filter((t) => col.statuses.includes(t.status));
  return out;
});

const loadHint = computed(() => {
  if (board.loading) return 'Читаю дошку…';
  if (board.loadError) return `Хмара недоступна: ${board.loadError}`;
  return '';
});

// A LOCAL project row whose cloud project is gone (membership revoked, project deleted, or
// a transient RLS-empty read) survives as an orphan so its sessions keep working — the api
// only prunes rows with zero sessions. The board never lists one: every card and every
// project option comes from cloud.projects, so no cloud action can be offered on a project
// this user no longer belongs to. The count is shown so the state is not invisible.
const orphanCount = computed(() => {
  const known = new Set(cloud.projects.map((p) => p.id));
  return local.projects.filter((p) => !known.has(p.id)).length;
});

// ── Assignee ──────────────────────────────────────────────────────────────────
function membersOf(projectId: string): ProjectMember[] {
  return cloud.members[projectId] ?? [];
}

function handleOf(m: ProjectMember): string {
  return m.profile?.githubUsername ?? m.profile?.displayName ?? m.userId;
}

function memberHandles(projectId: string): string[] {
  return membersOf(projectId).map(handleOf);
}

// '' is KSelect's placeholder option. KSelect keeps an unknown current value as an option,
// so a not-yet-loaded membership still renders the raw id instead of silently unassigning.
function handleOfAssignee(task: Task): string {
  if (!task.assigneeId) return '';
  const m = membersOf(task.projectId).find((x) => x.userId === task.assigneeId);
  return m ? handleOf(m) : task.assigneeId;
}

function avatarOf(task: Task): string | undefined {
  return membersOf(task.projectId).find((m) => m.userId === task.assigneeId)?.profile?.avatarUrl;
}

function onAssign(task: Task, handle: string): void {
  const userId = handle ? (membersOf(task.projectId).find((m) => handleOf(m) === handle)?.userId ?? null) : null;
  if (userId === (task.assigneeId ?? null)) return;
  void board.assignTask(task.id, userId);
}

// ── Launch ────────────────────────────────────────────────────────────────────
function isActiveTask(task: Task): boolean {
  return ACTIVE_STATUSES.includes(task.status);
}

// A cloud task runs where its repo actually lives, so a launch needs THIS machine's
// binding: the LOCAL project row's localRepoPath ('' when unbound).
function isBound(task: Task): boolean {
  return !!local.projects.find((p) => p.id === task.projectId)?.localRepoPath;
}

const launching = ref<string | null>(null);
const bindingOpen = ref(false);
const bindingProjectId = ref<string | null>(null);
const bindingPath = ref('');
const bindingError = ref<string | null>(null);
const pickerOpen = ref(false);
const pendingLaunch = ref<Task | null>(null);

// Every refusal `POST /sessions/from-task` can produce, phrased for the person who pressed
// the button. `project not bound` is deliberately absent: it is not a toast, it opens the
// picker — a dead end would leave the user with no way to fix it from here.
const LAUNCH_ERRORS: Record<string, string> = {
  'task not found': 'Задачі вже немає — хтось її видалив. Онови дошку.',
  'task assigned to someone else': 'Задача призначена іншому учаснику — запустити її може лише він.',
  'task already claimed': 'Задачу щойно забрав інший учасник — онови дошку.',
  'not signed in': 'Локальний Керманич не має токена — увійди ще раз.',
};

// The board is a shared surface, so this is a pre-check for UX only: the API re-checks the
// binding and the RLS-backed assignee rule regardless of what the button allowed.
async function launch(task: Task): Promise<void> {
  if (launching.value) return;
  if (!isBound(task)) {
    openBinding(task);
    return;
  }
  await runLaunch(task);
}

async function runLaunch(task: Task): Promise<void> {
  launching.value = task.id;
  try {
    const session = await api.createSessionFromTask(task.id);
    local.notify(`Сесію «${session.name}» запущено на цій машині.`, 'info');
    // The local session lives on the workspace board, so go where the work is.
    await router.push('/');
  } catch (e) {
    // `fetch` itself rejects with a TypeError; every refusal from the api arrives as a
    // plain Error carrying the server's message. That is what separates "the local
    // Kermanych is not answering" from "it answered no".
    if (e instanceof TypeError) {
      local.notify('Локальний Керманич не відповідає — перевір, чи він запущений.', 'error');
      return;
    }
    const message = e instanceof Error ? e.message : String(e);
    if (message === 'project not bound') {
      // Raced with someone unbinding, or the row vanished — offer the picker instead of a toast.
      openBinding(task);
      return;
    }
    local.notify(LAUNCH_ERRORS[message] ?? `Не вдалося запустити задачу: ${message}`, 'error');
  } finally {
    launching.value = null;
  }
}

function openBinding(task: Task): void {
  pendingLaunch.value = task;
  bindingProjectId.value = task.projectId;
  bindingPath.value = local.projects.find((p) => p.id === task.projectId)?.localRepoPath ?? '';
  bindingError.value = null;
  bindingOpen.value = true;
}

async function confirmBinding(): Promise<void> {
  const projectId = bindingProjectId.value;
  const task = pendingLaunch.value;
  if (!projectId || !task) return;
  bindingError.value = null;
  try {
    await api.setProjectBinding(projectId, bindingPath.value.trim());
    bindingOpen.value = false;
    await runLaunch(task);
  } catch (e) {
    bindingError.value = e instanceof Error ? e.message : String(e);
  }
}

// ── Create / edit ─────────────────────────────────────────────────────────────
// Same launch vocabulary as the local launcher (WorkspacePage.vue:658-661), so a task born
// on the board and an agent started by hand offer identical choices.
const MODEL_OPTIONS = ['opus-5', 'sonnet-4.5', 'haiku'];
const PREFIX_OPTIONS = ['feature', 'fix', 'refactoring', 'chore'];
const PLATFORM_OPTIONS = ['backend', 'web', 'mobile'];

const editorOpen = ref(false);
const editingId = ref<string | null>(null);
const editorError = ref<string | null>(null);
const draftProject = ref('');
const draftTitle = ref('');
const draftDescription = ref('');
const draftModel = ref('');
const draftPrefix = ref('');
const draftPlatform = ref('');
const draftBranch = ref('');

// A task always needs a title; a NEW one also needs a project, because `project_id` is what
// the tasks INSERT policy checks membership against.
const canSubmit = computed(
  () => !!draftTitle.value.trim() && (!!editingId.value || !!projectIdByName(draftProject.value)),
);

function openCreate(): void {
  editingId.value = null;
  editorError.value = null;
  // Default to whatever the board is already filtered to — that is the project the user is
  // looking at.
  draftProject.value = projectFilter.value || (cloud.projects[0]?.name ?? '');
  draftTitle.value = '';
  draftDescription.value = '';
  draftModel.value = '';
  draftPrefix.value = '';
  draftPlatform.value = '';
  draftBranch.value = '';
  editorOpen.value = true;
}

function openEdit(task: Task): void {
  editingId.value = task.id;
  editorError.value = null;
  draftProject.value = projectName(task.projectId);
  draftTitle.value = task.title;
  draftDescription.value = task.description ?? '';
  draftModel.value = task.model ?? '';
  draftPrefix.value = task.prefix ?? '';
  draftPlatform.value = task.platform ?? '';
  draftBranch.value = task.branch ?? '';
  editorOpen.value = true;
}

async function submitEditor(): Promise<void> {
  editorError.value = null;
  // Blank strings are meaningful: toTaskRow() turns them into NULL, which is how a user
  // clears a launch param they set earlier. The project is immutable after creation —
  // moving a task between projects would move it between membership sets.
  const fields = {
    title: draftTitle.value.trim(),
    description: draftDescription.value,
    model: draftModel.value,
    prefix: draftPrefix.value,
    platform: draftPlatform.value,
    branch: draftBranch.value,
  };

  // The title is the ONE field nothing downstream defends: `tasks.title` is `text not null`
  // with no non-empty check, and patchTask sends the trimmed value as-is, so a whitespace
  // title would persist and the card would lose its name. `canSubmit` already disables the
  // control; this is the refusal for a submit that arrives anyway (Enter, a stale click).
  if (!fields.title) {
    editorError.value = 'Задача без назви — введіть назву';
    local.notify('Задача без назви — введіть назву', 'error');
    return;
  }

  if (editingId.value) {
    if (!(await board.updateTaskFields(editingId.value, fields))) {
      editorError.value = 'Хмара відмовила — подробиці в повідомленні';
      return;
    }
  } else {
    const projectId = projectIdByName(draftProject.value);
    if (!projectId) {
      editorError.value = 'Виберіть проєкт';
      return;
    }
    if (!(await board.createTask({ projectId, ...fields }))) {
      editorError.value = 'Не вдалося створити задачу — подробиці в повідомленні';
      return;
    }
  }
  editorOpen.value = false;
}

function onDelete(task: Task): void {
  void board.deleteTask(task.id);
}
</script>

<style scoped lang="scss">
.board {
  display: flex;
  flex-direction: column;
  gap: 12px;
  height: 100%;
  min-height: 0;
  padding: 20px 24px;
  background: var(--k-canvas);
}

.board__head {
  display: flex;
  align-items: flex-end;
  gap: 16px;
}

.board__title {
  display: flex;
  align-items: baseline;
  gap: 10px;
}

.board__heading {
  margin: 0;
  font-family: var(--k-font-ui);
  font-size: 20px;
  font-weight: 800;
  letter-spacing: 0.04em;
  color: var(--k-text);
}

.board__count,
.board__hint,
.board__column-count,
.board__column-empty,
.board__card-age {
  font-family: var(--k-font-mono);
  font-size: 11px;
  color: var(--k-muted);
}

.board__controls {
  display: flex;
  align-items: flex-end;
  gap: 8px;
  margin-left: auto;
}

.board__hint {
  margin: 0;
}

.board__columns {
  display: grid;
  grid-template-columns: repeat(5, minmax(220px, 1fr));
  gap: 2px;
  flex: 1;
  min-height: 0;
  overflow-x: auto;
  background: var(--k-line);
}

.board__column {
  display: flex;
  flex-direction: column;
  min-height: 0;
  background: var(--k-bg);
}

.board__column-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 12px;
  border-bottom: 2px solid var(--k-line-strong);
}

.board__column-title {
  font-family: var(--k-font-ui);
  font-size: 12px;
  font-weight: 800;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--k-text);
}

.board__column-count {
  margin-left: auto;
}

.board__column-body {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 2px;
  overflow-y: auto;
}

.board__column-empty {
  padding: 12px;
}

.board__card {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px 12px;
  background: var(--k-surface);
  border: 1px solid var(--k-line);
}

.board__card-head {
  display: flex;
  align-items: center;
  gap: 8px;
}

.board__card-title {
  font-family: var(--k-font-ui);
  font-size: 13px;
  font-weight: 700;
  line-height: 1.4;
  color: var(--k-text);
}

.board__card-desc {
  margin: 0;
  font-family: var(--k-font-ui);
  font-size: 12px;
  line-height: 1.5;
  color: var(--k-muted);
  display: -webkit-box;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.board__card-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}

.board__card-assignee {
  display: flex;
  align-items: center;
  gap: 6px;
}

.board__avatar {
  width: 18px;
  height: 18px;
  border: 1px solid var(--k-line-strong);
  object-fit: cover;
}

.board__card-foot {
  display: flex;
  align-items: center;
  gap: 6px;
  padding-top: 8px;
  border-top: 1px solid var(--k-line);
}

.board__spacer {
  flex: 1;
}

.board__blank {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  flex: 1;
}

.board__blank-eyebrow {
  font-family: var(--k-font-mono);
  font-size: 11px;
  letter-spacing: 0.3em;
  color: var(--k-muted);
}

.board__blank-text {
  margin: 0;
  max-width: 420px;
  text-align: center;
  font-family: var(--k-font-ui);
  font-size: 13px;
  line-height: 1.6;
  color: var(--k-muted);
}

.board__form {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.board__form-row {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 8px;
}

.board__esc {
  font-family: var(--k-font-mono);
  font-size: 11px;
  color: var(--k-muted);
}

.board__error {
  margin: 0;
  font-family: var(--k-font-mono);
  font-size: 12px;
  line-height: 1.5;
  color: var(--k-accent);
}

.board__bind {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.board__bind-note {
  margin: 0;
  font-size: 12px;
  color: var(--k-muted);
}

.board__bind-error {
  margin: 0;
  font-size: 12px;
  // The kit has no `--k-danger`; `--k-accent` is what every other refusal on this page uses.
  color: var(--k-accent);
}
</style>
