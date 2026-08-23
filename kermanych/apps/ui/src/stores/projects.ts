// apps/ui/src/stores/projects.ts
import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import type { CloudProject, CloudProjectPatch, ProjectMember } from '@kermanych/cloud';
import {
  addMember as cloudAddMember,
  createProject as cloudCreateProject,
  deleteProject as cloudDeleteProject,
  listMembers as cloudListMembers,
  listProjects as cloudListProjects,
  patchProject as cloudPatchProject,
  removeMember as cloudRemoveMember,
} from '@kermanych/cloud';
import { useAuth } from './auth';
import { api } from '../lib/api';

// Cloud projects + membership: the source of truth for project CONFIG and who is on a
// project. Every successful read is mirrored into the LOCAL registry
// (POST /api/projects/sync) so launching keeps working with Supabase unreachable
// (design D1 / Requirement 7). Tasks and Realtime live in stores/board.ts.
export const useProjects = defineStore('projects', () => {
  const auth = useAuth();
  const projects = ref<CloudProject[]>([]);
  const members = ref<Record<string, ProjectMember[]>>({});
  const loading = ref(false);
  const offlineError = ref<string | null>(null);

  async function load(): Promise<CloudProject[]> {
    loading.value = true;
    try {
      const list = await cloudListProjects(auth.client);
      projects.value = list;
      // This IS the full cloud list, so prune is safe: local rows missing from it are
      // stale cache. The api still refuses to prune a row that owns local sessions.
      await api.syncProjects(list, true);
      offlineError.value = null;
      return list;
    } catch (e) {
      // Offline degrades, it does not crash: record why and keep whatever is already
      // cached. The rail is driven by the LOCAL rows, so a failed cloud read means "no
      // fresh config", not "no projects" — and the caller gets a list, not an exception.
      offlineError.value = e instanceof Error ? e.message : String(e);
      return projects.value;
    } finally {
      loading.value = false;
    }
  }

  async function create(name: string, gitRemoteUrl?: string): Promise<CloudProject> {
    const userId = auth.user?.id;
    if (!userId) throw new Error('not signed in');
    // exactOptionalPropertyTypes: an absent remote is an absent KEY, not `undefined`.
    const created = await cloudCreateProject(auth.client, {
      name,
      ownerId: userId,
      ...(gitRemoteUrl ? { gitRemoteUrl } : {}),
    });
    projects.value = [...projects.value, created];
    // prune=false: this is one project, not the full list.
    await api.syncProjects([created], false);
    return created;
  }

  async function patch(id: string, p: CloudProjectPatch): Promise<CloudProject> {
    const updated = await cloudPatchProject(auth.client, id, p);
    projects.value = projects.value.map((x) => (x.id === id ? updated : x));
    await api.syncProjects([updated], false);
    return updated;
  }

  async function loadMembers(id: string): Promise<ProjectMember[]> {
    const list = await cloudListMembers(auth.client, id);
    members.value = { ...members.value, [id]: list };
    return list;
  }

  async function addMember(id: string, githubUsername: string): Promise<ProjectMember> {
    const m = await cloudAddMember(auth.client, id, githubUsername);
    members.value = { ...members.value, [id]: [...(members.value[id] ?? []), m] };
    return m;
  }

  async function removeMember(id: string, userId: string): Promise<void> {
    await cloudRemoveMember(auth.client, id, userId);
    members.value = {
      ...members.value,
      [id]: (members.value[id] ?? []).filter((m) => m.userId !== userId),
    };
  }

  // Deleting a project is a CLOUD act — there is no local delete route. The local rows follow
  // through load()'s prune, which never drops a row that still owns sessions.
  async function remove(id: string): Promise<void> {
    await cloudDeleteProject(auth.client, id);
    // projects_delete_owner refuses a non-owner by matching zero rows and never errors, so
    // re-read rather than trust the call. load() is also the drop-and-prune: it replaces
    // `projects` with the cloud truth and mirrors it into the registry with prune=true.
    const after = await load();
    // load() degrades instead of throwing, so a failed re-read leaves the PREVIOUS list in
    // place — which still contains this id. Claiming a refusal there would be a lie about a
    // delete that most likely landed, so the two outcomes get distinct signals.
    if (offlineError.value) {
      throw new Error(`cloud delete unconfirmed: ${offlineError.value}`);
    }
    if (after.some((p) => p.id === id)) {
      throw new Error('cloud refused the delete: only the project owner may delete a project');
    }
    const rest = { ...members.value };
    delete rest[id];
    members.value = rest;
  }

  const byId = computed(() => new Map(projects.value.map((p) => [p.id, p])));

  // UX only — RLS is the real gate: the owner-only policies refuse a non-owner write
  // regardless of what this returns.
  function isOwner(id: string): boolean {
    const uid = auth.user?.id;
    return !!uid && byId.value.get(id)?.ownerId === uid;
  }

  return {
    projects,
    members,
    loading,
    offlineError,
    byId,
    load,
    create,
    patch,
    remove,
    loadMembers,
    addMember,
    removeMember,
    isOwner,
  };
});
