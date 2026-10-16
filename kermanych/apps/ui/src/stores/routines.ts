// apps/ui/src/stores/routines.ts
// The workspace's routines and their run history (docs/specs/2026-10-16-routines.md), keyed by
// WORKSPACE for the reason stores/release-notes.ts is.
//
// Two parties, and this store talks to both:
//   * the cloud, under the operator's own JWT — creating, editing, pausing and deleting a
//     routine are row writes RLS decides on (any member creates; the author edits; the author or
//     the owner pauses and deletes);
//   * the local api, for «Run now» only — running needs this machine's checkouts, Slack token
//     and agent runtime. Scheduled runs need nobody's click: the author's api fires them.
//
// No Realtime channel: the runner tells its own window over the local socket (`routine_run`,
// read off the orchestrator by the screen), and every other member's screen refetches on open.
import { defineStore } from 'pinia';
import { ref } from 'vue';
import type {
  WorkspaceRoutine,
  WorkspaceRoutineInsert,
  WorkspaceRoutinePatch,
  WorkspaceRoutineRun,
} from '@kermanych/cloud';
import {
  createWorkspaceRoutine,
  deleteWorkspaceRoutine,
  listWorkspaceRoutineRuns,
  listWorkspaceRoutines,
  patchWorkspaceRoutine,
} from '@kermanych/cloud';
import { useAuth } from './auth';
import { api } from '../lib/api';
import { IS_PREVIEW } from '../lib/preview';
import { globalTr } from '../boot/i18n';

export const useRoutines = defineStore('routines', () => {
  const auth = useAuth();

  const byWorkspace = ref<Record<string, WorkspaceRoutine[]>>({});
  // Newest first, the workspace's recent history across every routine.
  const runs = ref<Record<string, WorkspaceRoutineRun[]>>({});
  const loading = ref(false);
  const loadError = ref<string | null>(null);

  function put(workspaceId: string, routine: WorkspaceRoutine): void {
    const rows = (byWorkspace.value[workspaceId] ?? []).filter((r) => r.id !== routine.id);
    rows.push(routine);
    rows.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    byWorkspace.value = { ...byWorkspace.value, [workspaceId]: rows };
  }

  async function load(workspaceId: string): Promise<void> {
    await auth.ready;
    if (IS_PREVIEW || !auth.user || !workspaceId) return;
    loading.value = true;
    loadError.value = null;
    try {
      const [routines, history] = await Promise.all([
        listWorkspaceRoutines(auth.client, workspaceId),
        listWorkspaceRoutineRuns(auth.client, workspaceId),
      ]);
      byWorkspace.value = { ...byWorkspace.value, [workspaceId]: routines };
      runs.value = { ...runs.value, [workspaceId]: history };
    } catch (e) {
      // Inline on the screen, never a toast: the section is the one place that needs it.
      loadError.value = e instanceof Error ? e.message : String(e);
    } finally {
      loading.value = false;
    }
  }

  // The history alone — what a `routine_run` event changes.
  async function loadRuns(workspaceId: string): Promise<void> {
    if (IS_PREVIEW || !auth.user) return;
    runs.value = { ...runs.value, [workspaceId]: await listWorkspaceRoutineRuns(auth.client, workspaceId) };
  }

  async function create(input: WorkspaceRoutineInsert): Promise<WorkspaceRoutine> {
    if (!auth.user) throw new Error(globalTr.t('common.notify.signInFirst'));
    const row = await createWorkspaceRoutine(auth.client, input);
    put(row.workspaceId, row);
    return row;
  }

  async function update(routine: WorkspaceRoutine, patch: WorkspaceRoutinePatch): Promise<WorkspaceRoutine> {
    const row = await patchWorkspaceRoutine(auth.client, routine.id, patch);
    put(row.workspaceId, row);
    return row;
  }

  async function remove(routine: WorkspaceRoutine): Promise<void> {
    await deleteWorkspaceRoutine(auth.client, routine.id);
    byWorkspace.value = {
      ...byWorkspace.value,
      [routine.workspaceId]: (byWorkspace.value[routine.workspaceId] ?? []).filter((r) => r.id !== routine.id),
    };
    runs.value = {
      ...runs.value,
      [routine.workspaceId]: (runs.value[routine.workspaceId] ?? []).filter((r) => r.routineId !== routine.id),
    };
  }

  // The claimed run lands in the history at once, as `running`; its end comes as an event.
  async function runNow(routine: WorkspaceRoutine): Promise<WorkspaceRoutineRun> {
    const run = await api.runRoutine(routine.id);
    runs.value = {
      ...runs.value,
      [routine.workspaceId]: [run, ...(runs.value[routine.workspaceId] ?? []).filter((r) => r.id !== run.id)],
    };
    return run;
  }

  return { byWorkspace, runs, loading, loadError, load, loadRuns, create, update, remove, runNow };
});
