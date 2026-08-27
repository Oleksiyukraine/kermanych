// apps/ui/src/stores/projects.ts
import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import type { Project } from '@kermanych/core';
import type {
  CloudProject,
  CloudProjectPatch,
  CloudWorkspacePatch,
  Workspace,
  WorkspaceMember,
} from '@kermanych/cloud';
import {
  createProject as cloudCreateProject,
  createWorkspace as cloudCreateWorkspace,
  deleteProject as cloudDeleteProject,
  deleteWorkspace as cloudDeleteWorkspace,
  inviteMember as cloudInviteMember,
  listMembers as cloudListMembers,
  listProjects as cloudListProjects,
  listWorkspaces as cloudListWorkspaces,
  patchProject as cloudPatchProject,
  patchWorkspace as cloudPatchWorkspace,
  removeMember as cloudRemoveMember,
} from '@kermanych/cloud';
import { useAuth } from './auth';
import { useOrchestrator } from './orchestrator';
import { api } from '../lib/api';
import { groupProjectsByWorkspace, projectWorkspaceMap } from '../lib/scope';

// Cloud workspaces + projects + membership: the source of truth for project CONFIG, for
// the group a project belongs to, and for who is on that group. Every successful read is
// mirrored into the LOCAL registry (POST /api/projects/sync) so launching keeps working
// with Supabase unreachable (design D1 / Requirement 7). Tasks and Realtime live in
// stores/board.ts.
export const useProjects = defineStore('projects', () => {
  const auth = useAuth();
  const local = useOrchestrator();
  const workspaces = ref<Workspace[]>([]);
  const projects = ref<CloudProject[]>([]);
  // Keyed by WORKSPACE id now: membership is a workspace concept.
  const members = ref<Record<string, WorkspaceMember[]>>({});
  const loading = ref(false);
  const offlineError = ref<string | null>(null);

  // The tree, cached so the sidebar renders grouped before the first network call and
  // stays grouped when that call fails. Presentation state only — the local SQLite
  // registry deliberately knows nothing about workspaces (design D1: it caches what
  // LAUNCHING reads, and launching never reads a workspace).
  const TREE_CACHE_KEY = 'kermanych.workspace-tree';
  type TreeCache = { workspaces: Workspace[]; projectWorkspace: Record<string, string> };

  function readTreeCache(): void {
    try {
      const raw = localStorage.getItem(TREE_CACHE_KEY);
      if (!raw) return;
      // Partial, because this payload comes off disk: it parses as JSON without being
      // anything this build wrote, so every field is checked before it reaches the tree.
      const cached = JSON.parse(raw) as Partial<TreeCache>;
      if (!Array.isArray(cached.workspaces)) return;
      const list = cached.workspaces.filter(
        (w) => !!w && typeof w.id === 'string' && typeof w.name === 'string',
      );
      workspaces.value = list;
      // A map entry pointing at a workspace this cache does not hold would let
      // selectProject() highlight a group the tree cannot render — drop it instead.
      const known = new Set(list.map((w) => w.id));
      const map: Record<string, string> = {};
      for (const [projectId, workspaceId] of Object.entries(cached.projectWorkspace ?? {})) {
        if (typeof workspaceId === 'string' && known.has(workspaceId)) map[projectId] = workspaceId;
      }
      local.setProjectWorkspaces(map);
    } catch {
      /* a corrupt cache is not worth a crash; the next load() overwrites it */
    }
  }

  function writeTreeCache(): void {
    const cache: TreeCache = {
      workspaces: workspaces.value,
      projectWorkspace: projectWorkspaceMap(projects.value),
    };
    try {
      localStorage.setItem(TREE_CACHE_KEY, JSON.stringify(cache));
    } catch {
      /* storage full or blocked: the tree just falls back to a network read */
    }
  }

  readTreeCache();

  async function load(): Promise<CloudProject[]> {
    loading.value = true;
    try {
      // Workspaces first: the tree cannot place a project without its group, and RLS
      // scopes both reads to what this user belongs to.
      const [wsList, list] = await Promise.all([
        cloudListWorkspaces(auth.client),
        cloudListProjects(auth.client),
      ]);
      workspaces.value = wsList;
      projects.value = list;
      local.setProjectWorkspaces(projectWorkspaceMap(list));
      writeTreeCache();
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

  async function createWorkspace(name: string, color?: string): Promise<Workspace> {
    const userId = auth.user?.id;
    if (!userId) throw new Error('not signed in');
    // exactOptionalPropertyTypes: an absent colour is an absent KEY, not `undefined`.
    const created = await cloudCreateWorkspace(auth.client, {
      name,
      ownerId: userId,
      ...(color ? { color } : {}),
    });
    workspaces.value = [...workspaces.value, created];
    writeTreeCache();
    return created;
  }

  async function patchWorkspace(id: string, patch: CloudWorkspacePatch): Promise<Workspace> {
    const updated = await cloudPatchWorkspace(auth.client, id, patch);
    workspaces.value = workspaces.value.map((w) => (w.id === id ? updated : w));
    writeTreeCache();
    return updated;
  }

  // Refused two ways, and the caller must be told which: workspaces_delete_owner
  // matches zero rows without an error for a non-owner, and the FK from
  // projects.workspace_id raises while the group still holds any.
  async function removeWorkspace(id: string): Promise<void> {
    if (projects.value.some((p) => p.workspaceId === id)) {
      throw new Error('спершу перенесіть або видаліть проєкти цього воркспейсу');
    }
    await cloudDeleteWorkspace(auth.client, id);
    const before = workspaces.value.length;
    workspaces.value = await cloudListWorkspaces(auth.client);
    if (workspaces.value.length === before) {
      throw new Error('хмара відмовила: видалити воркспейс може лише власник');
    }
    const rest = { ...members.value };
    delete rest[id];
    members.value = rest;
    writeTreeCache();
  }

  async function create(
    workspaceId: string,
    name: string,
    gitRemoteUrl?: string,
  ): Promise<CloudProject> {
    // exactOptionalPropertyTypes: an absent remote is an absent KEY, not `undefined`.
    const created = await cloudCreateProject(auth.client, {
      name,
      workspaceId,
      ...(gitRemoteUrl ? { gitRemoteUrl } : {}),
    });
    projects.value = [...projects.value, created];
    local.setProjectWorkspaces(projectWorkspaceMap(projects.value));
    writeTreeCache();
    // prune=false: this is one project, not the full list.
    await api.syncProjects([created], false);
    return created;
  }

  // Moving a project between workspaces. No dedicated cloud call: it is a patch of
  // workspace_id, and projects_update_member (USING on the old row, WITH CHECK on the
  // new) is what requires membership of BOTH groups. A refused move always throws,
  // in one of two ways: 42501 when the DESTINATION fails WITH CHECK, PGRST116 when
  // USING never matched the SOURCE. The caller rolls back on either.
  async function moveProject(projectId: string, workspaceId: string): Promise<CloudProject> {
    return patch(projectId, { workspaceId });
  }

  // Publishing a LOCAL-only project. Every project created before the team cloud existed —
  // and every one made while Supabase was unreachable — lives in the local registry alone:
  // the rail marks it «поза хмарою» and the board cannot hold a task for it, because a task
  // row needs a `project_id` the tasks policies can check membership against. This is the
  // one way out of that state, and it deliberately reuses the LOCAL id: cloud and local
  // share one project identity (schema: `projects.id` is "ALSO the local SQLite
  // projects.id"), so after this the machine's binding, its sessions and their worktrees
  // belong to a project the whole team can see, with nothing re-created and nothing moved.
  //
  // The config travels with it because the mirror runs the other way afterwards:
  // syncProjects() overwrites name, colour, commands, carry files, branch and conventions
  // from the cloud row, so publishing a bare name would silently blank the local setup.
  async function publish(localRow: Project, workspaceId: string): Promise<CloudProject> {
    // exactOptionalPropertyTypes: an unset field is an absent KEY, and an absent key is
    // also what makes toProjectRow() leave that column at its Postgres default.
    const created = await cloudCreateProject(auth.client, {
      id: localRow.id,
      name: localRow.name,
      workspaceId,
      carryFiles: localRow.carryFiles ?? ['.env'],
      ...(localRow.color ? { color: localRow.color } : {}),
      ...(localRow.previewCommand ? { previewCommand: localRow.previewCommand } : {}),
      ...(localRow.apiCommand ? { apiCommand: localRow.apiCommand } : {}),
      ...(localRow.defaultBranch ? { defaultBranch: localRow.defaultBranch } : {}),
      ...(localRow.conventions ? { conventions: localRow.conventions } : {}),
    });
    projects.value = [...projects.value, created];
    local.setProjectWorkspaces(projectWorkspaceMap(projects.value));
    writeTreeCache();
    // prune=false, and upsertProject keeps a non-empty binding: the local row is updated in
    // place, so `localRepoPath` and the sessions hanging off this id are untouched.
    await api.syncProjects([created], false);
    return created;
  }

  async function patch(id: string, p: CloudProjectPatch): Promise<CloudProject> {
    const updated = await cloudPatchProject(auth.client, id, p);
    projects.value = projects.value.map((x) => (x.id === id ? updated : x));
    // A patch may carry `workspaceId` (that IS the move), so the map and the cached tree
    // are refreshed unconditionally rather than only on the move path.
    local.setProjectWorkspaces(projectWorkspaceMap(projects.value));
    writeTreeCache();
    await api.syncProjects([updated], false);
    return updated;
  }

  async function loadMembers(workspaceId: string): Promise<WorkspaceMember[]> {
    const list = await cloudListMembers(auth.client, workspaceId);
    members.value = { ...members.value, [workspaceId]: list };
    return list;
  }

  // Re-inviting someone already in the workspace succeeds (invite_workspace_member is
  // idempotent), so merge by user id — appending would show them twice.
  async function inviteMember(workspaceId: string, email: string): Promise<WorkspaceMember> {
    const m = await cloudInviteMember(auth.client, workspaceId, email);
    const current = members.value[workspaceId] ?? [];
    members.value = {
      ...members.value,
      [workspaceId]: current.some((x) => x.userId === m.userId)
        ? current.map((x) => (x.userId === m.userId ? m : x))
        : [...current, m],
    };
    return m;
  }

  async function removeMember(workspaceId: string, userId: string): Promise<void> {
    await cloudRemoveMember(auth.client, workspaceId, userId);
    members.value = {
      ...members.value,
      [workspaceId]: (members.value[workspaceId] ?? []).filter((m) => m.userId !== userId),
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
    // No membership to drop here any more: `members` is keyed by workspace, and deleting a
    // project never changes who is in its group.
  }

  const byId = computed(() => new Map(projects.value.map((p) => [p.id, p])));
  const workspaceById = computed(() => new Map(workspaces.value.map((w) => [w.id, w])));
  const projectsByWorkspace = computed(() =>
    groupProjectsByWorkspace(workspaces.value, projects.value),
  );

  // UX only — RLS is the real gate: the owner-only policies refuse a non-owner write
  // regardless of what these return.
  function isWorkspaceOwner(workspaceId: string): boolean {
    const uid = auth.user?.id;
    return !!uid && workspaceById.value.get(workspaceId)?.ownerId === uid;
  }

  // Keeps its name and signature: the question "may I administer this project" is
  // still the right one, only the answer now comes from the project's workspace. That
  // leaves its three callers (MainLayout, BoardPage, AgentsPage) unrewritten.
  function isOwner(projectId: string): boolean {
    const workspaceId = byId.value.get(projectId)?.workspaceId;
    return !!workspaceId && isWorkspaceOwner(workspaceId);
  }

  return {
    workspaces,
    projects,
    members,
    loading,
    offlineError,
    byId,
    workspaceById,
    projectsByWorkspace,
    load,
    createWorkspace,
    patchWorkspace,
    removeWorkspace,
    create,
    moveProject,
    publish,
    patch,
    remove,
    loadMembers,
    inviteMember,
    removeMember,
    isOwner,
    isWorkspaceOwner,
  };
});
