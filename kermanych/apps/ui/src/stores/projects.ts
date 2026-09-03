// apps/ui/src/stores/projects.ts
import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import type { Project } from '@kermanych/core';
import type {
  AssignableRole,
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
  setMemberRole as cloudSetMemberRole,
} from '@kermanych/cloud';
import { useAuth } from './auth';
import { useOrchestrator } from './orchestrator';
import { api } from '../lib/api';
import { groupProjectsByWorkspace, projectWorkspaceMap } from '../lib/scope';
import { globalTr } from '../boot/i18n';

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

  // Has a cloud project list been READ on this run? The sidebar needs this to know whether
  // it holds an authoritative picture of what exists in the cloud, and it cannot be inferred
  // from `projects.value` being non-empty: create() and publish() append to that array, so a
  // single create while Supabase is recovering would otherwise look like a one-project cloud
  // list — and everything absent from it would be labelled «поза хмарою» / «лише на цій
  // машині» about projects nobody ever checked.
  //
  // Set right after the list is assigned and BEFORE the registry mirror, because the mirror
  // writes the local api and has no bearing on what the cloud holds. True for an EMPTY read
  // too: an empty list is an answer, and it is the answer that makes surviving local rows
  // genuine orphans rather than an unread cache. Sticky, on every resolved read including a
  // post-mount retry — once a real list has been seen, a later failure leaves it stale, not
  // absent, and stale is still an answer where absent is not.
  const listRead = ref(false);

  // The tree, cached so the sidebar renders grouped before the first network call and
  // stays grouped when that call fails. Presentation state only — the local SQLite
  // registry deliberately knows nothing about workspaces (design D1: it caches what
  // LAUNCHING reads, and launching never reads a workspace).
  //
  // STAMPED with the account that filled it. `localStorage` is per ORIGIN, so two accounts
  // on one machine share this key, and signing out drops the session but not the key —
  // without a stamp the next account renders the PREVIOUS account's workspace names and
  // ownerIds as its groups, indefinitely if it is offline, because load() degrades instead
  // of throwing. A stamp rather than a clear-on-sign-out: sign-out is not the only route to
  // a different account (an expired token, a hand-copied profile directory), and a stamp
  // also fails safe when the key is carried between machines. A payload from an older
  // build carries no stamp and is therefore ignored too, which is the right reading —
  // unstamped means unknown owner.
  const TREE_CACHE_KEY = 'kermanych.workspace-tree';
  type TreeCache = {
    userId: string;
    workspaces: Workspace[];
    projectWorkspace: Record<string, string>;
  };

  function readTreeCache(): void {
    try {
      const raw = localStorage.getItem(TREE_CACHE_KEY);
      if (!raw) return;
      // Partial, because this payload comes off disk: it parses as JSON without being
      // anything this build wrote, so every field is checked before it reaches the tree.
      const cached = JSON.parse(raw) as Partial<TreeCache>;
      // Reading the stamp synchronously is sound: every route that instantiates this store
      // is `public: false`, and router/index.ts awaits `auth.ready` and bounces a session-
      // less navigation to /login before the layout mounts — so `auth.user` is already set
      // the first time this runs. A mismatch reads as NO CACHE, which the offline path
      // already handles.
      if (typeof cached.userId !== 'string' || cached.userId !== auth.user?.id) return;
      if (!Array.isArray(cached.workspaces)) return;
      // `ownerId` is checked with the rest because isWorkspaceOwner() reads it straight
      // off these rows: a version-skewed payload would otherwise decide which admin
      // affordances render until the first load().
      const list = cached.workspaces.filter(
        (w) =>
          !!w &&
          typeof w.id === 'string' &&
          typeof w.name === 'string' &&
          typeof w.ownerId === 'string',
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
    // Nothing to stamp, so nothing worth keeping: an unattributable payload is exactly what
    // this cache must never hold.
    const userId = auth.user?.id;
    if (!userId) return;
    const cache: TreeCache = {
      userId,
      workspaces: workspaces.value,
      // Rebuilt from the projects we hold ONLY once a list has been read — that is the
      // moment `projects.value` is the whole truth, and a rebuild is what prunes entries
      // for projects the cloud no longer has. Before a read it is not the whole truth:
      // a mutation (create/publish/patch, or a workspace-only one) can run first, and
      // rebuilding from that partial array would overwrite a good cached map with one
      // entry — or with {} — so the next cold start would have cached workspaces and no
      // way to place local project rows into them, which is the offline grouping this
      // cache exists for. There we keep the orchestrator's map, which the mutation has
      // already merged its own entry into.
      projectWorkspace: listRead.value
        ? projectWorkspaceMap(projects.value)
        : local.projectWorkspace,
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
      // Before the mirror below, deliberately: this says the CLOUD answered, and the
      // mirror writes the local api, which is a different question.
      listRead.value = true;
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
      throw new Error(globalTr.t('errors.workspace_has_projects'));
    }
    await cloudDeleteWorkspace(auth.client, id);
    // By ID, not by list length: cloudListWorkspaces returns the whole RLS-scoped set,
    // which a teammate can change between our last load() and this call, and a count
    // would then read a successful delete as refused (or the reverse). remove() below
    // does the same thing the same way.
    workspaces.value = await cloudListWorkspaces(auth.client);
    if (workspaces.value.some((w) => w.id === id)) {
      throw new Error(globalTr.t('errors.workspace_delete_not_owner'));
    }
    const rest = { ...members.value };
    delete rest[id];
    members.value = rest;
    // Normally reached from this workspace's own settings, so the selection is usually
    // the id just deleted: left in place it highlights nothing and scopes the board to a
    // row that no longer exists. Guarded on identity — deleting some OTHER group must
    // not drop the current scope.
    if (local.selectedWorkspaceId === id) local.selectWorkspace();
    writeTreeCache();
  }

  // The projectId → workspaceId map after a single-project mutation. A rebuild from
  // `projects.value` is only the truth once a list has been read; before one that array
  // holds just what this session created, so rebuilding would replace a warm cached map
  // with one entry and writeTreeCache would persist the loss to the next cold start —
  // exactly the offline grouping the cache exists for. So: rebuild after a read (which
  // also prunes entries for projects the cloud no longer has), merge before one. Same
  // rule the workspace-only mutations already follow, applied to the project map.
  //
  // Merging is safe for a MOVE too, because the entry is keyed by project id: the new
  // workspace overwrites the old one rather than accumulating beside it.
  function pushProjectWorkspace(project: CloudProject): void {
    local.setProjectWorkspaces(
      listRead.value
        ? projectWorkspaceMap(projects.value)
        : { ...local.projectWorkspace, [project.id]: project.workspaceId },
    );
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
    pushProjectWorkspace(created);
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
    pushProjectWorkspace(created);
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
    pushProjectWorkspace(updated);
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

  // The role change lands server-side (set_workspace_member_role rpc) and comes back
  // with the joined profile; merge it in by user id. A refusal throws — the caller
  // surfaces it — so there is nothing to roll back here.
  async function setMemberRole(
    workspaceId: string,
    userId: string,
    role: AssignableRole,
  ): Promise<WorkspaceMember> {
    const m = await cloudSetMemberRole(auth.client, workspaceId, userId, role);
    members.value = {
      ...members.value,
      [workspaceId]: (members.value[workspaceId] ?? []).map((x) => (x.userId === m.userId ? m : x)),
    };
    return m;
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
    listRead,
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
    setMemberRole,
    isOwner,
    isWorkspaceOwner,
  };
});
