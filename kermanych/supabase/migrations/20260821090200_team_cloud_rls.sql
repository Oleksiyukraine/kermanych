-- Kermanych team cloud — RLS is the ONLY authorization surface. The UI's
-- pre-checks are UX; this file is the security boundary.

alter table public.profiles        enable row level security;
alter table public.projects        enable row level security;
alter table public.project_members enable row level security;
alter table public.tasks           enable row level security;

-- Nothing is reachable with the anon key alone. Supabase's default privileges
-- grant new public tables to anon, so this revoke is load-bearing.
revoke all on table public.profiles        from anon;
revoke all on table public.projects        from anon;
revoke all on table public.project_members from anon;
revoke all on table public.tasks           from anon;

-- Grant only the verbs the policy matrix can ever allow. Belt and braces: a
-- missing policy already denies, but a missing grant denies one layer earlier.
grant select, update                         on table public.profiles        to authenticated;
grant select, insert, update, delete         on table public.projects        to authenticated;
grant select, insert, update, delete         on table public.project_members to authenticated;
grant select, insert, update, delete         on table public.tasks           to authenticated;

-- ── profiles ──────────────────────────────────────────────────────────────────
-- Any authenticated user may read any profile: the board shows assignee names
-- and avatars, and members are added by GitHub username.
create policy profiles_select on public.profiles
  for select to authenticated
  using (true);

create policy profiles_update_own on public.profiles
  for update to authenticated
  using (id = auth.uid())
  with check (id = auth.uid());

-- No INSERT and no DELETE policy: rows arrive only via handle_new_user()
-- (security definer) and leave only by auth.users cascade.

-- ── projects ──────────────────────────────────────────────────────────────────
-- `owner_id = auth.uid() or` is not redundancy: INSERT … RETURNING evaluates the
-- SELECT policy for the returned row BEFORE the AFTER-INSERT trigger has created
-- the owner's project_members row, so createProject().select() would come back
-- empty without it. The owner is always a member, so this widens nothing.
create policy projects_select_member on public.projects
  for select to authenticated
  using (owner_id = auth.uid() or public.is_project_member(id, auth.uid()));

create policy projects_insert_own on public.projects
  for insert to authenticated
  with check (owner_id = auth.uid());

create policy projects_update_owner on public.projects
  for update to authenticated
  using (owner_id = auth.uid())
  with check (owner_id = auth.uid());

create policy projects_delete_owner on public.projects
  for delete to authenticated
  using (owner_id = auth.uid());

-- ── project_members ───────────────────────────────────────────────────────────
create policy members_select_member on public.project_members
  for select to authenticated
  using (public.is_project_member(project_id, auth.uid()));

create policy members_insert_owner on public.project_members
  for insert to authenticated
  with check (exists (
    select 1 from public.projects p
    where p.id = project_id and p.owner_id = auth.uid()));

create policy members_update_owner on public.project_members
  for update to authenticated
  using (exists (
    select 1 from public.projects p
    where p.id = project_id and p.owner_id = auth.uid()))
  with check (exists (
    select 1 from public.projects p
    where p.id = project_id and p.owner_id = auth.uid()));

create policy members_delete_owner on public.project_members
  for delete to authenticated
  using (exists (
    select 1 from public.projects p
    where p.id = project_id and p.owner_id = auth.uid()));

-- ── tasks ─────────────────────────────────────────────────────────────────────
create policy tasks_select_member on public.tasks
  for select to authenticated
  using (public.is_project_member(project_id, auth.uid()));

create policy tasks_insert_member on public.tasks
  for insert to authenticated
  with check (
    public.is_project_member(project_id, auth.uid())
    and created_by = auth.uid());

-- Any member may update (assign, edit, claim); tasks_guard() enforces the
-- cross-row invariants RLS cannot express (assignee-only status, active lock).
create policy tasks_update_member on public.tasks
  for update to authenticated
  using (public.is_project_member(project_id, auth.uid()))
  with check (public.is_project_member(project_id, auth.uid()));

create policy tasks_delete_member on public.tasks
  for delete to authenticated
  using (public.is_project_member(project_id, auth.uid()));
