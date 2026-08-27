# Workspaces: a grouping level above projects — design

Date: 2026-08-27
Status: approved (design; membership at the workspace level, 1:1 backfill)

## Problem

Projects are flat. `projects` has no parent (`supabase/migrations/20260821090000_team_cloud_schema.sql`),
the sidebar renders one `KRailItem` per project in a single stack
(`apps/ui/src/layouts/MainLayout.vue:27-36`), and the board has exactly one
filter — project name (`apps/ui/src/pages/BoardPage.vue:9`). A team that runs one
product across several repositories (`back-end`, `admin`, `mobile`) has to invite
every colleague to every project separately and has no way to see one product's
work as a whole.

This design adds **workspaces**: a named group that owns projects and carries the
team's membership. A task therefore acquires three levels of binding — workspace
(through its project), project, assignee — and the board can be scoped to a
workspace with two filters, «Проєкти» and «Виконавці».

This **reverses an explicit non-goal** of the approved team-cloud design
(`2026-08-21-team-cloud-design.md:620`, "No team/workspace layer above projects
(flat owner/member)"). The reason the non-goal no longer holds: per-project
invitation is O(projects × people) friction for a team whose projects are the
same product, and the flat list gives no way to answer "what is the state of
product AAA".

## Approach

- **Membership moves up.** `workspace_members` replaces `project_members`. One
  invitation grants access to every project in the workspace. A project no longer
  has an owner of its own; administration is a workspace role.
- **The workspace is derived, never denormalized.** `tasks` gains no
  `workspace_id`; the level is reached through `project_id → projects.workspace_id`.
  A denormalized column would drift the moment a project is dragged to another
  workspace and would need a synchronising trigger.
- **`is_project_member(p, u)` survives as a wrapper.** Its body is redefined to
  resolve the project's workspace, so the four `tasks_*` policies are left
  textually unchanged. Their question — "may this user reach this project?" — is
  still exactly right; only the derivation moved.
- **Execution is untouched.** `apps/api` and `packages/core` change in zero source
  files. `launch()` never reads a workspace, and per design D1 the local SQLite
  registry owns only this machine's repo binding plus an offline cache of what
  launching reads. The workspace tree is cloud + presentation state.
- **Scope is client-side.** The board's Realtime channel keeps subscribing to
  every visible project; workspace scope and both filters are computed in the UI.

```
workspaces ──1:N──► projects ──1:N──► tasks ──►assignee (profiles)
     │                                   ▲
     └── workspace_members ──────────────┘  visibility: is_workspace_member(w,u)
         (the single membership surface)     via is_project_member(p,u) wrapper
```

## Requirements

1. A workspace groups projects. Any authenticated user may create one and becomes
   its `owner`.
2. Membership lives on the workspace and is granted by email by the workspace
   **owner**. There is no pending-invitation state: the address must already belong
   to an account. This deliberately tightens today's rule, where any project member
   may invite (`20260823130000_invite_members_by_email.sql`, and the comment at
   `MainLayout.vue:716` "Inviting is NOT owner-only — any member may"): an
   invitation now grants access to every project in the workspace, a strictly wider
   grant than before, so it moves to the role that already administers the group.
3. A project belongs to exactly one workspace (`not null`). There are no
   workspace-less projects in the cloud.
4. Roles, exactly:

   | action | who |
   |---|---|
   | create a workspace | any authenticated user (becomes `owner`) |
   | rename / delete a workspace, invite / remove a member | workspace `owner` |
   | create a project inside a workspace | any workspace member |
   | edit project config (name, colour, default branch, conventions, preview/api command, carry files, env key names) | any workspace member |
   | delete a project | workspace `owner` |
   | create / assign / delete a task | any workspace member |
   | force `stopped` on a stuck task | the assignee, or the workspace `owner` |
   | move a project to another workspace | a member of **both** workspaces |

5. Clicking a workspace or a project in the sidebar changes the **scope** only and
   never navigates. Board and Agents both read that scope.
6. Board scope: a workspace shows the tasks of all its projects with «Проєкти»
   empty; a project shows the same list with «Проєкти» pre-selected to it.
7. Projects move between workspaces by drag-and-drop, with a non-mouse equivalent.
8. Deleting a workspace that still holds projects is refused at the database level.
9. The existing team's visibility is **exactly preserved** by the migration: nobody
   gains access to a project they could not already see.

## Naming

`workspace` was already taken: `WorkspacePage.vue` behind route `name: 'workspace'`
is the board of LOCAL sessions. The UI already labels that view «Агенти»
(`MainLayout.vue:504`, `{ value: 'agents', label: 'Агенти', route: 'workspace' }`),
so the route name was the only thing out of step.

Clean cutover, ~10 sites: `WorkspacePage.vue` → `AgentsPage.vue`, route name
`workspace` → `agents` (`router/routes.ts:47`), and its references in
`MainLayout.vue:443,449,504,521,542`, `BoardPage.vue:237`,
`router/index.ts:50,66`. README's "workspace board" wording follows. `workspace`
then means the cloud entity everywhere, in code and in copy.

`Group` is NOT reused: it was the pre-cloud name for projects and was deliberately
retired (`2026-08-21-team-cloud-design.md:104-113`).

## Data model — Supabase

One migration, `supabase/migrations/20260827100000_workspaces.sql`. Order is
load-bearing: create → backfill → redefine → re-policy → tear down. Two
redefinitions must precede two drops — `is_project_member` before
`project_members` is dropped, `tasks_guard` before `projects.owner_id` is dropped
— because plpgsql/sql function bodies are not dependency-tracked and would fail
at runtime instead of at migration time.

```sql
create table public.workspaces (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  color text,
  owner_id uuid not null references public.profiles(id) on delete restrict,
  created_at timestamptz not null default now());

create table public.workspace_members (
  workspace_id uuid not null references public.workspaces on delete cascade,
  user_id uuid not null references public.profiles on delete cascade,
  role text not null check (role in ('owner','member')),
  added_at timestamptz not null default now(),
  primary key (workspace_id, user_id));

create index workspace_members_user_idx on public.workspace_members (user_id);

-- `on delete restrict`, NOT cascade: deleting a workspace must not silently take
-- its projects and every task on them. The refusal is legible, which is the same
-- choice `projects.owner_id` already made for account deletion.
alter table public.projects
  add column workspace_id uuid references public.workspaces(id) on delete restrict;
```

The two delete actions pointing at `workspaces` are deliberately different:
`workspace_members` cascades (a membership row is meaningless without its
workspace) while `projects` restricts. In practice the cascade only ever fires for
an already-empty workspace, because the restrict has to be satisfied first.

Backfill, 1:1 — **the workspace inherits the project's id**. Project names may
duplicate, so name matching is unsafe, and id reuse removes any mapping ambiguity
without a temporary column. Id reuse across tables is already an idiom here:
`publish()` hands a local project's id to its new cloud row.

```sql
insert into public.workspaces (id, name, color, owner_id, created_at)
  select p.id, p.name, p.color, p.owner_id, p.created_at from public.projects p;

update public.projects set workspace_id = id;
alter table public.projects alter column workspace_id set not null;
create index projects_workspace_idx on public.projects (workspace_id);

-- Membership copies across unchanged, roles included. `on conflict do nothing`
-- is insurance only: `on_workspace_created` is created BELOW this point, so it
-- cannot have already written an owner row for a backfilled workspace.
insert into public.workspace_members (workspace_id, user_id, role, added_at)
  select pm.project_id, pm.user_id, pm.role, pm.added_at from public.project_members pm
  on conflict (workspace_id, user_id) do nothing;
```

Because every project becomes its own workspace carrying its own former member
list, post-migration visibility is identical to pre-migration visibility
(Requirement 9). Merging projects into one workspace is then a deliberate act by
the team, performed with the drag-and-drop this design adds — never a side effect
of deploying it.

Functions:

```sql
-- The new primitive. `security definer` is REQUIRED: a policy on
-- workspace_members that queried workspace_members would recurse.
create or replace function public.is_workspace_member(w uuid, u uuid)
returns boolean language sql security definer stable set search_path = public
as $$
  select exists (
    select 1 from public.workspace_members
    where workspace_id = w and user_id = u);
$$;

-- Redefined, same name and signature. The four tasks_* policies keep asking
-- "may this user reach this project?"; only the answer's derivation moved.
create or replace function public.is_project_member(p uuid, u uuid)
returns boolean language sql security definer stable set search_path = public
as $$
  select exists (
    select 1 from public.projects pr
    join public.workspace_members m on m.workspace_id = pr.workspace_id
    where pr.id = p and m.user_id = u);
$$;

-- Mirror of the retired handle_new_project(): the creator is owner AND first
-- member without a second round trip.
create or replace function public.handle_new_workspace()
returns trigger language plpgsql security definer set search_path = public
as $$
begin
  insert into public.workspace_members (workspace_id, user_id, role)
  values (new.id, new.owner_id, 'owner')
  on conflict (workspace_id, user_id) do nothing;
  return new;
end; $$;

create trigger on_workspace_created
  after insert on public.workspaces
  for each row execute function public.handle_new_workspace();

-- invite_project_member() one level up, same shape with one rule tightened: the
-- first statement IS the authorization rule, because `security definer` disables
-- RLS inside, and here it demands OWNERSHIP rather than mere membership
-- (Requirement 2). Email resolution must stay in the database: auth.users is
-- unreachable for `authenticated`, and mirroring addresses into profiles would
-- publish every teammate's email (profiles_select is `using (true)`).
create or replace function public.invite_workspace_member(p_workspace_id uuid, p_email text)
returns public.workspace_members
language plpgsql security definer set search_path = public
as $$
declare
  norm text := lower(nullif(trim(p_email), ''));
  target uuid;
  membership public.workspace_members;
begin
  if norm is null then raise exception 'email is required'; end if;

  if not exists (
       select 1 from public.workspaces w
       where w.id = p_workspace_id and w.owner_id = auth.uid()) then
    raise exception 'only the workspace owner can invite';
  end if;

  select u.id into target
    from auth.users u
    join public.profiles pr on pr.id = u.id
   where lower(u.email) = norm
   limit 1;

  if target is null then
    raise exception 'no Kermanych account for % — ask them to sign in with GitHub first', norm;
  end if;

  insert into public.workspace_members (workspace_id, user_id, role)
  values (p_workspace_id, target, 'member')
  on conflict (workspace_id, user_id) do nothing
  returning * into membership;

  if membership is null then
    select * into membership from public.workspace_members
     where workspace_id = p_workspace_id and user_id = target;
  end if;

  return membership;
end; $$;

revoke all on function public.invite_workspace_member(uuid, text) from public, anon;
grant execute on function public.invite_workspace_member(uuid, text) to authenticated;
```

`tasks_guard()` is redefined with exactly one clause changed — the force-`stopped`
escape hatch now resolves the **workspace** owner:

```sql
    if new.status is distinct from old.status
       and auth.uid() is distinct from old.assignee_id
       and auth.uid() is distinct from new.assignee_id
       and not (
         new.status = 'stopped'::task_status
         and exists (
           select 1 from public.projects p
           join public.workspaces w on w.id = p.workspace_id
           where p.id = old.project_id and w.owner_id = auth.uid())) then
      raise exception 'only the assignee can change status';
    end if;
```

Rules 2 and 3 (no reassign/delete while active, server-owned `updated_at`) are
unchanged.

Account deletion keeps the same guarantee one level up: `workspaces.owner_id` is
`not null on delete restrict`, so ownership must be handed over before an account
can be removed. `tasks.assignee_id` / `tasks.created_by` stay `on delete set null`.

## RLS policies

`workspaces` and `workspace_members` get RLS, the `anon` revoke, and the narrowest
grants. `workspace_members` deliberately gets **no INSERT grant at all** — no
policy will ever permit a client insert, and the RLS file's own rule is that "a
missing grant denies one layer earlier". (`project_members` held a redundant
INSERT grant; this does not reproduce it.)

```sql
alter table public.workspaces        enable row level security;
alter table public.workspace_members enable row level security;

revoke all on table public.workspaces        from anon;
revoke all on table public.workspace_members from anon;

grant select, insert, update, delete on table public.workspaces        to authenticated;
grant select,         update, delete on table public.workspace_members to authenticated;
```

| table | select | insert | update | delete |
|---|---|---|---|---|
| `workspaces` | `owner_id = auth.uid() or is_workspace_member(id, auth.uid())` | any authenticated, `owner_id = auth.uid()` | owner | owner (FK-blocked while it holds projects) |
| `workspace_members` | `is_workspace_member(workspace_id, auth.uid())` | **none** — `invite_workspace_member()` rpc + `on_workspace_created` trigger only | owner | owner |
| `projects` | `is_workspace_member(workspace_id, auth.uid())` | member of the target workspace | member of both old and new workspace | workspace owner |
| `tasks` | unchanged (`is_project_member(project_id, auth.uid())`) | unchanged | unchanged | unchanged |

The `owner_id = auth.uid() or` disjunct on `workspaces_select_member` is the same
load-bearing trick the old `projects_select_member` needed, moved up a level:
`insert … returning` evaluates the SELECT policy for the new row BEFORE the
`after insert` trigger has written the owner's membership row, so
`createWorkspace().select()` would come back empty without it. The owner is always
a member, so it widens nothing.

On `projects` the disjunct is **no longer needed and is removed**: the inserter is
already a member of the target workspace, so the SELECT policy passes immediately.

```sql
drop policy projects_select_member on public.projects;
drop policy projects_insert_own    on public.projects;
drop policy projects_update_owner  on public.projects;
drop policy projects_delete_owner  on public.projects;

create policy projects_select_member on public.projects
  for select to authenticated
  using (public.is_workspace_member(workspace_id, auth.uid()));

create policy projects_insert_member on public.projects
  for insert to authenticated
  with check (public.is_workspace_member(workspace_id, auth.uid()));

-- Requirement 4's last row, enforced by Postgres semantics rather than by an rpc:
-- USING is evaluated against the OLD row and WITH CHECK against the NEW one, so a
-- move needs membership of BOTH the source and the destination workspace. Neither
-- taking a project out of someone else's workspace nor pushing one into it is
-- expressible.
create policy projects_update_member on public.projects
  for update to authenticated
  using (public.is_workspace_member(workspace_id, auth.uid()))
  with check (public.is_workspace_member(workspace_id, auth.uid()));

create policy projects_delete_owner on public.projects
  for delete to authenticated
  using (exists (
    select 1 from public.workspaces w
    where w.id = workspace_id and w.owner_id = auth.uid()));
```

Teardown, last:

```sql
drop trigger on_project_created on public.projects;
drop function public.handle_new_project();
drop function public.invite_project_member(uuid, text);
drop table public.project_members;          -- takes members_* policies with it
alter table public.projects drop column owner_id;
```

Realtime is unchanged: `supabase_realtime` still carries `tasks` only. The project
list is already not live (`projects.load()` runs on mount), so a colleague's new
project or drag-and-drop appears on the next read, exactly as a new project does
today. Mitigation is a refetch after own mutations plus `installReconcile` on
`visibilitychange`.

## Data model — local SQLite

**No change.** No new column, no new table, no `user_version` bump. Verified: the
API reads only a fixed field whitelist off `CloudProject`
(`supervisor.service.ts:159-181` `syncProjects`, and the `patchProject` call inside
`createSessionFromTask`), none of which is `ownerId`; there is no `SELECT *`
anywhere in `apps/api/src`; and no runtime shape validation exists that an extra
cloud field could trip. `launch()` never reads a workspace, so caching one locally
would buy nothing for execution.

Offline sidebar grouping is a presentation concern and is cached in the UI (see
below), not in the registry.

## `@kermanych/cloud`

- `src/types.ts`: add `Workspace = { id, name, color?, ownerId, createdAt }` and
  `WorkspaceMember = { workspaceId, userId, role, addedAt, profile? }`.
  `CloudProject` gains `workspaceId: string` and **loses** `ownerId`.
- `src/workspaces.ts` (new), shaped exactly like `projects.ts`:
  `WORKSPACE_COLUMNS`, `WORKSPACE_MEMBER_COLUMNS`, `WorkspaceRow`,
  `WorkspaceMemberRow`, `toWorkspace`, `toWorkspaceRow`, `CloudWorkspacePatch`,
  `CloudWorkspaceInsert`, `listWorkspaces`, `createWorkspace`, `patchWorkspace`,
  `deleteWorkspace`, plus the membership trio moved up from `projects.ts`:
  `listMembers`, `inviteMember` (→ `invite_workspace_member` rpc, same
  trim/lowercase/regex pre-check and re-read for the joined profile),
  `removeMember`.
- `src/projects.ts`: `PROJECT_COLUMNS` drops `owner_id` and adds `workspace_id`;
  `ProjectRow`, `toCloudProject`, `toProjectRow` follow; `CloudProjectInsert`
  swaps `ownerId` for `workspaceId`; `CloudProjectPatch` gains `workspaceId`. The
  three membership functions leave this file.
- **No `moveProject()`.** Moving is `patchProject(id, { workspaceId })`. A refusal
  is visible for free, and the two refusals differ — verified on Postgres 17:
  pushing a project into a workspace you do not belong to violates WITH CHECK and
  raises `42501 new row violates row-level security policy`, while pulling one out
  of a workspace you are not in fails USING, which matches zero rows and surfaces
  through `.single()` as `PGRST116`. Both throw; neither is a silent no-op.
- `listProjects(client)` keeps taking no scope argument; RLS scopes it and the UI
  groups by `workspaceId`.
- `src/index.ts`: every new symbol re-exported **explicitly**. `export *` is
  documented in that file as breaking named bindings in the Vite-prebundled UI.

## UI

### Selection

`stores/orchestrator.ts` gains two fields and one action. `selectedProjectId` is
read at ~30 sites, nearly all of them genuinely project-scoped (folder binding,
env, settings, chat, launcher, git sync), so it is NOT replaced by a polymorphic
scope:

```ts
const selectedWorkspaceId = ref<string | undefined>(undefined);
// projectId -> workspaceId, pushed in by useProjects.load(). This store must not
// import useProjects (that store already depends on this one for notify/sync), so
// the map travels one way, downwards.
const projectWorkspace = ref<Record<string, string>>({});

function setProjectWorkspaces(map: Record<string, string>): void {
  projectWorkspace.value = map;
}
function selectWorkspace(id: string): void {
  selectedWorkspaceId.value = id;
  selectedProjectId.value = undefined;
  selectedSessionId.value = undefined;
}
function selectProject(id: string): void {
  selectedProjectId.value = id;
  selectedWorkspaceId.value = projectWorkspace.value[id];
  selectedSessionId.value = undefined;
}
```

`selectProject` keeps its one-argument signature because one of its three callers
cannot supply a workspace: `orchestrator.ts:91` jumps to a session's project from a
notification click and holds only `e.session.projectId`. Passing the workspace as
an optional argument would leave that path highlighting whatever workspace happened
to be selected — a workspace that need not contain the selected project. Resolving
through the map is correct for all three callers (`MainLayout.vue:445` from the
tree, `MainLayout.vue:678` after creating a project, and the notification handler).

A local-only project has no cloud row and therefore no entry in the map, so
selecting one clears `selectedWorkspaceId` rather than highlighting an unrelated
workspace. The board then shows zero tasks for it, which is honest — it has no
cloud tasks, and the «Опублікувати в хмарі» section already explains why.

Invariant: a selected project always keeps its own workspace selected too (both
highlighted in the tree); a selected workspace clears the project. Every existing
reader of `selectedProjectId` therefore keeps working unmodified — they already
handle `undefined`. `MainLayout.vue:443-450`'s `PROJECT_SCOPED_VIEWS` navigation
side effect is deleted: a sidebar click changes scope and never navigates
(Requirement 5).

### Pure logic in `src/lib/scope.ts`

The repo has no component tests — `apps/ui/test/*.spec.ts` are pure unit tests over
`lib/` with injected fakes. So the testable logic lives here, keeping `MainLayout`
and `BoardPage` thin:

- `groupProjectsByWorkspace(workspaces, projects)` → ordered groups + the
  local-only remainder.
- `scopedProjectIds(scope, projects)`.
- `filterTasks(tasks, { scopedProjectIds, projectFilter, assigneeFilter })`.
- `canDropProject(draggedProjectId, targetWorkspaceId, projects)`.

### Sidebar tree (`MainLayout.vue`, replacing lines 18-36)

```
Воркспейси                        [+]
▾ ● ААА                            KWorkspaceRow — click = workspace scope, drop target
      back-end                     KRailItem, indented, draggable
      admin
      mobile
                        [+ проєкт]  create a project INSIDE this workspace
▸ ● Інший воркспейс
─────────
Лише на цій машині                 pseudo-group, only when local-only rows exist
      old-project                   reuses the existing orphan/unbound states
```

New `KWorkspaceRow.vue` in `components/kit/`: chevron, colour dot, name, running-agent
count summed over its projects, active state, an add-project button on hover, and it
is the drop target. Two `+` buttons exist and they create different things: the one
beside the «Воркспейси» heading creates a **workspace**, the one on a workspace row
creates a **project inside that workspace**.

Three hit areas on the row, and they must not be conflated: **the chevron toggles
expansion only and never changes scope; the add-project button opens the create
modal for that workspace; the rest of the row sets the workspace scope and never
toggles expansion.** Both buttons therefore need `@click.stop`. Clicking an
already-selected workspace is a no-op, not a collapse.

`KRailItem.vue` gains `indent` and `draggable`. Expansion state persists in
`localStorage` under `kermanych.workspace-collapsed`, following the
`kermanych.sidebar-collapsed` idiom at `MainLayout.vue:434`. In the 76 px collapsed
rail the tree flattens to initials chips with a thin workspace-coloured left border
— grouping by colour, no separate mode.

### Drag-and-drop

Hand-rolled HTML5, no library: one gesture, ~40 lines, and a library would bring a
dependency plus its own reactivity model for it.

- `dragstart` on a project sets `dataTransfer.setData('application/x-kermanych-project', id)`
  and `effectAllowed = 'move'`.
- **`dataTransfer.getData()` is unreadable during `dragover`** (protected mode —
  only types are exposed), so the "is this a valid target" decision reads a
  module-scope `draggingProjectId = ref<string | undefined>()`; `dataTransfer`
  carries the payload for standard conformance only.
- `drop` patches the row in `projects.value` optimistically, calls
  `patchProject(id, { workspaceId })`, and on failure reverts and toasts.
- **Non-mouse equivalent, required:** the project settings modal gains a
  «Воркспейс» select driving the same `patchProject`. It is also the path when the
  destination workspace is collapsed or off-screen.

`KSelect` is extended to accept `options: string[] | { value: string; label: string }[]`,
backwards compatibly. Reason: the board's project filter is keyed by NAME today
(`BoardPage.vue:339 projectIdByName`), which breaks on duplicates — and duplicate
workspace names are plausible. That existing filter moves to ids in the same
change, removing a latent bug instead of adding a second one.

### Board (`BoardPage.vue`)

Header gains the scope name; the single filter becomes two.

```ts
const scopedProjectIds = computed(() =>
  store.selectedWorkspaceId
    ? projectsOfWorkspace(store.selectedWorkspaceId)
    : allCloudProjectIds.value);

const visibleTasks = computed(() => filterTasks(board.tasks, {
  scopedProjectIds: scopedProjectIds.value,
  projectFilter: projectFilter.value,
  assigneeFilter: assigneeFilter.value,
}));

watch(() => store.selectedProjectId, (id) => { projectFilter.value = id ?? ''; });
```

«Виконавці» lists the scoped workspace's members plus an explicit «Не призначено»
entry — unassigned tasks are a real category with no representation today. That
`watch` is Requirement 6: a sidebar project click pre-selects the filter, and a
manual change afterwards is not clobbered. The «Нова задача» modal's project picker
is scoped the same way.

**The Realtime channel must not narrow.** `stores/board.ts` keeps subscribing with
every visible project id; scope and filters are client-side only. A
`postgres_changes` filter cannot be edited in place, so narrowing per workspace
click would tear down and rebuild the channel on every click and would duplicate
the 100-id cap logic that already lives in the store.

### Agents (renamed `AgentsPage.vue`)

The session filter `s.projectId !== store.selectedProjectId`
(`WorkspacePage.vue:594`) generalises to `scopedProjectIds.includes(s.projectId)`;
the blank state becomes «Виберіть воркспейс або проєкт».

### Stores

`stores/projects.ts`: add `workspaces`, `projectsByWorkspace`; `members` re-keys
from project id to workspace id; `create(name, remote)` → `create(workspaceId, name, remote)`;
`publish(local)` → `publish(local, workspaceId)`; add `createWorkspace`,
`patchWorkspace`, `removeWorkspace`, `moveProject(projectId, workspaceId)`.
`isOwner(projectId)` keeps its name and signature but resolves through the
workspace — the same symmetry as the `is_project_member` wrapper, which keeps its
four callers (`MainLayout.vue:717`, `BoardPage.vue:533`, `WorkspacePage.vue:1474`)
unrewritten.

`load()` also fetches workspaces and, after every successful read, pushes the
`projectId → workspaceId` map into the orchestrator via `setProjectWorkspaces()`
(the one-way dependency described under Selection) and writes the tree
(`[{id,name,color}]` plus that same map) to `localStorage`. The cache is read back
at store init, before the first network call, which removes both the offline
collapse to a flat list and the cold-start flicker. A cached entry for a project
that is no longer visible is harmless: the tree only renders workspaces that
`listWorkspaces` returned, and RLS decides that.

### Permission gates that must be relaxed

Requirement 4 makes project config member-editable, so the settings modal in
`MainLayout.vue` drops its `isOwnerOfSelected` gate from eight controls (lines 193,
198, 204, 213, 219, 225, 231, 294), from `envKeys` (340) and from the explanatory
hint (233-236). Exactly one owner-only control remains: «Видалити проєкт» (288).
The members panel (259-260) moves out of project settings into a new workspace
settings modal: name, colour, the member list, invite by email and remove — both
owner-only per Requirement 2, so a plain member sees the roster read-only — and
«Видалити воркспейс», owner-only and disabled while the workspace holds projects,
with the reason shown.

## Rollout

This is a **coordinated cutover**, and the breakage window is real: the migration
drops `projects.owner_id`, which the currently shipped `PROJECT_COLUMNS` selects,
so any client that has not pulled will get a PostgREST error on the project list
and the board. README already documents the mirror-image failure (`PGRST202` from
an unpushed `invite_project_member`).

- **Chosen (a): coordinated.** Announce, `supabase db push --linked`, everyone
  pulls immediately. The window is minutes; the team is small and runs from a
  clone.
- **(b) Two-phase**, if coordination is impossible: M1 additive only (`workspaces`,
  `workspace_members`, nullable `workspace_id`, backfill, functions, policies) with
  `project_members` and `owner_id` still present; M2 drops them a release later.
  Zero breakage, cost is two migrations and one release in which both shapes exist.

## Verification

**Migration rehearsal — `scripts/verify-workspace-migration.ts`, run once before
`db push`.** The riskiest claim is Requirement 9, and it cannot be covered by a
permanent test: `supabase db reset` runs the backfill over an empty database, and
after the migration the pre-state is unreachable. So the check is a scripted
rehearsal on a local stack: check out the pre-migration commit, `db reset`, seed
two users and two projects with crossed membership plus tasks through the admin
API, record who sees what, `supabase migration up`, and diff visibility before
against after. The script stays in the repo as documentation of the check.

**`packages/cloud` unit** (vitest, `test/*.spec.ts`, the thenable `fakeClient`
recorder):
- `workspaces.spec.ts` — column lists, mappers, email trim/lowercase and refusals,
  rpc-then-reread, `deleteWorkspace`.
- `projects.spec.ts` — updated for `-ownerId +workspaceId`; `patchProject({ workspaceId })`
  builds the expected update.

**`packages/cloud/test/rls.spec.ts`** — the security boundary, actors via
`makeUser`:
- `on_workspace_created` writes the owner's membership row.
- `createWorkspace().select()` returns the row (proves the disjunct is still
  load-bearing at the new level).
- a workspace member sees every project and task in it — including a project they
  were never a "project member" of, which is what the `is_project_member` wrapper
  is for.
- a non-member sees zero projects and zero tasks; `anon` sees nothing.
- a direct `insert` into `workspace_members` is refused (`42501`) even for the owner.
- `invite_workspace_member`: a plain member is refused (`only the workspace owner
  can invite`), a non-member is refused, an unknown email is refused, the owner
  succeeds, and re-inviting the same person is an idempotent no-op returning the
  existing row.
- **move**: a member of both workspaces succeeds; a member of only the source
  cannot push a project into a workspace they do not belong to (WITH CHECK); a
  non-member cannot pull one out (USING).
- project delete: member refused, workspace owner succeeds.
- workspace delete: refused by FK while it holds projects, succeeds once empty.
- `tasks_guard` force-`stopped`: workspace owner succeeds, plain member refused,
  assignee still succeeds; and no other status is permitted to the owner.

**`apps/ui/test/scope.spec.ts`** — `groupProjectsByWorkspace`, `scopedProjectIds`,
`filterTasks` (including «Не призначено»), `canDropProject`.

**`apps/api`** — source untouched; only the `CloudProject` fixtures in
`test/sessions.from-task.spec.ts` change. The suite runs as a regression gate.

**Manual smoke, required pre-merge.** Two accounts: A creates a workspace and three
projects and invites B; B sees all three; B drags `admin` into a workspace A is not
in → legible refusal; drags into a shared one → it moves; board scope plus both
filters; clicking a project pre-selects «Проєкти»; and one task run to `done`,
proving the local execution path is untouched.

## Non-goals

- No manual ordering of projects or workspaces (not requested; order stays
  `created_at`).
- No dragging task cards between board columns.
- No nested workspaces.
- No per-project guests — membership is workspace-only, so a project's audience is
  exactly its workspace's.
- No Realtime for `workspaces` or `projects`; the tree reconciles by refetch.
- No keyboard drag-and-drop; the «Воркспейс» select is the accessible path.
- No `workspace_id` on `tasks`, and no workspace knowledge in `packages/core`,
  `apps/api`, or the local SQLite registry.
- No change to task statuses, the outbox, the status mirror, or `omp` execution.
- No i18n layer; UI copy stays Ukrainian inline, identifiers English.
