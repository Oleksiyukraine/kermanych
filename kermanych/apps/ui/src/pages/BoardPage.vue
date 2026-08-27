<template>
  <main class="board">
    <header class="board__head">
      <div class="board__title">
        <h1 class="board__heading">Дошка команди</h1>
        <span class="board__count mono">{{ visibleTasks.length }} задач</span>
      </div>
      <div class="board__controls">
        <KSelect v-model="projectFilter" :options="projectNames" placeholder="Усі проєкти" />
        <!-- A task row needs a `project_id` the tasks policies can check membership
             against, so with no cloud project there is nothing to create a task on. Say so:
             a grey button with no explanation is what made this look broken. -->
        <KBtn
          variant="primary"
          :disabled="!cloud.projects.length"
          :title="newTaskHint"
          @click="openCreate"
        >Нова задача</KBtn>
      </div>
    </header>

    <p v-if="loadHint" class="board__hint mono">{{ loadHint }}</p>
    <!-- The way out of «дошка порожня, а кнопка сіра». A project that lives only in this
         machine's registry has no cloud row for a task to point at, and nothing else in the
         app can give it one — so every project made before the team cloud (or while
         Supabase was unreachable) used to dead-end here. -->
    <section v-if="unpublished.length" class="board__publish">
      <p class="board__publish-note">
        Ці проєкти є лише на цій машині, тому дошка їх не показує. Публікація віддає проєкт
        команді під тим самим id — прив’язана тека, сесії та їхні робочі дерева залишаються
        на місці.
      </p>
      <div v-for="p in unpublished" :key="p.id" class="board__publish-row">
        <span class="board__publish-name">{{ p.name }}</span>
        <span class="board__publish-path mono">{{ p.localRepoPath || 'не прив’язано' }}</span>
        <KBtn
          variant="primary"
          :disabled="!!publishing"
          :title="`Створити «${p.name}» у хмарі — id, тека й сесії не змінюються`"
          @click="publishProject(p)"
        >{{ publishing === p.id ? 'Публікуємо…' : 'Опублікувати в хмарі' }}</KBtn>
      </div>
      <p v-if="publishError" class="board__error" role="alert">{{ publishError }}</p>
    </section>

    <!-- Two different failures, two different lines: the browser's own channel to the cloud
         (board.offline, computed by the store) and this machine's unsent push queue. -->
    <div v-if="board.offline || outboxPending > 0" class="board__alerts">
      <p v-if="board.offline" class="board__alert board__alert--offline" role="status">
        Немає звʼязку з хмарою — показано останній відомий стан дошки. Локальні сесії працюють як завжди.
      </p>
      <p v-if="outboxPending > 0" class="board__alert board__alert--outbox" role="status">
        Статуси цієї машини ще не відправлені: {{ outboxPending }}. Надішлемо автоматично, щойно зʼявиться звʼязок.
      </p>
    </div>

    <div v-if="cloud.projects.length" class="board__columns">
      <KKanbanColumn
        v-for="col in COLUMNS"
        :key="col.key"
        :label="col.label"
        :count="byColumn[col.key]?.length ?? 0"
      >
        <KKanbanCard
          v-for="task in byColumn[col.key]"
          :key="task.id"
          :title="task.title"
          :branch="task.branch ?? ''"
          :project="projectName(task.projectId)"
          :time="relativeTime(task.updatedAt, now)"
          :status="task.status"
          @click="openEdit(task)"
        />

        <p v-if="!byColumn[col.key]?.length" class="board__column-empty mono">—</p>
      </KKanbanColumn>
    </div>

    <div v-else class="board__blank">
      <div class="board__blank-eyebrow mono">КЕРМАНИЧ</div>
      <p class="board__blank-text">{{ blankText }}</p>
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
        <div v-if="editingTask" class="board__assign">
          <img v-if="avatarOf(editingTask)" :src="avatarOf(editingTask)" class="board__avatar" alt="" />
          <KSelect
            label="Виконавець"
            :model-value="handleOfAssignee(editingTask)"
            :options="memberHandles(editingTask.projectId)"
            placeholder="не призначено"
            :disabled="isActiveTask(editingTask)"
            @update:model-value="(h: string) => onAssign(editingTask!, h)"
          />
        </div>
        <p v-if="editingTask && isStale(editingTask)" class="board__stale-note mono" role="alert">
          ⚠ Давно без змін — машина виконавця, схоже, офлайн.
        </p>
        <p v-if="editorError" class="board__error" role="alert">{{ editorError }}</p>
      </div>

      <template #controls>
        <KBtn v-if="editingTask" variant="ghost" @click="onDelete(editingTask); editorOpen = false">Видалити</KBtn>
        <KBtn
          v-if="editingTask && canForceStop(editingTask)"
          variant="ghost"
          @click="editorOpen = false; openForceStop(editingTask)"
        >Позначити зупиненою</KBtn>
        <KBtn variant="ghost" @click="editorOpen = false">Скасувати</KBtn>
        <KBtn
          v-if="editingTask"
          variant="secondary"
          :disabled="launching !== null || isActiveTask(editingTask)"
          :title="launchHint(editingTask)"
          @click="editorOpen = false; launch(editingTask)"
        >Запустити</KBtn>
        <KBtn variant="primary" :disabled="!canSubmit" @click="submitEditor">{{ editingId ? 'Зберегти' : 'Створити' }}</KBtn>
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

    <!-- STUCK TASK: say plainly what this does and, more importantly, what it does NOT do.
         A user who reads this as «зупинити агента» would walk away believing a session on
         another machine is dead when it may be running fine. -->
    <KModal :model-value="!!forceStopTarget" title="Позначити задачу зупиненою" @update:model-value="closeForceStop">
      <div class="board__force">
        <p class="board__force-note">
          Задача «{{ forceStopTarget?.title ?? '' }}» рахується активною зі статусом
          «{{ forceStopTarget?.status ?? '' }}», але її машина більше не надсилає оновлень.
          Це поверне картку в стан «зупинено», щоб задачу знову можна було запустити,
          переасайнити або видалити.
        </p>
        <p class="board__force-warn">
          Це виправляє лише дошку. Сесію на машині, до якої ви не маєте доступу, воно не
          зупиняє — і якщо та машина ще жива, вона просто надішле свій справжній статус
          знову, і картка повернеться в роботу.
        </p>
      </div>
      <template #controls>
        <KBtn variant="ghost" @click="closeForceStop(false)">Скасувати</KBtn>
        <KBtn variant="primary" :disabled="forcingStop" @click="confirmForceStop">
          Позначити зупиненою
        </KBtn>
      </template>
    </KModal>
    <KDirPicker v-model="pickerOpen" :start="bindingPath" @select="bindingPath = $event" />
  </main>
</template>

<script setup lang="ts">
// The shared cloud board (design deviation D6): a NEW page with status columns, kept apart
// from AgentsPage's LOCAL session table. Cards are cloud tasks; execution still happens
// on the assignee's own machine, which is why «Запустити» needs a local binding.
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import type { Project } from '@kermanych/core';
import type { ProjectMember, Task, TaskStatus } from '@kermanych/cloud';
import { ACTIVE_STATUSES } from '@kermanych/core/status';
import { useAuth } from 'stores/auth';
import { useBoard } from 'stores/board';
import { useProjects } from 'stores/projects';
import { useOrchestrator } from 'stores/orchestrator';
import KBtn from 'components/kit/KBtn.vue';
import KField from 'components/kit/KField.vue';
import KModal from 'components/kit/KModal.vue';
import KSelect from 'components/kit/KSelect.vue';
import KKanbanCard from 'components/kit/KKanbanCard.vue';
import KKanbanColumn from 'components/kit/KKanbanColumn.vue';
import KDirPicker from 'components/kit/KDirPicker.vue';
import { useNow } from '../composables/useNow';
import { useDelayedTrue } from '../composables/useDelayedTrue';
import { relativeTime } from '../lib/time';
import { api } from '../lib/api';
import { installReconcile } from '../lib/reconcile';

const auth = useAuth();
const board = useBoard();
const cloud = useProjects();
const local = useOrchestrator();
const now = useNow();
const router = useRouter();

// Back to the LOCAL board of whatever the rail has selected. The named route, not '/', so
// this stays the same hop the Агенти view's «Дошка команди» button makes in reverse.
function goToAgents(): void {
  void router.push({ name: 'agents' });
}

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
// is what lets AgentsPage name a session's task without subscribing.
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

// 5 s: fast enough that «щойно відправили» feels immediate, slow enough to be a rounding
// error against the local API (one SELECT COUNT-shaped read of a table with at most a few
// rows), and it only ticks while the board is on screen.
const OUTBOX_POLL_MS = 5_000;

// ── Local push queue ──────────────────────────────────────────────────────────
// The local queue is invisible to Supabase: this browser can be perfectly online while
// THIS machine's pushes are stuck (expired token, blocked host). Only the local API knows,
// and only by polling — there is no ServerEvent for it (see cloud.controller.ts).
//
// installReconcile, not a bare setInterval: it already owns the "poll while visible, stop
// while hidden, catch up on return, detach everything on teardown" contract the board's
// task reconcile uses, so a hidden tab costs nothing and unmount leaves no timer.
const outboxPending = ref(0);
let stopOutboxPoll: (() => void) | undefined;

async function refreshOutbox(): Promise<void> {
  try {
    outboxPending.value = (await api.cloudOutbox()).pending;
  } catch {
    // Local API unreachable (Electron still booting, dev server restarting): keep the last
    // known count rather than flashing a false "all clear".
  }
}

onMounted(() => {
  void refreshOutbox();
  stopOutboxPoll = installReconcile(() => void refreshOutbox(), { intervalMs: OUTBOX_POLL_MS });
});
onUnmounted(() => {
  stopOutboxPoll?.();
  stopOutboxPoll = undefined;
});

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

// The read itself takes ~150 ms against a warm cloud, and a hint nobody can read is just a
// flicker in the same spot the offline banner used to blink: say «читаю» only once the wait
// is long enough to be worth explaining. An error is not transient, so it shows at once.
const SLOW_LOAD_MS = 500;
const slowLoad = useDelayedTrue(() => board.loading, SLOW_LOAD_MS);

const loadHint = computed(() => {
  if (slowLoad.value) return 'Читаю дошку…';
  if (board.loadError) return `Хмара недоступна: ${board.loadError}`;
  return '';
});

// ── Local-only projects ───────────────────────────────────────────────────────
// A LOCAL project row with no cloud project behind it. Two ways in, one way out. Either it
// was born before the team cloud existed — the `groups`→`projects` migration renamed the
// table and kept the local uuid, but nothing ever pushed those projects up — or its cloud
// row is gone (membership revoked, project deleted, a transient RLS-empty read) and the row
// survived because the api never prunes one that still owns sessions.
//
// The board still shows no CARD for these: every card and every project option comes from
// cloud.projects, so no cloud action is offered on a project this user does not belong to.
// What it offers is publishing, which is the only control in the app that turns a
// local-only project into one the team can put tasks on.
//
// A FAILED cloud read is excluded, and that guard is load-bearing: `cloud.projects` is then
// an unread list rather than an empty one, every local row would look local-only, and the
// user would be offered a publish the cloud is going to refuse with a duplicate key —
// reported back as «ви не його учасник», about a project they own.
const unpublished = computed(() =>
  cloud.offlineError ? [] : local.projects.filter((p) => !cloud.byId.has(p.id)),
);

// Why «Нова задача» is grey. `tasks.project_id` is what tasks_insert_member checks
// membership against, so with no cloud project there is nothing to hang a task on — and
// «no cloud project» is two different situations, only one of which the user can act on.
const newTaskHint = computed(() => {
  if (cloud.projects.length) return 'Створити задачу для команди';
  return cloud.offlineError
    ? 'Список проєктів не прочитано — хмара недоступна'
    : 'Задача належить проєкту в хмарі, а тут його ще немає — опублікуйте локальний проєкт нижче або попросіть колегу додати вас до свого';
});

// The same three states, spelled out where the board is empty. Telling a user with two
// local projects that they are «не в жодному проєкті» is how this page dead-ended.
const blankText = computed(() => {
  if (cloud.offlineError) {
    return 'Список проєктів не прочитано — хмара недоступна. Задачі команди зʼявляться, щойно буде звʼязок; локальні сесії працюють як завжди.';
  }
  if (unpublished.value.length) {
    return 'Жоден проєкт цієї машини ще не живе у хмарі — опублікуйте будь-який зі списку вище, і його задачі побачить уся команда.';
  }
  return 'Ви ще не в жодному проєкті. Створіть проєкт кнопкою «+» у лівій панелі або попросіть колегу додати вас до свого.';
});

const publishing = ref<string | null>(null);
const publishError = ref<string | null>(null);

async function publishProject(project: Project): Promise<void> {
  if (publishing.value) return;
  publishing.value = project.id;
  publishError.value = null;
  try {
    await cloud.publish(project);
    // Neither watcher that reacts to a longer project list loads MEMBERSHIP: the 0→1 case
    // re-runs open() below, but n→n+1 only rebuilds the store's channel. The assignee
    // picker on every card of the new project needs those rows, so read them here.
    await loadMembers();
    local.notify(`Проєкт «${project.name}» опубліковано — тепер тут можна створювати задачі.`);
  } catch (e) {
    const raw = e instanceof Error ? e.message : String(e);
    // A primary-key collision is the one refusal that means something specific: the cloud
    // row exists and this user simply cannot see it. Publishing again would never help.
    publishError.value = /duplicate key|already exists/i.test(raw)
      ? `Проєкт «${project.name}» уже є в хмарі, але ви не його учасник — попросіть власника додати вас.`
      : `Не вдалося опублікувати «${project.name}»: ${raw}`;
  } finally {
    publishing.value = null;
  }
}

// ── Staleness ─────────────────────────────────────────────────────────────────
// Stale = the card claims to be working, but nothing has moved for a while. There is no
// heartbeat in v1 (spec Non-goals), so the age of `updated_at` is the only signal — and
// because tasks_guard() overwrites it with now() on every push, that age measures time
// since the executing machine last PUSHED, which is exactly the thing that goes quiet.
//
// Only self-driving statuses qualify. `waiting_input` is excluded on purpose: a task
// blocked on its owner's answer is legitimately idle for hours — that is not staleness,
// that is the design (model B1). `backlog` and the five end states are not moving by
// definition, so age says nothing about them either.
const STALE_MS = 90_000;
const SELF_DRIVING: readonly TaskStatus[] = ['queued', 'thinking', 'tool'];

function isStale(task: Task): boolean {
  return SELF_DRIVING.includes(task.status) && now.value - new Date(task.updatedAt).getTime() > STALE_MS;
}

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

// Whether THIS machine is the one running the card. `taskId` is set on every session
// launched from the board, so its absence means the active status was pushed by someone
// else's machine — or by a machine that is no longer pushing anything at all.
function hasLocalSession(task: Task): boolean {
  return local.sessions.some((s) => s.taskId === task.id);
}

// The old text told everyone with a disabled button to «зупини сесію», which on any machine
// but the executing one names a session that does not exist there — leaving the user hunting
// for a stop button they cannot have. Say where the work actually is instead, and point at
// the recovery control when there is one.
function launchHint(task: Task): string {
  if (!isActiveTask(task)) {
    return isBound(task)
      ? 'Запустити локальну сесію'
      : 'Проєкт не звʼязано з локальною текою — вкажи її';
  }
  if (hasLocalSession(task)) {
    return 'Задача вже виконується на цій машині — зупини сесію, щоб запустити її знову';
  }
  return canForceStop(task)
    ? 'Задача виконується — можливо, на іншій машині. Якщо вона там уже не працює, натисни «Позначити зупиненою».'
    : 'Задача виконується на машині виконавця. Зупинити її може лише виконавець або власник проєкту.';
}

// ── Stuck-task recovery ───────────────────────────────────────────────────────
// A task's status is written only by the machine running it and there is no heartbeat (spec
// Non-goals), so a machine that crashes leaves the card active forever — and tasks_guard()
// then refuses to reassign or delete it. Forcing 'stopped' is the way out, and tasks_guard()
// permits exactly two callers: the assignee (from any machine) and the project's owner.
// This mirrors that rule so a third member is never shown a button the cloud would refuse;
// the guard, not this predicate, is the actual gate.
function canForceStop(task: Task): boolean {
  if (!isActiveTask(task)) return false;
  return (!!auth.user && task.assigneeId === auth.user.id) || cloud.isOwner(task.projectId);
}

const forceStopTarget = ref<Task | null>(null);
const forcingStop = ref(false);

function openForceStop(task: Task): void {
  forceStopTarget.value = task;
}

// Also the modal's own update:modelValue handler, so Esc and the backdrop close it the same
// way the cancel button does.
function closeForceStop(open: boolean): void {
  if (!open) forceStopTarget.value = null;
}

async function confirmForceStop(): Promise<void> {
  const task = forceStopTarget.value;
  if (!task || forcingStop.value) return;
  forcingStop.value = true;
  try {
    // Left open on refusal: the store has already toasted why, and closing would throw the
    // user back to a card that still looks stuck with no explanation on screen.
    if (await board.forceStop(task.id)) forceStopTarget.value = null;
  } finally {
    forcingStop.value = false;
  }
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
  'task is already running': 'Задача вже виконується — зупини поточну сесію, перш ніж запускати нову.',
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
    // The local session lives on the Агенти board, so go where the work is.
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
    // Same split as `runLaunch`: a dropped connection is a `TypeError` whose message is the
    // browser's own English text, which has no business inside this modal. Everything else
    // is the api's refusal and is shown as it came.
    if (e instanceof TypeError) {
      bindingError.value = 'Локальний Керманич не відповідає — перевір, чи він запущений.';
      return;
    }
    bindingError.value = e instanceof Error ? e.message : String(e);
  }
}

// ── Create / edit ─────────────────────────────────────────────────────────────
// Same launch vocabulary as the local launcher (AgentsPage.vue:658-661), so a task born
// on the board and an agent started by hand offer identical choices.
const MODEL_OPTIONS = ['opus-5', 'sonnet-4.5', 'haiku'];
const PREFIX_OPTIONS = ['feature', 'fix', 'refactoring', 'chore'];
const PLATFORM_OPTIONS = ['backend', 'web', 'mobile'];

const editorOpen = ref(false);
const editingId = ref<string | null>(null);
const editorError = ref<string | null>(null);
const editingTask = computed(() =>
  editingId.value ? board.tasks.find((t) => t.id === editingId.value) : undefined,
);
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
  height: calc(100vh - 82px);
  min-height: 0;
  padding: var(--k-sp-3);
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
.board__column-empty {
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

// The local-only projects block. Surface2 with an accent rule on the leading edge: it is an
// action the user has to take, not one of the muted status lines above it.
.board__publish {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px 14px;
  background: var(--k-surface2);
  border-left: 2px solid var(--k-accent);
}

.board__publish-note {
  margin: 0;
  max-width: 780px;
  font-family: var(--k-font-ui);
  font-size: 12px;
  line-height: 1.6;
  color: var(--k-muted);
}

.board__publish-row {
  display: flex;
  align-items: center;
  gap: 12px;
}

.board__publish-name {
  font-family: var(--k-font-ui);
  font-size: 13px;
  font-weight: 800;
  color: var(--k-text);
}

// The path is the disambiguator when two local rows share a name, so it must not be the
// thing that pushes the button off the row: it shrinks first and ellipsises.
.board__publish-path {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: var(--k-font-mono);
  font-size: 11px;
  color: var(--k-muted);
}

.board__columns {
  display: grid;
  grid-template-columns: repeat(5, minmax(220px, 1fr));
  grid-auto-rows: 1fr;
  gap: var(--k-sp-4);
  flex: 1;
  min-height: 0;
  overflow-x: auto;
}


.board__column-empty {
  padding: var(--k-sp-3);
}

.board__assign {
  display: flex;
  align-items: center;
  gap: var(--k-sp-2);
}

.board__stale-note {
  font-size: 11.5px;
  color: var(--k-warning);
}

.board__avatar {
  width: 18px;
  height: 18px;
  border: 1px solid var(--k-line-strong);
  object-fit: cover;
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

.board__force {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.board__force-note {
  margin: 0;
  font-size: 13px;
  color: var(--k-text);
}

// The «what this does NOT do» half. Accented and set apart, because a user who skims past
// it walks away believing a session on another machine is dead when it may be running fine.
.board__force-warn {
  margin: 0;
  padding: 8px 10px;
  font-size: 12px;
  background: var(--k-surface2);
  color: var(--k-accent);
}

.board__alerts {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-bottom: 12px;
}

.board__alert {
  margin: 0;
  padding: 6px 10px;
  border-radius: 6px;
  font-size: 12px;
  background: var(--k-surface2);
}

.board__alert--offline {
  color: var(--k-muted);
}

.board__alert--outbox {
  color: var(--k-accent);
}

.board__stale {
  font-size: 11px;
  white-space: nowrap;
  color: var(--k-accent);
}
</style>
