-- Kermanych workspaces — a grouping level ABOVE projects.
--
-- This reverses the non-goal "No team/workspace layer above projects (flat
-- owner/member)" from docs/superpowers/specs/2026-08-21-team-cloud-design.md:620.
-- Reason: per-project invitation is O(projects x people) for a team whose projects
-- are one product, and a flat list cannot answer "what is the state of product AAA".
--
-- Membership moves UP: workspace_members replaces project_members, and a project
-- stops having an owner of its own. See
-- docs/superpowers/specs/2026-08-27-workspaces-design.md.

create table public.workspaces (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  color text,
  -- `on delete restrict` mirrors what projects.owner_id used to guarantee: ownership
  -- must be handed over before an account can be deleted. No orphan groups.
  owner_id uuid not null references public.profiles(id) on delete restrict,
  created_at timestamptz not null default now());

create table public.workspace_members (
  workspace_id uuid not null references public.workspaces on delete cascade,
  user_id uuid not null references public.profiles on delete cascade,
  role text not null check (role in ('owner','member')),
  added_at timestamptz not null default now(),
  primary key (workspace_id, user_id));

create index workspace_members_user_idx on public.workspace_members (user_id);

-- The new membership primitive. `security definer` is REQUIRED: a policy on
-- workspace_members that queried workspace_members would recurse. `stable` lets the
-- planner call it once per statement.
create or replace function public.is_workspace_member(w uuid, u uuid)
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select exists (
    select 1 from public.workspace_members
    where workspace_id = w and user_id = u);
$$;

-- Mirror of handle_new_project() (dropped once projects move under workspaces): the
-- creator is owner AND first member without a second round trip. `security definer`
-- because workspace_members has no INSERT policy at all.
create or replace function public.handle_new_workspace()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.workspace_members (workspace_id, user_id, role)
  values (new.id, new.owner_id, 'owner')
  on conflict (workspace_id, user_id) do nothing;
  return new;
end;
$$;

create trigger on_workspace_created
  after insert on public.workspaces
  for each row execute function public.handle_new_workspace();

-- invite_project_member() (20260823130000_invite_members_by_email.sql) one level up,
-- with ONE rule tightened. The first statement IS the authorization rule, because
-- `security definer` disables RLS inside — and here it demands OWNERSHIP rather than
-- mere membership: an invitation now grants access to every project in the
-- workspace, a strictly wider grant than the project-level rule it replaces.
--
-- Email resolution must stay in the database: auth.users is unreachable for the
-- `authenticated` role, and mirroring addresses into profiles would publish every
-- teammate's email, since profiles_select is `using (true)`.
create or replace function public.invite_workspace_member(p_workspace_id uuid, p_email text)
returns public.workspace_members
language plpgsql
security definer
set search_path = public
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

  -- The join against profiles is what makes "already uses Kermanych" a hard
  -- requirement: only handle_new_user() writes that row.
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

  -- `do nothing` returns no row, so a repeat invite reports the existing membership
  -- instead of failing.
  if membership is null then
    select * into membership from public.workspace_members
     where workspace_id = p_workspace_id and user_id = target;
  end if;

  return membership;
end;
$$;

comment on function public.invite_workspace_member(uuid, text) is
  'Adds the holder of an email address to a workspace as ''member''. Owner-only. The address must already belong to a Kermanych account; no pending-invitation state exists. Idempotent. Never returns an email.';

revoke all on function public.invite_workspace_member(uuid, text) from public, anon;
grant execute on function public.invite_workspace_member(uuid, text) to authenticated;

-- ── RLS for the two new tables ────────────────────────────────────────────────
alter table public.workspaces        enable row level security;
alter table public.workspace_members enable row level security;

-- Defensive: config.toml leaves auto_expose_new_tables unset, so nothing is granted to
-- anon implicitly — this revoke is what survives someone turning it back on.
revoke all on table public.workspaces        from anon;
revoke all on table public.workspace_members from anon;

-- Neither INSERT nor UPDATE is granted on workspace_members: no policy will ever
-- permit either, and a missing grant denies one layer earlier than a missing policy. A
-- membership row is created by the rpc or the trigger — both `security definer`, so
-- they need no grant here — and destroyed by the owner. It is never edited: no
-- role-change feature exists, and an UPDATE path would let an owner rewrite `user_id`
-- or `role`, which is exactly the forgery the missing INSERT grant prevents.
grant select, insert, update, delete on table public.workspaces        to authenticated;
grant select,                 delete on table public.workspace_members to authenticated;

-- `owner_id = auth.uid() or` is not redundancy: INSERT … RETURNING evaluates the
-- SELECT policy for the returned row BEFORE the AFTER-INSERT trigger has created the
-- owner's membership row, so createWorkspace().select() would come back empty
-- without it. The owner is always a member, so this widens nothing. (Same trick the
-- old projects_select_member needed — it moved up one level.)
create policy workspaces_select_member on public.workspaces
  for select to authenticated
  using (owner_id = auth.uid() or public.is_workspace_member(id, auth.uid()));

create policy workspaces_insert_own on public.workspaces
  for insert to authenticated
  with check (owner_id = auth.uid());

create policy workspaces_update_owner on public.workspaces
  for update to authenticated
  using (owner_id = auth.uid())
  with check (owner_id = auth.uid());

create policy workspaces_delete_owner on public.workspaces
  for delete to authenticated
  using (owner_id = auth.uid());

create policy workspace_members_select_member on public.workspace_members
  for select to authenticated
  using (public.is_workspace_member(workspace_id, auth.uid()));

create policy workspace_members_delete_owner on public.workspace_members
  for delete to authenticated
  using (exists (
    select 1 from public.workspaces w
    where w.id = workspace_id and w.owner_id = auth.uid()));

-- ── projects gain their parent ────────────────────────────────────────────────
-- `on delete restrict`, NOT cascade: deleting a workspace must not silently take
-- its projects and every task on them with it. The refusal is legible, which is the
-- same choice projects.owner_id already made for account deletion.
alter table public.projects
  add column workspace_id uuid references public.workspaces(id) on delete restrict;

-- 1:1 backfill. The workspace INHERITS the project's id: project names may
-- duplicate, so matching by name is unsafe, and id reuse removes every mapping
-- ambiguity without a temporary column. Reusing an id across tables is already an
-- idiom here — publish() hands a local project's id to its new cloud row.
--
-- Because each project becomes its own workspace carrying its own former member
-- list, visibility after this migration is IDENTICAL to visibility before it.
-- Merging projects into one workspace is then a deliberate act by the team, done
-- with drag-and-drop — never a side effect of deploying this.
insert into public.workspaces (id, name, color, owner_id, created_at)
  select p.id, p.name, p.color, p.owner_id, p.created_at from public.projects p;

update public.projects set workspace_id = id;
alter table public.projects alter column workspace_id set not null;
create index projects_workspace_idx on public.projects (workspace_id);

-- Membership copies across. `do update` rather than `do nothing`: on_workspace_created
-- was created ABOVE, so the insert into workspaces already wrote each backfilled
-- workspace's owner row with `added_at = now()`. This clause restores the role and the
-- ORIGINAL join date from project_members — the only place that history exists before
-- the table is dropped below, so `do nothing` would destroy every owner's join date
-- irreversibly. It cannot change anyone's role: handle_new_project() is the sole writer
-- of an 'owner' row and invite_project_member() only ever inserts 'member', so
-- excluded.role always matches what the trigger wrote. An owner with no
-- project_members row at all (an anomaly the old schema permits) simply keeps the
-- migration timestamp — there is no earlier date to restore.
insert into public.workspace_members (workspace_id, user_id, role, added_at)
  select pm.project_id, pm.user_id, pm.role, pm.added_at from public.project_members pm
  on conflict (workspace_id, user_id) do update
    set role = excluded.role, added_at = excluded.added_at;

-- ── the wrapper ───────────────────────────────────────────────────────────────
-- Redefined, same name and signature, so the four tasks_* policies stay TEXTUALLY
-- UNCHANGED. Their question — "may this user reach this project?" — is still
-- exactly right; only the derivation moved up a level. Redefined BEFORE
-- project_members is dropped: function bodies are not dependency-tracked, so a
-- stale body would fail at runtime instead of here.
create or replace function public.is_project_member(p uuid, u uuid)
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select exists (
    select 1
    from public.projects pr
    join public.workspace_members m on m.workspace_id = pr.workspace_id
    where pr.id = p and m.user_id = u);
$$;

-- ── tasks_guard: the force-stop hatch follows ownership upwards ───────────────
-- Only the owner clause changes. Rules 2 and 3 (no reassign/delete while active,
-- server-owned updated_at) are reproduced verbatim from
-- 20260821090100_team_cloud_functions.sql. Redefined BEFORE projects.owner_id is
-- dropped, for the same dependency-tracking reason as above.
create or replace function public.tasks_guard()
returns trigger
language plpgsql
as $$
declare
  active_statuses task_status[] := array['queued','thinking','tool','waiting_input']::task_status[];
begin
  if tg_op = 'UPDATE' then
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
    if new.assignee_id is distinct from old.assignee_id
       and old.status = any (active_statuses) then
      raise exception 'task is active';
    end if;
    new.updated_at := now();
    return new;
  end if;

  if tg_op = 'DELETE' then
    if old.status = any (active_statuses) then
      raise exception 'task is active';
    end if;
    return old;
  end if;

  return new;
end;
$$;

-- ── projects policies ─────────────────────────────────────────────────────────
drop policy projects_select_member on public.projects;
drop policy projects_insert_own    on public.projects;
drop policy projects_update_owner  on public.projects;
drop policy projects_delete_owner  on public.projects;

-- The `owner_id = auth.uid() or` disjunct the old version needed is GONE, and this
-- is not an oversight: the inserter is already a member of the target workspace, so
-- the SELECT policy passes for INSERT … RETURNING without help.
create policy projects_select_member on public.projects
  for select to authenticated
  using (public.is_workspace_member(workspace_id, auth.uid()));

create policy projects_insert_member on public.projects
  for insert to authenticated
  with check (public.is_workspace_member(workspace_id, auth.uid()));

-- One policy, two guarantees: USING is evaluated against the OLD row and WITH CHECK
-- against the NEW one, so moving a project needs membership of BOTH the source and
-- the destination workspace. Neither taking a project out of someone else's
-- workspace nor pushing one into it is expressible.
create policy projects_update_member on public.projects
  for update to authenticated
  using (public.is_workspace_member(workspace_id, auth.uid()))
  with check (public.is_workspace_member(workspace_id, auth.uid()));

create policy projects_delete_owner on public.projects
  for delete to authenticated
  using (exists (
    select 1 from public.workspaces w
    where w.id = workspace_id and w.owner_id = auth.uid()));

-- ── retire the project level of membership ────────────────────────────────────
drop trigger on_project_created on public.projects;
drop function public.handle_new_project();
drop function public.invite_project_member(uuid, text);
drop table public.project_members;          -- takes members_* policies with it
alter table public.projects drop column owner_id;
