<template>
  <main class="board">
    <header class="board__head">
      <div class="board__title">
        <h1 class="board__heading">{{ scopeHeading }}</h1>
        <span class="board__count mono">{{ t('board.header.count', { n: visibleTasks.length }) }}</span>
      </div>
      <div class="board__controls">
        <KSelect v-model="projectFilter" :options="projectOptions" :placeholder="t('board.filter.allProjects')" />
        <KSelect v-model="assigneeFilter" :options="assigneeOptions" :placeholder="t('board.filter.allAssignees')" />
        <!-- A task row needs a `project_id` the tasks policies can check membership
             against, so with no project IN SCOPE there is nothing to create a task on.
             Say so: a grey button with no explanation is what made this look broken. -->
        <KBtn
          variant="primary"
          :disabled="!projectOptions.length"
          :title="newTaskHint"
          @click="openCreate"
        >{{ t('board.header.newTask') }}</KBtn>
      </div>
    </header>

    <p v-if="loadHint" class="board__hint mono">{{ loadHint }}</p>
    <!-- Five empty columns under a «Дошка команди» heading read as breakage, so a scope
         that is legitimately empty names itself. -->
    <p v-if="localOnlyHint" class="board__hint mono">{{ localOnlyHint }}</p>
    <!-- The way out of «дошка порожня, а кнопка сіра». A project that lives only in this
         machine's registry has no cloud row for a task to point at, and nothing else in the
         app can give it one — so every project made before the team cloud (or while
         Supabase was unreachable) used to dead-end here. -->
    <section v-if="unpublished.length" class="board__publish">
      <p class="board__publish-note">
        {{ t('board.publish.note') }}
      </p>
      <!-- `cloud.workspaces` is authoritative here rather than merely empty: this whole
           section renders only once `unpublished` is non-empty, and that list is gated on
           the cloud read having answered — workspaces and projects arrive in the same
           Promise.all. Without that, an unread list reads as «you have no workspace». -->
      <p v-if="!cloud.workspaces.length" class="board__publish-note">
        {{ t('board.publish.needWorkspace') }}
      </p>
      <div v-for="p in unpublished" :key="p.id" class="board__publish-row">
        <span class="board__publish-name">{{ p.name }}</span>
        <span class="board__publish-path mono">{{ p.localRepoPath || t('board.publish.unbound') }}</span>
        <!-- Not v-model: an untouched row has NO key in `publishInto`, and passing that
             `undefined` through as the model value is exactly what
             exactOptionalPropertyTypes refuses. '' is the placeholder, i.e. "not chosen". -->
        <KSelect
          :model-value="publishInto[p.id] ?? ''"
          :options="workspaceOptions"
          :placeholder="t('board.publish.pickWorkspace')"
          @update:model-value="(id: string) => (publishInto[p.id] = id)"
        />
        <KBtn
          variant="primary"
          :disabled="!!publishing || !publishInto[p.id]"
          :title="t('board.publish.createTip', { name: p.name })"
          @click="publishProject(p)"
        >{{ publishing === p.id ? t('board.publish.publishing') : t('board.publish.publish') }}</KBtn>
      </div>
      <p v-if="publishError" class="board__error" role="alert">{{ publishError }}</p>
    </section>

    <!-- Two different failures, two different lines: the browser's own channel to the cloud
         (board.offline, computed by the store) and this machine's unsent push queue. -->
    <div v-if="board.offline || outboxPending > 0" class="board__alerts">
      <p v-if="board.offline" class="board__alert board__alert--offline" role="status">
        {{ t('board.alert.offline') }}
      </p>
      <p v-if="outboxPending > 0" class="board__alert board__alert--outbox" role="status">
        {{ t('board.alert.outbox', { n: outboxPending }) }}
      </p>
    </div>

    <div v-if="cloud.projects.length" class="board__columns">
      <KKanbanColumn
        v-for="col in COLUMNS"
        :key="col.key"
        :label="t(col.labelKey)"
        :count="byColumn[col.key]?.length ?? 0"
      >
        <KKanbanCard
          v-for="task in byColumn[col.key]"
          :key="task.id"
          :title="task.title"
          :branch="task.branch ?? ''"
          :project="projectName(task.projectId)"
          :time="renderTime(t, relativeTime(task.updatedAt, now))"
          :status="task.status"
          :assignee="resolveAssignee(task.assigneeId, membersOf(task.projectId))"
          @click="openEdit(task)"
        />

        <p v-if="!byColumn[col.key]?.length" class="board__column-empty mono">—</p>
      </KKanbanColumn>
    </div>

    <div v-else class="board__blank">
      <div class="board__blank-eyebrow mono">{{ t('board.blank.eyebrow') }}</div>
      <p class="board__blank-text">{{ blankText }}</p>
    </div>

    <!-- CREATE / EDIT TASK — same launch vocabulary as the local launcher -->
    <KModal v-model="editorOpen" :title="editingId ? t('board.editor.editTitle') : t('board.editor.createTitle')" width="720px">
      <template #head-meta>
        <span class="board__esc mono">{{ t('board.editor.esc') }}</span>
      </template>

      <div class="board__form">
        <KSelect
          v-if="!editingId"
          v-model="draftProject"
          :label="t('board.editor.project')"
          :options="projectOptions"
          :placeholder="t('board.editor.projectPlaceholder')"
        />
        <KField v-model="draftTitle" :label="t('board.editor.title')" :placeholder="t('board.editor.titlePlaceholder')" />
        <KField
          v-model="draftDescription"
          :label="t('board.editor.description')"
          :placeholder="t('board.editor.descriptionPlaceholder')"
          multiline
          :rows="6"
        />
        <div class="board__form-row">
          <!-- `searchable` on the model picker only: same ~26-row catalog as the local
               launcher's, and the same reason typing beats scrolling it. -->
          <KSelect
            v-model="draftModel"
            :label="t('board.editor.model')"
            :options="modelPickOptions"
            :placeholder="t('board.editor.default')"
            searchable
          />
          <KSelect v-model="draftEffort" :label="t('board.editor.effort')" :options="effortPickOptions" :placeholder="t('board.editor.default')" />
          <KSelect v-model="draftPrefix" :label="t('board.editor.prefix')" :options="PREFIX_OPTIONS" placeholder="feature" />
          <KSelect
            v-model="draftPlatform"
            :label="t('board.editor.platform')"
            :options="PLATFORM_OPTIONS"
            :placeholder="t('board.editor.platformPlaceholder')"
          />
        </div>
        <KField v-model="draftBranch" :label="t('board.editor.branch')" :placeholder="t('board.editor.branchPlaceholder')" />
        <!-- The label is hoisted OUT of KSelect so the avatar can be centred on the
             control itself: inside the component the label and the input are one column,
             and centring the face on that column parks it in the gap between them. -->
        <div v-if="editingTask" class="board__assign">
          <span class="board__assign-label">{{ t('board.editor.assignee') }}</span>
          <div class="board__assign-row">
            <KAvatar
              :name="editingAssignee?.name ?? t('board.editor.unassignedName')"
              :avatar-url="editingAssignee?.avatarUrl"
              :empty="!editingAssignee"
              :size="26"
            />
            <KSelect
              :model-value="editingTask.assigneeId ?? ''"
              :options="editorAssigneeOptions"
              :placeholder="t('board.editor.unassigned')"
              :disabled="isActiveTask(editingTask) || !canAssign(editingTask)"
              @update:model-value="(id: string) => onAssign(editingTask!, id)"
            />
          </div>
        </div>
        <!-- Creating: nobody holds the card yet, so tasks_guard has nobody to protect it
             from — any member may name any member, and «не призначено» stays the default. -->
        <div v-else-if="!editingId" class="board__assign">
          <KSelect
            v-model="draftAssignee"
            :label="t('board.editor.assignee')"
            :options="editorAssigneeOptions"
            :placeholder="t('board.editor.unassigned')"
          />
        </div>
        <p v-if="editingTask && isStale(editingTask)" class="board__stale-note mono" role="alert">
          {{ t('board.editor.staleNote') }}
        </p>
        <p v-if="editorError" class="board__error" role="alert">{{ editorError }}</p>
      </div>

      <template #controls>
        <KBtn v-if="editingTask" variant="ghost" @click="onDelete(editingTask); editorOpen = false">{{ t('board.editor.delete') }}</KBtn>
        <KBtn
          v-if="editingTask && canForceStop(editingTask)"
          variant="ghost"
          @click="editorOpen = false; openForceStop(editingTask)"
        >{{ t('board.forceStop.mark') }}</KBtn>
        <KBtn variant="ghost" @click="editorOpen = false">{{ t('board.action.cancel') }}</KBtn>
        <KBtn
          v-if="editingTask"
          variant="secondary"
          :disabled="launching !== null || isActiveTask(editingTask) || !canRun(editingTask)"
          :title="launchHint(editingTask)"
          @click="editorOpen = false; launch(editingTask)"
        >{{ t('board.editor.launch') }}</KBtn>
        <KBtn variant="primary" :disabled="!canSubmit" @click="submitEditor">{{ editingId ? t('board.editor.save') : t('board.editor.create') }}</KBtn>
      </template>
    </KModal>

    <!-- LOCAL BINDING: a cloud task only runs where its repo actually lives -->
    <KModal v-model="bindingOpen" :title="t('board.binding.title')">
      <div class="board__bind">
        <p class="board__bind-note">
          {{ t('board.binding.note', { title: pendingLaunch?.title ?? '', project: bindingProjectId ? projectName(bindingProjectId) : '' }) }}
        </p>
        <KField v-model="bindingPath" :label="t('board.binding.pathLabel')" placeholder="/Users/me/code/project" />
        <KBtn variant="secondary" @click="pickerOpen = true">{{ t('board.binding.pick') }}</KBtn>
        <p v-if="bindingError" class="board__bind-error" role="alert">{{ bindingError }}</p>
      </div>
      <template #controls>
        <KBtn variant="ghost" @click="bindingOpen = false">{{ t('board.action.cancel') }}</KBtn>
        <KBtn variant="primary" :disabled="!bindingPath.trim()" @click="confirmBinding">
          {{ t('board.binding.confirm') }}
        </KBtn>
      </template>
    </KModal>

    <!-- STUCK TASK: say plainly what this does and, more importantly, what it does NOT do.
         A user who reads this as «зупинити агента» would walk away believing a session on
         another machine is dead when it may be running fine. -->
    <KModal :model-value="!!forceStopTarget" :title="t('board.forceStop.title')" @update:model-value="closeForceStop">
      <div class="board__force">
        <p class="board__force-note">
          {{ t('board.forceStop.note', { title: forceStopTarget?.title ?? '', status: forceStopTarget?.status ?? '' }) }}
        </p>
        <p class="board__force-warn">
          {{ t('board.forceStop.warn') }}
        </p>
      </div>
      <template #controls>
        <KBtn variant="ghost" @click="closeForceStop(false)">{{ t('board.action.cancel') }}</KBtn>
        <KBtn variant="primary" :disabled="forcingStop" @click="confirmForceStop">
          {{ t('board.forceStop.mark') }}
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
import { useI18n } from 'vue-i18n';
import type { Project, ThinkingLevel } from '@kermanych/core';
import type { Task, TaskStatus, WorkspaceMember } from '@kermanych/cloud';
import { ACTIVE_STATUSES } from '@kermanych/core/status';
import { useAuth } from 'stores/auth';
import { useBoard } from 'stores/board';
import { useProjects } from 'stores/projects';
import { useOrchestrator } from 'stores/orchestrator';
import KBtn from 'components/kit/KBtn.vue';
import KField from 'components/kit/KField.vue';
import KModal from 'components/kit/KModal.vue';
import KSelect, { type KSelectOption } from 'components/kit/KSelect.vue';
import KKanbanCard from 'components/kit/KKanbanCard.vue';
import KKanbanColumn from 'components/kit/KKanbanColumn.vue';
import KAvatar from 'components/kit/KAvatar.vue';
import KDirPicker from 'components/kit/KDirPicker.vue';
import { useNow } from '../composables/useNow';
import { useDelayedTrue } from '../composables/useDelayedTrue';
import { relativeTime, renderTime } from '../lib/time';
import { EFFORT_OPTIONS } from '../lib/effort';
import { modelOptions, effortOptions } from '../lib/models';
import { handleOf, resolveAssignee } from '../lib/members';
import { api } from '../lib/api';
import { installReconcile } from '../lib/reconcile';
import { UNASSIGNED, filterTasks, scopedProjectIds } from '../lib/scope';
import { ASSIGNMENT_REFUSALS } from '../lib/cloud-errors';
import { canAssignTask, canRunTask } from '../lib/tasks-view';

const auth = useAuth();
const board = useBoard();
const cloud = useProjects();
const local = useOrchestrator();
const now = useNow();
const router = useRouter();
const { t } = useI18n();

// Back to the LOCAL board of whatever the rail has selected. The named route, not '/', so
// this stays the same hop the Агенти view's «Дошка команди» button makes in reverse.
function goToAgents(): void {
  void router.push({ name: 'agents' });
}

// Ten task statuses, five columns: `thinking` and `tool` are one human state («агент
// працює»), and the five end states are all «не рухається». Ten lanes would be ten
// mostly-empty columns.
type Column = { key: string; labelKey: string; statuses: TaskStatus[] };
const COLUMNS: Column[] = [
  { key: 'backlog', labelKey: 'board.column.backlog', statuses: ['backlog'] },
  { key: 'queued', labelKey: 'board.column.queued', statuses: ['queued'] },
  { key: 'running', labelKey: 'board.column.running', statuses: ['thinking', 'tool'] },
  { key: 'waiting', labelKey: 'board.column.waiting', statuses: ['waiting_input'] },
  { key: 'closed', labelKey: 'board.column.closed', statuses: ['done', 'merged', 'stopped', 'error', 'conflict'] },
];

// The Realtime subscription is NOT this page's any more: MainLayout owns subscribe() and
// unsubscribe(), because «Агенти» and the sidebar count read the same store and it has to
// be live on every route. What is left here is page-local — the workspace member rosters
// the cards name assignees by.
//
// `opening` is component-local and not reactive: a concurrent project load landing while
// open() is still in flight would grow the list under the watcher below and queue a second
// open() on top of the one already running, re-reading the same rosters.
let opening = false;

async function open(): Promise<void> {
  opening = true;
  try {
    // The workspace rosters, not the tasks: the store's own load() owns those.
    await loadMembers();
  } finally {
    opening = false;
  }
}

onMounted(open);

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

// 0 → n only: the rosters' first read, for a page mounted before this user had any cloud
// project. The channel behind those projects is the layout's business now.
watch(
  () => cloud.projects.length,
  (count, prev) => {
    if (count && !prev && !opening) void open();
  },
);

// Cards show assignees by GitHub handle, which lives in `profiles` and reaches the UI
// through the membership join — a WORKSPACE join now, so a roster is read once per
// workspace rather than once per project.
//
// Every VISIBLE workspace, not only the scoped one. An unscoped board shows cards from
// every workspace this user belongs to, and the editor has to be able to name the
// assignee of any card it opens: reading only the scoped roster would render a card from
// another group with a raw uuid where a handle belongs. The count is the number of teams
// this user is on, each roster is read at most once, and one group's failure must not
// blank the whole board.
async function loadMembers(): Promise<void> {
  await Promise.all(
    cloud.workspaces.map(async (w) => {
      if (cloud.members[w.id]) return;
      try {
        await cloud.loadMembers(w.id);
      } catch {
        /* membership is decoration here; the cards render with raw ids instead */
      }
    }),
  );
}

// A workspace that arrives after mount — created from the sidebar, or first seen by a
// retried load — has no roster yet, and `loadMembers()` skips one it already holds, so this
// watcher is the only thing that can trigger that first read.
//
// Keyed on the joined IDS, not the count: `removeWorkspace` re-reads the whole RLS-scoped
// list, so deleting one group while a teammate adds you to another leaves the length
// identical and the new group's members would render as raw uuids until a reload. Same
// pattern stores/board.ts uses for the project set.
watch(() => cloud.workspaces.map((w) => w.id).join(','), () => void loadMembers());

// ── Scope and filters ─────────────────────────────────────────────────────────
// Scope comes from the sidebar: a workspace narrows to its projects, nothing selected
// means every project this user can see, and a selected project carrying no workspace is
// local-only and scopes to nothing (lib/scope.ts explains why empty is the exact answer
// there). This does NOT narrow the Realtime channel — stores/board.ts stays subscribed to
// every visible project, because a postgres_changes filter cannot be edited in place and
// would be torn down and rebuilt on every workspace click.
const scoped = computed(() =>
  scopedProjectIds(
    {
      ...(local.selectedWorkspaceId ? { workspaceId: local.selectedWorkspaceId } : {}),
      ...(local.selectedProjectId ? { projectId: local.selectedProjectId } : {}),
    },
    cloud.projects,
  ),
);

const projectFilter = ref('');
const assigneeFilter = ref('');

function projectName(id: string): string {
  return cloud.projects.find((p) => p.id === id)?.name ?? '—';
}

// Keyed by ID, not by name: two workspaces may legitimately hold projects with the same
// name, and the name-keyed filter this replaces then matched whichever came first.
const projectOptions = computed<KSelectOption[]>(() =>
  cloud.projects.filter((p) => scoped.value.includes(p.id)).map((p) => ({ value: p.id, label: p.name })),
);

// The roster «Виконавці» offers. With a workspace selected it is that workspace's; with
// nothing selected the board spans every workspace this user can see, so the options are
// the union of their rosters, deduped by user id because the same person is often on
// several teams. The alternative — an empty roster until a workspace is picked — would
// leave the filter showing exactly one option on the screen the board opens with.
//
// «Не призначено» leads, and it is the category that had no representation at all before:
// an unclaimed task was reachable only as a column state, never as a filter.
const assigneeOptions = computed<KSelectOption[]>(() => {
  const ws = local.selectedWorkspaceId;
  const rosters = ws
    ? [cloud.members[ws] ?? []]
    : cloud.workspaces.map((w) => cloud.members[w.id] ?? []);
  const out: KSelectOption[] = [{ value: UNASSIGNED, label: t('board.filter.unassigned') }];
  const seen = new Set<string>();
  for (const roster of rosters) {
    for (const m of roster) {
      if (seen.has(m.userId)) continue;
      seen.add(m.userId);
      out.push({ value: m.userId, label: handleOf(m) });
    }
  }
  return out;
});

const scopeHeading = computed(() => {
  const id = local.selectedWorkspaceId;
  if (!id) return t('board.heading.team');
  const name = cloud.workspaceById.get(id)?.name;
  if (name) return t('board.heading.scoped', { name });
  // Scoped, but the name has not arrived. «Дошка команди» would claim the OPPOSITE of what
  // the board is showing — one group's tasks announced as every group's — so while the list
  // is unread the heading keeps the scoped SHAPE and says «читаю…» where the name goes.
  // After a read an unresolvable id means the group is gone, and there is no name to wait
  // for any more.
  return cloud.listRead ? t('board.heading.team') : t('board.heading.reading');
});

const visibleTasks = computed(() =>
  filterTasks(board.tasks, {
    scopedProjectIds: scoped.value,
    projectFilter: projectFilter.value,
    assigneeFilter: assigneeFilter.value,
  }),
);

const byColumn = computed<Record<string, Task[]>>(() => {
  const out: Record<string, Task[]> = {};
  for (const col of COLUMNS) out[col.key] = visibleTasks.value.filter((t) => col.statuses.includes(t.status));
  return out;
});

// Requirement 6: clicking a project in the sidebar arrives here with that project already
// in «Проєкти». A manual change afterwards is not clobbered, because only a NEW sidebar
// selection fires this — and a workspace click clears the project, which clears the
// filter, which is exactly the widening the user just asked for.
//
// `immediate: true` is what makes the ordinary path work at all. A sidebar project click
// deliberately does not navigate (Requirement 5), `<router-view>` has no `<keep-alive>`, and
// `agents` is the default route — so «pick a project, then press Дошка» MOUNTS this page
// after the selection was made, and a change-only watcher never fires for it.
watch(
  () => local.selectedProjectId,
  (id) => {
    projectFilter.value = id ?? '';
  },
  { immediate: true },
);

// A filter naming a project outside the new scope would silently empty the board. This
// covers what the watcher above cannot see: a project MOVED to another workspace, and a
// cloud list that only arrives after the click.
//
// `immediate: true`, matching the pre-select above, because the two must agree AT MOUNT.
// A LOCAL-ONLY project scopes to `[]` by design (lib/scope.ts), so `projectOptions` is
// empty while the pre-select has already written the project's uuid into `projectFilter` —
// and KSelect deliberately keeps a value it was never offered, which renders a bare
// 36-character uuid where a project name belongs. Deferring this to the first CHANGE of
// `scoped` leaves that on screen until something else moves.
//
// Gated on `listRead` because `scoped` is `[]` both when the filter is out of scope and
// when no list has been read YET — the store's own flag for that distinction. That gate is
// also what makes running at mount safe: with a warm store a local-only selection clears
// and a real cloud project survives because `scoped` contains it, while an unread list
// returns early and leaves the pre-select standing until the list lands.
// Same rule as the assignee filter below: validating against an asynchronously-loaded list
// is only sound once you know the list arrived.
watch(
  scoped,
  (ids) => {
    if (!cloud.listRead) return;
    if (projectFilter.value && !ids.includes(projectFilter.value)) projectFilter.value = '';
  },
  { immediate: true },
);

// The assignee filter is CLEARED on a workspace change rather than validated against the
// new roster: that roster loads asynchronously, so a validity check would drop a person
// who really is on the new team merely because their row had not arrived yet. Switching
// group is a deliberate act, and resetting a person filter on it is not a surprise.
// Selecting a project inside the current workspace leaves it alone, so the two filters
// still compose.
//
// UNASSIGNED is exempt, and that is not a special case but the rule read literally: it is
// a constant belonging to no roster, offered unconditionally, and filterTasks resolves it
// without consulting membership — so no roster load can invalidate it. Clearing it would
// break the composition this task exists for, since `undefined → W` is exactly what a
// project click produces on the unscoped board the app opens with.
watch(() => local.selectedWorkspaceId, () => {
  if (assigneeFilter.value !== UNASSIGNED) assigneeFilter.value = '';
});

// The read itself takes ~150 ms against a warm cloud, and a hint nobody can read is just a
// flicker in the same spot the offline banner used to blink: say «читаю» only once the wait
// is long enough to be worth explaining. An error is not transient, so it shows at once.
const SLOW_LOAD_MS = 500;
const slowLoad = useDelayedTrue(() => board.loading, SLOW_LOAD_MS);

const loadHint = computed(() => {
  if (slowLoad.value) return t('board.loadHint.reading');
  if (board.loadError) return t('board.loadHint.error', { error: board.loadError });
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
// Two guards, and both say the same thing: this list is only meaningful once the cloud list
// is an ANSWER. `offlineError` covers a read that failed; `listRead` covers one that has not
// come back yet, when `cloud.byId` is empty and EVERY local row — published ones included —
// looks local-only. Without them the user is offered a publish the cloud is going to refuse
// with a duplicate key, reported back as «ви не його учасник» about a project they own.
//
// The guard lives HERE, on the collection, rather than at each of its readers: the publish
// section, its «спершу потрібен воркспейс» note, `localOnlyHint` and `blankText` all form
// their belief from this array, and four copies of one condition is how two of them came to
// disagree in the first place.
const unpublished = computed(() =>
  !cloud.listRead || cloud.offlineError
    ? []
    : local.projects.filter((p) => !cloud.byId.has(p.id)),
);

// A local-only project SELECTED in the sidebar scopes the board to nothing (lib/scope.ts),
// so every column is empty and the count reads 0 — a state indistinguishable from breakage
// unless it says what it is.
//
// The unread window needs no guard here: `unpublished` is empty until the cloud list is an
// answer, so this cannot assert that a published project lives only on this machine. A hint
// that names a thing is held to a higher standard than a control that merely appears,
// because the user can act on it.
const localOnlyHint = computed(() => {
  const id = local.selectedProjectId;
  if (!id || local.selectedWorkspaceId) return '';
  const row = unpublished.value.find((p) => p.id === id);
  return row
    ? t('board.localOnly.hint', { name: row.name })
    : '';
});

// «Читаю дошку…» is about the TASK read; this is the project read, and the two finish
// independently. One key so the two surfaces that say it cannot drift.

// Why «Нова задача» is grey. `tasks.project_id` is what tasks_insert_member checks
// membership against, so with no project to hang a task on there is nothing to create —
// and that is now three different situations, only some of which the user can act on.
const newTaskHint = computed(() => {
  if (!cloud.projects.length) {
    if (cloud.offlineError) return t('board.newTaskHint.offline');
    // Unread is not empty. Saying the cloud holds no project yet — and pointing at a publish
    // section this window deliberately hides — hands the user a reason that is not the real
    // one, on a button that is grey for a reason that will pass on its own.
    if (!cloud.listRead) return t('board.readingProjects');
    return t('board.newTaskHint.noCloudProjects');
  }
  // Projects exist, but none in the current scope: the create picker offers only what the
  // board is showing, so the way out is a sidebar click, not this button.
  if (!projectOptions.value.length) {
    return localOnlyHint.value
      ? t('board.newTaskHint.localOnly')
      : t('board.newTaskHint.emptyWorkspace');
  }
  return t('board.newTaskHint.create');
});

// The same states, spelled out where the board is empty. Telling a user with two local
// projects that they are «не в жодному проєкті» is how this page dead-ended — and telling
// them so while the list is still being read is the same dead end one beat earlier, since
// the list above that this text sends them to is hidden until the read lands.
const blankText = computed(() => {
  if (cloud.offlineError) {
    return t('board.blank.offline');
  }
  if (!cloud.listRead) return t('board.readingProjects');
  if (unpublished.value.length) {
    return t('board.blank.unpublished');
  }
  return t('board.blank.noProjects');
});

const publishing = ref<string | null>(null);
const publishError = ref<string | null>(null);

// projectId → destination workspace id. `projects.workspace_id` is `not null`, so there is
// no such thing as publishing into nothing: the row's button stays disabled until this is
// picked, which is also why the destination is asked for HERE rather than guessed from the
// current scope — the board's scope is wherever the user happens to be looking, and a
// publish is permanent.
const publishInto = ref<Record<string, string>>({});
const workspaceOptions = computed<KSelectOption[]>(() =>
  cloud.workspaces.map((w) => ({ value: w.id, label: w.name })),
);

async function publishProject(project: Project): Promise<void> {
  if (publishing.value) return;
  const workspaceId = publishInto.value[project.id];
  // The button is disabled without a destination; this is the refusal for a submit that
  // arrives anyway (a stale click, a keyboard activation), so the call site can never hand
  // publish() an empty workspace.
  if (!workspaceId) {
    publishError.value = t('board.publish.selectWorkspace', { name: project.name });
    return;
  }
  publishing.value = project.id;
  publishError.value = null;
  try {
    await cloud.publish(project, workspaceId);
    // Membership is a workspace fact, so publishing into a group whose roster is already
    // loaded needs nothing new — this is the retry for a roster whose earlier read failed,
    // and the first read for a group that had no visible project until now.
    await loadMembers();
    local.notify(t('board.notify.published', { name: project.name }));
  } catch (e) {
    const raw = e instanceof Error ? e.message : String(e);
    // A primary-key collision is the one refusal that means something specific: the cloud
    // row exists and this user simply cannot see it. Publishing again would never help.
    publishError.value = /duplicate key|already exists/i.test(raw)
      ? t('board.publish.duplicate', { name: project.name })
      : t('board.publish.failed', { name: project.name, error: raw });
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
// Membership is a WORKSPACE fact now, so a task's roster is the roster of its project's
// workspace — resolved through the project rather than read off it. A project whose cloud
// row is not held (local-only, or a list that failed to read) has no roster, and the
// picker then renders raw ids, which is what it did before for an unloaded membership.
function membersOf(projectId: string): WorkspaceMember[] {
  const workspaceId = cloud.byId.get(projectId)?.workspaceId;
  return workspaceId ? cloud.members[workspaceId] ?? [] : [];
}

function onAssign(task: Task, userId: string): void {
  // Id-keyed like both filters. '' is KSelect's placeholder, i.e. «не призначено».
  const next = userId || null;
  if (next === (task.assigneeId ?? null)) return;
  void board.assignTask(task.id, next);
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

// The API refuses `task assigned to someone else` and tasks_guard refuses the reassignment;
// showing that BEFORE the click is the difference between a rule and a surprise. Both are
// mirrors of a server-side rule (lib/tasks-view.ts) — never the rule itself.
function canRun(task: Task): boolean {
  return !!auth.user && canRunTask(task, auth.user.id);
}

function canAssign(task: Task): boolean {
  return !!auth.user && canAssignTask(task, auth.user.id, cloud.isOwner(task.projectId));
}

// The old text told everyone with a disabled button to «зупини сесію», which on any machine
// but the executing one names a session that does not exist there — leaving the user hunting
// for a stop button they cannot have. Say where the work actually is instead, and point at
// the recovery control when there is one.
function launchHint(task: Task): string {
  if (!isActiveTask(task)) {
    // Ordered before the binding hint because a card held by someone else cannot be run
    // from here at all — pointing at the folder picker would be a dead end. An ACTIVE card
    // keeps the branches below instead: «де воно виконується» is the more useful answer
    // there, and it is the only place the force-stop pointer lives.
    if (!canRun(task)) return t('board.launchHint.assignedOther');
    return isBound(task)
      ? t('board.launchHint.runLocal')
      : t('board.launchHint.notBound');
  }
  if (hasLocalSession(task)) {
    return t('board.launchHint.alreadyRunningLocal');
  }
  return canForceStop(task)
    ? t('board.launchHint.maybeOtherMachine')
    : t('board.launchHint.runningRemote');
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
const launchErrors = computed<Record<string, string>>(() => ({
  'task not found': t('board.launchError.notFound'),
  // tasks_guard's own two sentences, shared with every other surface that renders a refused
  // assignment so the wording cannot drift between them.
  ...Object.fromEntries(Object.entries(ASSIGNMENT_REFUSALS).map(([raw, key]) => [raw, t(key)])),
  'task already claimed': t('board.launchError.claimed'),
  'task is already running': t('board.launchError.running'),
  'not signed in': t('board.launchError.notSignedIn'),
}));

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
    local.notify(t('board.notify.sessionStarted', { name: session.name }), 'info');
    // The local session lives on the Агенти board, so go where the work is.
    await router.push('/');
  } catch (e) {
    // `fetch` itself rejects with a TypeError; every refusal from the api arrives as a
    // plain Error carrying the server's message. That is what separates "the local
    // Kermanych is not answering" from "it answered no".
    if (e instanceof TypeError) {
      local.notify(t('board.notify.localUnreachable'), 'error');
      return;
    }
    const message = e instanceof Error ? e.message : String(e);
    if (message === 'project not bound') {
      // Raced with someone unbinding, or the row vanished — offer the picker instead of a toast.
      openBinding(task);
      return;
    }
    local.notify(launchErrors.value[message] ?? t('board.launchError.generic', { error: message }), 'error');
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
      bindingError.value = t('board.notify.localUnreachable');
      return;
    }
    bindingError.value = e instanceof Error ? e.message : String(e);
  }
}

// ── Create / edit ─────────────────────────────────────────────────────────────
// Same launch vocabulary as the local launcher (AgentsPage.vue:658-661), so a task born
// on the board and an agent started by hand offer identical choices.
const modelPickOptions = computed(() => modelOptions(local.models));
// The effort ladder narrows to the chosen model's own (empty for a non-reasoning model);
// «за замовчуванням» or an unknown alias keeps the full ladder. Labels stay ours (lib/effort).
const effortPickOptions = computed(() => {
  const allowed = effortOptions(local.models, draftModel.value || undefined);
  return EFFORT_OPTIONS.filter((o) => allowed.includes(o.value)).map((o) => ({ value: o.value, label: t(o.labelKey) }));
});
const PREFIX_OPTIONS = ['feature', 'fix', 'refactoring', 'chore'];
const PLATFORM_OPTIONS = ['backend', 'web', 'mobile'];

const editorOpen = ref(false);
const editingId = ref<string | null>(null);
const editorError = ref<string | null>(null);
const editingTask = computed(() =>
  editingId.value ? board.tasks.find((t) => t.id === editingId.value) : undefined,
);

// The same face the card shows, beside the picker that changes it: a re-assign is confirmed
// by the picture changing, without closing the modal.
const editingAssignee = computed(() => {
  const task = editingTask.value;
  return task ? resolveAssignee(task.assigneeId, membersOf(task.projectId)) : null;
});

const draftProject = ref('');
const draftTitle = ref('');
const draftDescription = ref('');
const draftModel = ref('');
const draftEffort = ref<ThinkingLevel | ''>('');
const draftPrefix = ref('');
const draftPlatform = ref('');
const draftBranch = ref('');
// Creation only: while editing, the select writes through onAssign and the card itself is
// the value. '' is «не призначено».
const draftAssignee = ref('');

// The editor's assignee picker reads the roster of the picker's OWN project, which is not
// necessarily the scoped one: an unscoped board shows cards from every workspace, and
// «Виконавець» must name the person who actually holds the card. `draftProject` is the key
// for both modes — it is the edited card's (immutable) project while editing, and the
// project the create dialog is currently pointed at otherwise.
const editorAssigneeOptions = computed<KSelectOption[]>(() =>
  membersOf(draftProject.value).map((m) => ({ value: m.userId, label: handleOf(m) })),
);

// A task always needs a title; a NEW one also needs a project, because `project_id` is what
// the tasks INSERT policy checks membership against. `draftProject` holds an ID now, so it
// is checked against the cloud list rather than merely being non-empty: a stale id must not
// reach the insert.
const canSubmit = computed(
  () => !!draftTitle.value.trim() && (!!editingId.value || cloud.byId.has(draftProject.value)),
);

function openCreate(): void {
  editingId.value = null;
  editorError.value = null;
  // Default to whatever the board is already filtered to — that is the project the user is
  // looking at — and otherwise to the first project IN SCOPE, since those are the only ones
  // the picker offers.
  draftProject.value = projectFilter.value || (projectOptions.value[0]?.value ?? '');
  draftTitle.value = '';
  draftDescription.value = '';
  // A NEW card seeds its Модель and Ефорт from the chosen project's «за замовчуванням» (Запуск
  // задач settings); an EDIT keeps the card's own. `draftProject` is set just above.
  const createDefault = cloud.byId.get(draftProject.value);
  draftModel.value = createDefault?.defaultModel ?? '';
  draftEffort.value = createDefault?.defaultEffort ?? '';
  draftPrefix.value = '';
  draftPlatform.value = '';
  draftBranch.value = '';
  draftAssignee.value = '';
  editorOpen.value = true;
}

function openEdit(task: Task): void {
  editingId.value = task.id;
  editorError.value = null;
  draftProject.value = task.projectId;
  draftTitle.value = task.title;
  draftDescription.value = task.description ?? '';
  draftModel.value = task.model ?? '';
  draftEffort.value = task.effort ?? '';
  draftPrefix.value = task.prefix ?? '';
  draftPlatform.value = task.platform ?? '';
  draftBranch.value = task.branch ?? '';
  // Reset with the rest of the draft set rather than left over from a previous dialog: only
  // the create branch reads it, and a half-reset draft set is a trap for the next edit here.
  draftAssignee.value = task.assigneeId ?? '';
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
    effort: draftEffort.value,
    prefix: draftPrefix.value,
    platform: draftPlatform.value,
    branch: draftBranch.value,
  };

  // The title is the ONE field nothing downstream defends: `tasks.title` is `text not null`
  // with no non-empty check, and patchTask sends the trimmed value as-is, so a whitespace
  // title would persist and the card would lose its name. `canSubmit` already disables the
  // control; this is the refusal for a submit that arrives anyway (Enter, a stale click).
  if (!fields.title) {
    editorError.value = t('board.editor.noTitle');
    local.notify(t('board.editor.noTitle'), 'error');
    return;
  }

  if (editingId.value) {
    if (!(await board.updateTaskFields(editingId.value, fields))) {
      editorError.value = t('board.editor.updateFailed');
      return;
    }
  } else {
    const projectId = draftProject.value;
    if (!cloud.byId.has(projectId)) {
      editorError.value = t('board.editor.selectProject');
      return;
    }
    if (
      !(await board.createTask({
        projectId,
        ...fields,
        // «не призначено» is still the default: the board is the shared backlog. An assignee
        // picked here is the «this one is yours» case, and tasks_guard refuses a non-member.
        ...(draftAssignee.value ? { assigneeId: draftAssignee.value } : {}),
      }))
    ) {
      editorError.value = t('board.editor.createFailed');
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
  flex-direction: column;
  /* Same label-to-control gap KSelect uses, so a hoisted label sits where its own would. */
  gap: 6px;
}

.board__assign-label {
  font-size: 13px;
  color: var(--k-text);
}

.board__assign-row {
  display: flex;
  align-items: center;
  gap: var(--k-sp-2);
}

.board__stale-note {
  font-size: 11.5px;
  color: var(--k-warning);
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
