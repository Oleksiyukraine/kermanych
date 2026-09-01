// apps/ui/src/stores/release-notes.ts
// The workspace's release notes. Keyed by WORKSPACE for the reason stores/risks.ts is: the
// section is a screen you open for one workspace, and a shared list would flash the
// previous workspace's notes for the length of a fetch every time the sidebar moved.
//
// Generation IS here, and deliberately so: the local api writes the document
// (api.generateReleaseNotes — git history and a one-shot omp child live behind that call),
// this store hands the result to `create` below, which stores it in
// `workspace_release_notes` under the operator's own JWT. A run legitimately takes tens of
// seconds, so holding its promise in the screen that started it meant the operator had to
// sit in front of a modal to keep a document that needed nothing from them — one unmount
// and the note was gone. A store outlives the route: the placeholder row, the elapsed
// clock and the cloud write are all read off `jobs` below, and the toast at the end finds
// the operator wherever they walked to.
//
// Every cloud read and write still goes through the same client, so what a member can read
// or edit is decided by RLS, never by this code.
//
// Deliberately no Realtime channel (`workspace_release_notes` is not in the
// supabase_realtime publication): a note is generated a handful of times per release cycle
// by people who are looking at the screen, and the screen refetches on open.
import { defineStore } from 'pinia';
import { ref } from 'vue';
import type {
  WorkspaceReleaseNote,
  WorkspaceReleaseNoteInsert,
  WorkspaceReleaseNotePatch,
} from '@kermanych/cloud';
import {
  createWorkspaceReleaseNote as cloudCreateNote,
  listWorkspaceReleaseNotes as cloudListNotes,
  patchWorkspaceReleaseNote as cloudPatchNote,
} from '@kermanych/cloud';
import { useAuth } from './auth';
import { useOrchestrator } from './orchestrator';
import { api } from '../lib/api';
import { IS_PREVIEW } from '../lib/preview';

// One generation in flight, or one that failed and still owes the operator a reason. Held
// as plain data rather than a promise because the screen renders it: a row in the history
// that says which project, which branch, which period and how long it has been running.
export type ReleaseNotesJob = {
  id: string;
  workspaceId: string;
  workspaceName: string;
  projectId: string;
  projectName: string;
  branch: string;
  rangeFrom: string;
  rangeTo: string;
  startedAt: number;
  // A failed run KEEPS its row with the reason attached. The toast that announced the
  // failure is gone four seconds later, and the person it was meant for was on another
  // screen — the row is what is still there when they come back.
  error: string | null;
};

export const useReleaseNotes = defineStore('release-notes', () => {
  const auth = useAuth();
  const local = useOrchestrator();

  const byWorkspace = ref<Record<string, WorkspaceReleaseNote[]>>({});
  // In-flight and failed generations, flat and unkeyed: there is normally one, and the
  // screen filters by workspace anyway.
  const jobs = ref<ReleaseNotesJob[]>([]);
  const loading = ref(false);
  // Inline on the screen, never a toast: an unreachable Supabase must not greet someone
  // who opened the section only to read it (same call as stores/risks.ts).
  const loadError = ref<string | null>(null);

  // Replace-or-append keyed by id, re-sorted the way the cloud returns a fresh page
  // (newest first), so an edited note does not jump to the top as if it were regenerated.
  function upsert(workspaceId: string, note: WorkspaceReleaseNote): void {
    const rows = (byWorkspace.value[workspaceId] ?? []).filter((n) => n.id !== note.id);
    rows.push(note);
    rows.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    byWorkspace.value = { ...byWorkspace.value, [workspaceId]: rows };
  }

  async function load(workspaceId: string): Promise<void> {
    await auth.ready;
    // A preview signs in against a cloudless api (lib/preview.ts): there is no Supabase
    // project behind it, so there is no history to read.
    if (IS_PREVIEW || !auth.user || !workspaceId) return;
    loading.value = true;
    loadError.value = null;
    try {
      byWorkspace.value = {
        ...byWorkspace.value,
        [workspaceId]: await cloudListNotes(auth.client, workspaceId),
      };
    } catch (e) {
      loadError.value = e instanceof Error ? e.message : String(e);
    } finally {
      loading.value = false;
    }
  }

  // Private: the note that reaches the workspace is always the one `generate` below just
  // wrote, so there is no second caller to hand a failure to. It still THROWS rather than
  // reporting — `generate` turns the throw into the failed row, which is the only place
  // this failure can be read.
  async function create(
    workspaceId: string,
    input: Omit<WorkspaceReleaseNoteInsert, 'workspaceId'>,
  ): Promise<WorkspaceReleaseNote> {
    if (!auth.user) throw new Error('Спочатку увійдіть у Kermanych');
    const created = await cloudCreateNote(auth.client, { workspaceId, ...input });
    upsert(workspaceId, created);
    return created;
  }

  async function save(
    workspaceId: string,
    id: string,
    patch: WorkspaceReleaseNotePatch,
  ): Promise<WorkspaceReleaseNote> {
    const saved = await cloudPatchNote(auth.client, id, patch);
    upsert(workspaceId, saved);
    return saved;
  }

  // ── Generation ──────────────────────────────────────────────────────────────
  // Two awaits, one job: write the document on this machine, then land it in the
  // workspace. The second is not optional — a note that exists only in this browser is not
  // a release note anybody else can read — so a refused cloud write fails the whole job and
  // says so, rather than dropping a document that cost a model turn in silence.
  //
  // Takes an id and reads the row back from `jobs`, so a first run and a retry are the same
  // code path and a retried row keeps its place in the list.
  async function run(id: string): Promise<void> {
    const job = jobs.value.find((j) => j.id === id);
    if (!job) return;
    try {
      const reply = await api.generateReleaseNotes({
        projectId: job.projectId,
        workspaceName: job.workspaceName,
        branch: job.branch,
        rangeFrom: job.rangeFrom,
        rangeTo: job.rangeTo,
      });
      await create(job.workspaceId, {
        projectId: job.projectId,
        projectName: job.projectName,
        branch: job.branch,
        rangeFrom: job.rangeFrom,
        rangeTo: job.rangeTo,
        title: reply.title,
        bodyMd: reply.markdown,
      });
      jobs.value = jobs.value.filter((j) => j.id !== id);
      // The note is NOT opened for them: the operator walked away on purpose, and a modal
      // that mounts itself over whatever they are doing now is the interruption this whole
      // change removed. The toast says where to find it.
      local.notify(`Реліз-ноти «${reply.title}» готові — з ${reply.commitCount} комітів`);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      jobs.value = jobs.value.map((j) => (j.id === id ? { ...j, error: message } : j));
      local.notify(`Реліз-ноти не згенерувались: ${message}`, 'error');
    }
  }

  async function generate(input: Omit<ReleaseNotesJob, 'id' | 'startedAt' | 'error'>): Promise<void> {
    // The form closes on submit now, so «did that go through?» is otherwise answered by
    // opening it again and pressing the button — which would spend a second model turn on
    // a document already being written. Identical asks collapse onto the running job.
    const already = jobs.value.some(
      (j) =>
        !j.error &&
        j.workspaceId === input.workspaceId &&
        j.projectId === input.projectId &&
        j.branch === input.branch &&
        j.rangeFrom === input.rangeFrom &&
        j.rangeTo === input.rangeTo,
    );
    if (already) return;

    const job: ReleaseNotesJob = {
      ...input,
      id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      startedAt: Date.now(),
      error: null,
    };
    jobs.value = [...jobs.value, job];
    await run(job.id);
  }

  // Re-run a failed job with the same parameters — the form is closed and its fields are in
  // the row, so retyping them would be the only alternative. The clock restarts because the
  // wait restarts; the row does not move, because it is the same row.
  async function retry(id: string): Promise<void> {
    const job = jobs.value.find((j) => j.id === id);
    if (!job?.error) return;
    jobs.value = jobs.value.map((j) =>
      j.id === id ? { ...j, error: null, startedAt: Date.now() } : j,
    );
    await run(id);
  }

  function dismissJob(id: string): void {
    jobs.value = jobs.value.filter((j) => j.id !== id);
  }

  return { byWorkspace, jobs, loading, loadError, load, save, generate, retry, dismissJob };
});
