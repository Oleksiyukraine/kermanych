// apps/ui/src/stores/board.ts
import { defineStore } from 'pinia';
import { computed, ref, watch } from 'vue';
import type { Task, TaskChange, TaskChannelState, TaskInsert, TaskPatch } from '@kermanych/cloud';
import {
  createTask as cloudCreateTask,
  deleteTask as cloudDeleteTask,
  forceStopTask as cloudForceStopTask,
  listTasks as cloudListTasks,
  patchTask as cloudPatchTask,
  subscribeTasks as cloudSubscribeTasks,
} from '@kermanych/cloud';
// Import from core's status module directly (not the barrel): @kermanych/core is a CJS
// workspace dep whose named exports vite/rollup only sees once its dist is commonjs-
// transformed (see quasar.config commonjsOptions.include) — same reason as
// stores/orchestrator.ts:16-19.
import { ACTIVE_STATUSES } from '@kermanych/core/status';
import { useAuth } from './auth';
import { useProjects } from './projects';
import { useOrchestrator } from './orchestrator';
import { installReconcile, type ReconcileOptions } from '../lib/reconcile';

// The shared board's TASKS, and nothing else. Cloud projects and membership live in
// stores/projects.ts; local sessions and the socket live in stores/orchestrator.ts. Writes
// are optimistic and roll back when the cloud refuses, because RLS and tasks_guard() — not
// this store — decide what is allowed.
export const useBoard = defineStore('board', () => {
  const auth = useAuth();
  const cloud = useProjects();
  const local = useOrchestrator();

  const tasks = ref<Task[]>([]);
  const loading = ref(false);
  const loadError = ref<string | null>(null);
  // 'CLOSED' until a subscription actually reports otherwise, so `offline` starts true and
  // nothing can claim the board is live before Realtime says so.
  const channelState = ref<TaskChannelState>('CLOSED');
  // Anything other than a live SUBSCRIBED channel means "the board may be stale". Plan D
  // renders this; the store only computes it.
  const offline = computed(() => channelState.value !== 'SUBSCRIBED');

  const projectIds = computed(() => cloud.projects.map((p) => p.id));

  // Store-local, not reactive: nothing renders it, and exposing it would let a component
  // tear the channel down behind the store's back.
  let unsubscribeChannel: (() => void) | undefined;
  let stopReconcile: (() => void) | undefined;
  // Remembered so a channel rebuilt by the project-set watcher keeps the settings the
  // caller subscribed with, instead of silently reverting to the defaults.
  let reconcileOptions: ReconcileOptions = {};
  // Bumped by every subscribe(). A call that was superseded while it awaited load()
  // abandons its own build instead of racing a second channel — and a second reconcile
  // timer — into existence, which the single `unsubscribeChannel` handle could no longer
  // tear down.
  let generation = 0;

  // Sorted by createdAt so a Realtime insert lands in a stable place instead of appending
  // to whichever column happened to render last. Replace-or-append keyed by id, so the
  // optimistic row, the awaited response and the Realtime echo all collapse into one.
  function upsert(task: Task): void {
    tasks.value = [...tasks.value.filter((t) => t.id !== task.id), task].sort((a, b) =>
      a.createdAt.localeCompare(b.createdAt),
    );
  }

  function drop(taskId: string): void {
    tasks.value = tasks.value.filter((t) => t.id !== taskId);
  }

  // TaskStatus === SessionStatus, so core's constant applies verbatim. Active = the omp
  // process is mid-work or blocked on its user.
  function isActive(task: Task): boolean {
    return ACTIVE_STATUSES.includes(task.status);
  }

  function fail(e: unknown): void {
    local.notify(e instanceof Error ? e.message : String(e), 'error');
  }

  // The task query is scoped by project, so the cloud project list is a hard prerequisite.
  // Loading it here keeps every caller a one-liner instead of sequencing two stores.
  async function load(): Promise<void> {
    await auth.ready;
    if (!auth.user) return;
    loading.value = true;
    loadError.value = null;
    try {
      if (!cloud.projects.length) await cloud.load();
      tasks.value = await cloudListTasks(auth.client, projectIds.value);
    } catch (e) {
      // Deliberately NOT a toast: load() also runs from the workspace page on every app
      // open, and an unreachable Supabase must not greet the user with a popup. BoardPage
      // renders loadError inline instead.
      loadError.value = e instanceof Error ? e.message : String(e);
    } finally {
      loading.value = false;
    }
  }

  // A full refetch on every (re)subscribe is the whole staleness story: events that fired
  // while the channel was down are gone forever, so the snapshot has to be re-read rather
  // than patched. Idempotent — calling it twice rebuilds one channel, never two.
  //
  // The same refetch also runs on a schedule, because Realtime cannot deliver every change:
  // a filtered postgres_changes binding never carries DELETE (see lib/reconcile.ts for the
  // replica-identity reason and why `replica identity full` was rejected). Without that
  // reconcile a card someone else deleted would sit on this board forever.
  //
  // `reconcile` is the injection seam for the schedule — the board has no component test
  // harness, so a live harness passes its own document stand-in, clock and interval the
  // way installVisibilityResync's tests do.
  async function subscribe(reconcile: ReconcileOptions = reconcileOptions): Promise<void> {
    const mine = ++generation;
    reconcileOptions = reconcile;
    unsubscribe();
    await load();
    if (mine !== generation || !auth.user || !projectIds.value.length) return;
    unsubscribeChannel = cloudSubscribeTasks(
      auth.client,
      projectIds.value,
      (change: TaskChange) => {
        if (change.kind === 'delete') drop(change.taskId);
        else upsert(change.task);
      },
      (state) => {
        channelState.value = state;
      },
    );
    stopReconcile = installReconcile(() => void load(), reconcile);
  }

  function unsubscribe(): void {
    unsubscribeChannel?.();
    unsubscribeChannel = undefined;
    stopReconcile?.();
    stopReconcile = undefined;
    channelState.value = 'CLOSED';
  }

  // Apply a patch to a local copy exactly the way Postgres will, so the optimistic row and
  // the eventual server row agree. `assigneeId: null` means "clear it", which on the Task
  // type is an absent key, not a null.
  function applyPatch(task: Task, patch: TaskPatch): Task {
    const next: Task = { ...task };
    if (patch.title !== undefined) next.title = patch.title;
    if (patch.description !== undefined) next.description = patch.description;
    if (patch.assigneeId !== undefined) {
      if (patch.assigneeId === null) delete next.assigneeId;
      else next.assigneeId = patch.assigneeId;
    }
    if (patch.model !== undefined) next.model = patch.model;
    if (patch.prefix !== undefined) next.prefix = patch.prefix;
    if (patch.platform !== undefined) next.platform = patch.platform;
    if (patch.kind !== undefined) next.kind = patch.kind;
    if (patch.branch !== undefined) next.branch = patch.branch;
    return next;
  }

  async function createTask(input: TaskInsert): Promise<Task | undefined> {
    const userId = auth.user?.id;
    if (!userId) {
      local.notify('Спочатку увійдіть у Kermanych', 'error');
      return undefined;
    }
    try {
      // No optimistic row here: the id is minted by Postgres. Realtime delivers the same
      // task moments later and upsert() dedupes it by id.
      const created = await cloudCreateTask(auth.client, { ...input, createdBy: userId });
      upsert(created);
      return created;
    } catch (e) {
      fail(e);
      return undefined;
    }
  }

  async function updateTaskFields(id: string, patch: TaskPatch): Promise<boolean> {
    const before = tasks.value.find((t) => t.id === id);
    if (!before) return false;
    // UX pre-check only. tasks_guard() refuses this server-side with `task is active`
    // whatever the UI allows — this exists so the user gets an instant, readable answer
    // instead of a round trip and a Postgres sentence.
    if (patch.assigneeId !== undefined && isActive(before)) {
      local.notify('Активну задачу не можна переасайнити', 'error');
      return false;
    }
    upsert(applyPatch(before, patch));
    try {
      upsert(await cloudPatchTask(auth.client, id, patch));
      return true;
    } catch (e) {
      // The cloud refused — an RLS policy or tasks_guard(). Put the row back exactly as it
      // was and surface the Postgres message, which names the invariant that fired.
      upsert(before);
      fail(e);
      return false;
    }
  }

  // Assignment is just the field edit tasks_guard() guards, so it shares the pre-check and
  // the rollback rather than duplicating them.
  function assignTask(id: string, assigneeId: string | null): Promise<boolean> {
    return updateTaskFields(id, { assigneeId });
  }

  async function deleteTask(id: string): Promise<boolean> {
    const before = tasks.value.find((t) => t.id === id);
    if (!before) return false;
    if (isActive(before)) {
      local.notify('Активну задачу не можна видалити', 'error');
      return false;
    }
    drop(id);
    try {
      await cloudDeleteTask(auth.client, id);
      return true;
    } catch (e) {
      upsert(before);
      fail(e);
      return false;
    }
  }

  // The stuck-card escape hatch. With no heartbeat (spec Non-goals) a status written by a
  // machine that then crashed never changes again, and tasks_guard() refuses to reassign or
  // delete an active task — so the card would be stuck forever. The guard lets exactly two
  // callers force 'stopped': the assignee, from ANY machine, and the project's owner.
  //
  // No isActive() pre-check here, unlike assign and delete: this is the one write whose
  // whole point is that the task IS active. Optimistic + rollback like updateTaskFields,
  // because whether this caller is allowed is the server's answer, not the store's.
  async function forceStop(id: string): Promise<boolean> {
    const before = tasks.value.find((t) => t.id === id);
    if (!before) return false;
    upsert({ ...before, status: 'stopped' });
    try {
      upsert(await cloudForceStopTask(auth.client, id));
      return true;
    } catch (e) {
      upsert(before);
      // The guard's sentence names the invariant but is English and does not name the two
      // people who CAN do this, which is the only thing the user needs. Everything else —
      // offline, a revoked membership, a row someone already deleted — is shown verbatim.
      const raw = e instanceof Error ? e.message : String(e);
      if (raw.includes('only the assignee can change status')) {
        local.notify(
          'Позначити задачу зупиненою може лише її виконавець або власник проєкту',
          'error',
        );
      } else fail(e);
      return false;
    }
  }

  // The project set is the channel's filter, and a postgres_changes filter cannot be edited
  // in place — a project added, or membership revoked, means rebuilding the channel. Only
  // while a channel actually exists: before the board mounts there is nothing to rebuild.
  watch(
    () => projectIds.value.join(','),
    (next, prev) => {
      if (next === prev || !unsubscribeChannel) return;
      void subscribe();
    },
  );

  // Sign-out must take the channel with it. Left running, the socket would keep a revoked
  // token alive and the next user on this machine would inherit this user's cards.
  watch(
    () => auth.user,
    (u) => {
      if (u) return;
      unsubscribe();
      tasks.value = [];
      loadError.value = null;
    },
  );

  return {
    tasks,
    loading,
    loadError,
    channelState,
    offline,
    load,
    subscribe,
    unsubscribe,
    createTask,
    updateTaskFields,
    assignTask,
    deleteTask,
    forceStop,
  };
});
