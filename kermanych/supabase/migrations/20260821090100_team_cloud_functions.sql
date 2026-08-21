-- Kermanych team cloud — triggers and the one policy helper.
-- `security definer` is used in exactly three places, each justified inline.

-- First sign-in provisions the profile from GitHub's OAuth metadata. Must be
-- `security definer`: the inserting role is the auth service, not the new user,
-- and profiles has no INSERT policy at all (spec's RLS matrix: "trigger only").
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, github_username, display_name, avatar_url)
  values (
    new.id,
    new.raw_user_meta_data ->> 'user_name',
    new.raw_user_meta_data ->> 'full_name',
    new.raw_user_meta_data ->> 'avatar_url')
  on conflict (id) do nothing;
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- The creator of a project is its owner AND its first member, without the client
-- needing a second round trip. `security definer` because project_members' INSERT
-- policy requires an existing owner row, which does not exist yet at this instant.
create or replace function public.handle_new_project()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.project_members (project_id, user_id, role)
  values (new.id, new.owner_id, 'owner')
  on conflict (project_id, user_id) do nothing;
  return new;
end;
$$;

create trigger on_project_created
  after insert on public.projects
  for each row execute function public.handle_new_project();

-- The single membership predicate every policy calls. `security definer` is
-- REQUIRED: a policy on project_members that queried project_members would
-- recurse. `stable` lets the planner call it once per statement.
create or replace function public.is_project_member(p uuid, u uuid)
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select exists (
    select 1 from public.project_members
    where project_id = p and user_id = u);
$$;

-- Cross-row invariants RLS cannot express. Deliberately NOT `security definer`:
-- it must see auth.uid() of the actual caller.
create or replace function public.tasks_guard()
returns trigger
language plpgsql
as $$
declare
  active_statuses task_status[] := array['queued','thinking','tool','waiting_input']::task_status[];
begin
  if tg_op = 'UPDATE' then
    -- 1. Only the assignee moves a task's status. The self-assign case is allowed
    --    because claim + status can land in one statement, in which case the new
    --    assignee is the caller.
    if new.status is distinct from old.status
       and auth.uid() is distinct from old.assignee_id
       and auth.uid() is distinct from new.assignee_id then
      raise exception 'only the assignee can change status';
    end if;
    -- 2. An active task cannot be handed to someone else mid-run.
    if new.assignee_id is distinct from old.assignee_id
       and old.status = any (active_statuses) then
      raise exception 'task is active';
    end if;
    -- 3. updated_at is server-owned; the UI reads its age for the stale hint.
    new.updated_at := now();
    return new;
  end if;

  if tg_op = 'DELETE' then
    -- 2 (delete half). Stop the board first, then delete the card.
    if old.status = any (active_statuses) then
      raise exception 'task is active';
    end if;
    return old;
  end if;

  return new;
end;
$$;

create trigger tasks_guard_trigger
  before insert or update or delete on public.tasks
  for each row execute function public.tasks_guard();
