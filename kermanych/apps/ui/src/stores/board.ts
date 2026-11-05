// apps/ui/src/stores/board.ts
import { defineStore } from 'pinia';
import { computed, ref, watch } from 'vue';
import type { Task, TaskChange, TaskChannelState, TaskInsert, TaskPatch } from '@kermanych/cloud';
import type { QaChecklist, QaChecklistItem } from '@kermanych/core';
import {
  createTask as cloudCreateTask,
  deleteTask as cloudDeleteTask,
  forceStopTask as cloudForceStopTask,
  getTask as cloudGetTask,
  listTasks as cloudListTasks,
  listTasksByIds as cloudListTasksByIds,
  listTaskVersions as cloudListTaskVersions,
  patchTask as cloudPatchTask,
  patchQaItems as cloudPatchQaItems,
  subscribeTasks as cloudSubscribeTasks,
  uploadTaskImages as cloudUploadTaskImages,
  TASK_IMAGE_BUCKET,
} from '@kermanych/cloud';
// Import from core's status module directly (not the barrel): @kermanych/core is a CJS
// workspace dep whose named exports vite/rollup only sees once its dist is commonjs-
// transformed (see quasar.config commonjsOptions.include); status.js has a direct export.
import { ACTIVE_STATUSES } from '@kermanych/core/status';
import { useAuth } from './auth';
import { useProjects } from './projects';
import { useOrchestrator } from './orchestrator';
import { installReconcile, type ReconcileOptions } from '../lib/reconcile';
import { assignmentRefusalText } from '../lib/cloud-errors';
import { useDelayedTrue } from '../composables/useDelayedTrue';
import { IS_PREVIEW } from '../lib/preview';
import { globalTr } from '../boot/i18n';

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
  // A task read has answered (rows or an error) for the signed-in user. Before that an empty
  // `tasks` is «not read», not «no tasks» — the columns show a skeleton, never «—» / 0.
  const loaded = ref(false);
  // The raw channel state, 'CLOSED' until a subscription reports otherwise. Nothing may
  // read it on its own as "the board is stale" — see `offline` for why.
  const channelState = ref<TaskChannelState>('CLOSED');
  // True only while a channel is actually installed. subscribeTasks() is never called with
  // no cloud project, and a cloud read that FAILED is already spelled out by `loadError`;
  // neither is allowed to masquerade as a dead connection.
  const watching = ref(false);
  // Anything other than a live SUBSCRIBED channel means "the board may be stale" — but only
  // once it lasts. Realtime answers SUBSCRIBED a few hundred ms after the channel opens,
  // and every (re)subscribe — a board reopened, a project added, a token refreshed — passes
  // through CLOSED first. Rendering that verbatim flashed «немає звʼязку з хмарою» onto the
  // board for ~200 ms on every single open: long enough to be seen, far too short to be
  // read, and untrue — subscribe() refetches the whole board BEFORE opening the channel, so
  // nothing is stale during the handshake. So the claim waits out the grace window and
  // clears the instant the channel answers.
  const OFFLINE_GRACE_MS = 5_000;
  const offline = useDelayedTrue(
    () => watching.value && channelState.value !== 'SUBSCRIBED',
    OFFLINE_GRACE_MS,
  );

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

  // The report blobs the list shape leaves out (cloud TASK_LIST_COLUMNS), per card a screen
  // holds: how many holders, and the `updated_at` the held blobs were read at. The count is
  // store-local; `detailsAt` is reactive because a screen shows «not read yet» from it.
  const holds = new Map<string, number>();
  const detailsAt = ref<Record<string, number>>({});
  const detailsInFlight = new Set<string>();

  // When a row was written. `updated_at` is server-owned (tasks_guard sets now()); parsed
  // rather than compared as text because PostgREST and Realtime are two printers of one
  // timestamptz.
  function versionOf(t: Pick<Task, 'updatedAt'>): number {
    return Date.parse(t.updatedAt);
  }

  // The one rule every write goes through. A held row is never replaced by an older version
  // of itself: a reconcile read can land after a Realtime event that was newer. A LIGHT row
  // (`full` false — the list, the reconcile, Realtime, an optimistic edit) keeps the blobs the
  // store already holds, so an open card does not lose its checklist to a status push; a FULL
  // row (getTask, a write's answer) is the whole truth and records that its blobs are current.
  function merge(prev: Task | undefined, next: Task, full: boolean): Task {
    if (prev && versionOf(next) < versionOf(prev)) return prev;
    if (full) {
      detailsAt.value[next.id] = versionOf(next);
      return next;
    }
    if (!prev || (!prev.qaChecklist && !prev.docsReport)) return next;
    return {
      ...next,
      ...(next.qaChecklist === undefined && prev.qaChecklist ? { qaChecklist: prev.qaChecklist } : {}),
      ...(next.docsReport === undefined && prev.docsReport ? { docsReport: prev.docsReport } : {}),
    };
  }

  // One array write per batch, sorted by createdAt so a Realtime insert lands in a stable
  // place instead of appending to whichever column happened to render last. Keyed by id, so
  // the optimistic row, the awaited response and the Realtime echo all collapse into one.
  function apply(rows: readonly Task[], gone: readonly string[] = [], full = false): void {
    const byId = new Map(tasks.value.map((t) => [t.id, t]));
    for (const id of gone) byId.delete(id);
    for (const row of rows) byId.set(row.id, merge(byId.get(row.id), row, full));
    tasks.value = [...byId.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    for (const id of holds.keys()) if (needsDetails(id)) void loadDetails(id);
  }

  function upsert(task: Task): void {
    apply([task]);
  }

  function upsertFull(task: Task): void {
    apply([task], [], true);
  }

  function needsDetails(id: string): boolean {
    if (!holds.has(id)) return false;
    const t = tasks.value.find((x) => x.id === id);
    return !!t && detailsAt.value[id] !== versionOf(t);
  }

  // Reads the held card's full row. Only for a card the board holds: the board's project set
  // decides what is on it, and a full row must not smuggle in a card the next reconcile drops.
  // One read per card at a time; a change that lands mid-read gets one more.
  async function loadDetails(id: string, again = true): Promise<void> {
    if (detailsInFlight.has(id) || !auth.user) return;
    detailsInFlight.add(id);
    let read = false;
    try {
      const full = await cloudGetTask(auth.client, id);
      read = true;
      if (full && tasks.value.some((t) => t.id === id)) upsertFull(full);
    } catch {
      // The card keeps what it shows; the row's next change asks again.
    } finally {
      detailsInFlight.delete(id);
    }
    if (read && again && needsDetails(id)) await loadDetails(id, false);
  }

  // A screen that shows a card's QA checklist or «Документація» report holds the card while it
  // is on screen (composables/useTaskDetails.ts). The store reads the full row now if it holds
  // no current blobs, and again whenever a lighter row with a newer `updated_at` arrives.
  // Returns the release; calling it twice is a no-op.
  function holdDetails(id: string): () => void {
    holds.set(id, (holds.get(id) ?? 0) + 1);
    if (needsDetails(id)) void loadDetails(id);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const left = (holds.get(id) ?? 1) - 1;
      if (left > 0) holds.set(id, left);
      else holds.delete(id);
    };
  }

  // The card's blobs have been read at least once. A later refresh keeps showing the previous
  // ones until it lands, so this never flips back while the card is open.
  function detailsLoaded(id: string): boolean {
    return id in detailsAt.value;
  }

  // TaskStatus === SessionStatus, so core's constant applies verbatim. Active = the omp
  // process is mid-work or blocked on its user.
  function isActive(task: Task): boolean {
    return ACTIVE_STATUSES.includes(task.status);
  }

  function fail(e: unknown): void {
    const raw = e instanceof Error ? e.message : String(e);
    // tasks_guard's refusals are sentences a user should be able to read; everything
    // else falls through as-is (lib/cloud-errors.ts owns the single copy of each text).
    local.notify(assignmentRefusalText(raw) ?? raw, 'error');
  }

  // Everything after the first read: which cards exist and when each changed (`id,
  // updated_at`, a few dozen kB), then only the rows that moved or are new. The board used to
  // re-read every row every minute — about 1 MB per workspace, the bulk of the project's
  // egress — and replaced every card object, which re-ran every watcher and re-rendered
  // every card. Now a quiet board costs one small read and no array write at all.
  async function catchUp(ids: string[]): Promise<void> {
    // The drop set comes from what was held BEFORE the versions read: a card inserted after
    // that read reaches the board through Realtime and must not be dropped for missing from it.
    const before = new Map(tasks.value.map((t) => [t.id, versionOf(t)]));
    const versions = await cloudListTaskVersions(auth.client, ids);
    const live = new Set(versions.map((v) => v.id));
    const moved = versions.filter((v) => before.get(v.id) !== Date.parse(v.updatedAt)).map((v) => v.id);
    const gone = [...before.keys()].filter((id) => !live.has(id));
    const rows = moved.length ? await cloudListTasksByIds(auth.client, moved) : [];
    if (rows.length || gone.length) apply(rows, gone);
  }

  // The task query is scoped by project, so the cloud project list is a hard prerequisite.
  // Loading it here keeps every caller a one-liner instead of sequencing two stores.
  async function load(): Promise<void> {
    await auth.ready;
    // A preview signs itself in against a cloudless api (lib/preview.ts), so `auth.user`
    // is set but there are no tasks to read — and cloud.load() below would prune the
    // previewed registry against an empty project list. Nothing to load, so: nothing.
    if (IS_PREVIEW || !auth.user) {
      // Nothing will be read, so the empty board is the answer, not a pending one.
      if (IS_PREVIEW) loaded.value = true;
      return;
    }
    // Only the first read of this user's board is a full list (`loaded` resets on sign-out);
    // only it shows as loading, so a reconcile never flashes a hint.
    const first = !loaded.value;
    if (first) loading.value = true;
    loadError.value = null;
    try {
      if (!cloud.projects.length) await cloud.load();
      if (first) {
        const rows = await cloudListTasks(auth.client, projectIds.value);
        const held = new Set(rows.map((t) => t.id));
        apply(rows, tasks.value.filter((t) => !held.has(t.id)).map((t) => t.id));
      } else await catchUp(projectIds.value);
    } catch (e) {
      // Deliberately NOT a toast: an unreachable Supabase must not greet the user with a
      // popup on a screen they may have opened only to read the columns. BoardPage renders
      // loadError inline instead.
      loadError.value = e instanceof Error ? e.message : String(e);
    } finally {
      if (first) loading.value = false;
      loaded.value = true;
    }
  }

  // A reconcile on every (re)subscribe is the whole staleness story: events that fired while
  // the channel was down are gone forever, so the snapshot has to be re-checked rather than
  // patched. Idempotent — calling it twice rebuilds one channel, never two.
  //
  // The same reconcile also runs on a schedule, because Realtime cannot deliver every change:
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
        if (change.kind === 'delete') apply([], [change.taskId]);
        else upsert(change.task);
      },
      (state) => {
        channelState.value = state;
      },
    );
    // From here on a channel exists, so its state is worth reporting: the grace window
    // starts now, not when the page mounted.
    watching.value = true;
    stopReconcile = installReconcile(() => void load(), reconcile);
  }

  function unsubscribe(): void {
    unsubscribeChannel?.();
    unsubscribeChannel = undefined;
    stopReconcile?.();
    stopReconcile = undefined;
    // Leaving the board, signing out and rebuilding are not «немає звʼязку»: no channel is
    // expected, so the grace window is cancelled rather than left ticking towards a banner
    // the next visit would open with.
    watching.value = false;
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
    if (patch.kind !== undefined) next.kind = patch.kind;
    if (patch.branch !== undefined) next.branch = patch.branch;
    // The booleans, which have no "clear it" spelling: `false` is a value. They were
    // missing here while `worktree` was the only one, and the launcher sends them on every
    // save — leaving `hidden` out would keep a just-hidden card on the board until the
    // Realtime echo landed, which is exactly the flicker this function exists to prevent.
    if (patch.worktree !== undefined) next.worktree = patch.worktree;
    if (patch.hidden !== undefined) next.hidden = patch.hidden;
    if (patch.deepAnalysis !== undefined) next.deepAnalysis = patch.deepAnalysis;
    // tasks_guard() may still answer otherwise (a colleague's content edit clears it); the
    // Realtime echo of the stored row corrects the optimistic one then.
    if (patch.autoRun !== undefined) next.autoRun = patch.autoRun;
    // '' is the «за замовчуванням» clear (toTaskRow nulls it), so drop the key rather than
    // storing a blank that is not a valid ThinkingLevel.
    if (patch.effort !== undefined) {
      if (patch.effort) next.effort = patch.effort;
      else delete next.effort;
    }
    // toTask maps an empty array to an absent key, so an emptied list drops it the same way.
    // Without this the optimistic row of an image append would still show the old list.
    if (patch.imagePaths !== undefined) {
      if (patch.imagePaths.length) next.imagePaths = patch.imagePaths;
      else delete next.imagePaths;
    }
    if (patch.qaChecklist !== undefined) next.qaChecklist = patch.qaChecklist;
    return next;
  }

  // Images are uploaded to the private task-images bucket BEFORE the row, so the id the
  // insert mints already carries their paths — one write, one Realtime echo. An upload
  // needs the project id (the storage RLS keys on it), which the insert has anyway.
  async function createTask(input: TaskInsert, images: File[] = []): Promise<Task | undefined> {
    const userId = auth.user?.id;
    if (!userId) {
      local.notify(globalTr.t('common.notify.signInFirst'), 'error');
      return undefined;
    }
    let imagePaths: string[] = [];
    try {
      if (images.length) imagePaths = await cloudUploadTaskImages(auth.client, input.projectId, images);
    } catch (e) {
      fail(e);
      return undefined;
    }
    try {
      // No optimistic row here: the id is minted by Postgres. Realtime delivers the same
      // task moments later and the store dedupes it by id.
      const created = await cloudCreateTask(auth.client, {
        ...input,
        ...(imagePaths.length ? { imagePaths } : {}),
        createdBy: userId,
      });
      upsertFull(created);
      return created;
    } catch (e) {
      // The row never landed, so the objects it would have named are orphans — remove them
      // rather than leave storage littered with images no task points at.
      if (imagePaths.length) {
        await auth.client.storage.from(TASK_IMAGE_BUCKET).remove(imagePaths).catch(() => {});
      }
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
      local.notify(globalTr.t('board.notify.cannotReassignActive'), 'error');
      return false;
    }
    upsert(applyPatch(before, patch));
    try {
      upsertFull(await cloudPatchTask(auth.client, id, patch));
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

  // Append images to an EXISTING card: the «Агенти» launcher puts the images its launch sent on
  // the card, after the session started. Appended, never replaced — the card may already hold
  // images uploaded from «Дошка». Best-effort by design: the caller has already done the work the
  // images were for, so every failure is a toast here and a `false`, never a throw.
  async function addTaskImages(id: string, files: File[]): Promise<boolean> {
    const card = tasks.value.find((t) => t.id === id);
    if (!card || !files.length) return false;
    let added: string[];
    try {
      added = await cloudUploadTaskImages(auth.client, card.projectId, files);
    } catch (e) {
      fail(e);
      return false;
    }
    // Re-read after the upload: a Realtime echo may have changed the card's images meanwhile,
    // and the append has to land on what the card holds now.
    const current = tasks.value.find((t) => t.id === id) ?? card;
    const ok = await updateTaskFields(id, { imagePaths: [...(current.imagePaths ?? []), ...added] });
    // The patch never landed (updateTaskFields has already said why), so the objects it would
    // have named are orphans — the same cleanup createTask does.
    if (!ok) await auth.client.storage.from(TASK_IMAGE_BUCKET).remove(added).catch(() => {});
    return ok;
  }

  async function deleteTask(id: string): Promise<boolean> {
    const before = tasks.value.find((t) => t.id === id);
    if (!before) return false;
    if (isActive(before)) {
      local.notify(globalTr.t('board.notify.cannotDeleteActive'), 'error');
      return false;
    }
    apply([], [id]);
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
      upsertFull(await cloudForceStopTask(auth.client, id));
      return true;
    } catch (e) {
      upsert(before);
      // The guard's sentence names the invariant but is English and does not name the two
      // people who CAN do this, which is the only thing the user needs. Everything else —
      // offline, a revoked membership, a row someone already deleted — is shown verbatim.
      const raw = e instanceof Error ? e.message : String(e);
      if (raw.includes('only the assignee can change status')) {
        local.notify(globalTr.t('board.notify.forceStopForbidden'), 'error');
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
      detailsAt.value = {};
      loadError.value = null;
      loaded.value = false;
    },
  );

  // Puts a checklist the cloud answered with onto the card, keeping the row's version: the
  // write's Realtime echo (a newer `updated_at`) re-reads the held card as usual. Used for the
  // answer of an item patch and for `qa_checklist_update` — the api's own writes (a tester's
  // verdict, a checklist it composed, verdicts cleared at a run's start), which reach this
  // machine over the socket before Realtime and so show live on an open QA tab and card.
  function applyQaChecklist(id: string, checklist: QaChecklist): void {
    if (!tasks.value.some((t) => t.id === id)) return;
    tasks.value = tasks.value.map((t) => (t.id === id ? { ...t, qaChecklist: checklist } : t));
  }

  function replaceQaItem(id: string, item: QaChecklistItem): void {
    const t = tasks.value.find((x) => x.id === id);
    if (!t?.qaChecklist) return;
    const items = t.qaChecklist.items.map((it) => (it.id === item.id ? item : it));
    applyQaChecklist(id, { ...t.qaChecklist, items });
  }

  local.onServerEvent((e) => {
    if (e.type === 'qa_checklist_update') applyQaChecklist(e.taskId, e.checklist);
  });

  // A human ticking one QA checklist item. The tester writes verdicts into the same column
  // meanwhile (docs/specs/2026-11-04-qa-tester-agent.md, decision 3), so the write patches only
  // this item in the database — never the whole column from a possibly stale local copy.
  // Optimistic: the item flips at once and goes back to what it was when the cloud refuses.
  // `checkedBy` / `checkedAt` are stamped on a tick and dropped on an untick, so the row never
  // names a person behind an unchecked box; the item's `agent` verdict is never touched.
  async function setQaItemChecked(id: string, itemId: string, checked: boolean): Promise<boolean> {
    const before = tasks.value.find((t) => t.id === id)?.qaChecklist?.items.find((it) => it.id === itemId);
    if (!before) return false;
    const userId = auth.user?.id;
    const stamp = checked ? { checkedAt: new Date().toISOString(), ...(userId ? { checkedBy: userId } : {}) } : {};
    const optimistic: QaChecklistItem = { ...before, checked, ...stamp };
    if (!checked) {
      delete optimistic.checkedBy;
      delete optimistic.checkedAt;
    }
    replaceQaItem(id, optimistic);
    try {
      const checklist = await cloudPatchQaItems(
        auth.client,
        id,
        [itemId],
        { checked, ...stamp },
        checked ? [] : ['checkedBy', 'checkedAt'],
      );
      applyQaChecklist(id, checklist);
      return true;
    } catch (e) {
      replaceQaItem(id, before);
      fail(e);
      return false;
    }
  }

  return {
    tasks,
    loading,
    loadError,
    loaded,
    channelState,
    offline,
    load,
    subscribe,
    unsubscribe,
    createTask,
    addTaskImages,
    updateTaskFields,
    assignTask,
    deleteTask,
    forceStop,
    setQaItemChecked,
    holdDetails,
    detailsLoaded,
  };
});
