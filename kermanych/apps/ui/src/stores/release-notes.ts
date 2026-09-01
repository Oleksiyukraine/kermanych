// apps/ui/src/stores/release-notes.ts
// The workspace's release notes. Keyed by WORKSPACE for the reason stores/risks.ts is: the
// section is a screen you open for one workspace, and a shared list would flash the
// previous workspace's notes for the length of a fetch every time the sidebar moved.
//
// Generation is NOT here: the caller asks the local api to write the document
// (api.generateReleaseNotes — git history and omp live behind that call), then hands the
// result to `create` below, which stores it in `workspace_release_notes` under the operator's
// own JWT. There are two such callers — the section screen's form and the management
// assistant's `release.notes` action (./management-chat.ts) — and both end here, which is
// what makes «все, що згенеровано, зберігається у воркспейсі» true however it was asked for.
// This store only ever talks to the cloud, so every note a member can read or edit is
// decided by RLS, never by this code.
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
import { IS_PREVIEW } from '../lib/preview';

export const useReleaseNotes = defineStore('release-notes', () => {
  const auth = useAuth();

  const byWorkspace = ref<Record<string, WorkspaceReleaseNote[]>>({});
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

  // Writes THROW, reads report inline — the same split stores/risks.ts states: the screen
  // that called a write is holding a modal open and answers the failure there, with the
  // document still on screen and nothing lost.
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

  return { byWorkspace, loading, loadError, load, create, save };
});
