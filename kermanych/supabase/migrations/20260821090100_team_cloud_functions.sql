-- Kermanych team cloud — triggers and the one policy helper.
-- `security definer` is used in exactly three places, each justified inline.

-- The team allowlist. The repository is PUBLIC and sign-in is GitHub OAuth, so
-- without this table any GitHub account on earth could sign in and consume the
-- team's backend quota (RLS would isolate their rows, but they would still be
-- users). Sign-in therefore fails CLOSED: `handle_new_user()` refuses any GitHub
-- login name that is not listed here, and an EMPTY table admits NOBODY.
--
-- This is operator data, not application data: it is edited in Studio or psql as
-- `postgres`, and no client role gets a single privilege on it (see the revoke
-- below). Only the `security definer` trigger reads it.
--   insert into allowed_github_users (github_username, note)
--   values ('octocat', 'Jane, backend');
create table public.allowed_github_users (
  github_username text primary key,
  added_at timestamptz not null default now(),
  note text);

comment on table public.allowed_github_users is
  'GitHub login names permitted to sign in. handle_new_user() refuses anyone absent, case-insensitively; an empty table admits nobody. Operator-managed (psql/Studio as postgres) — anon and authenticated hold no privileges.';

-- RLS on with no policies at all: even if a grant ever leaked in, every client
-- statement still matches nothing. The revoke is the primary lock — Supabase
-- grants new public tables to anon and authenticated by default.
alter table public.allowed_github_users enable row level security;
revoke all on table public.allowed_github_users from anon, authenticated;

-- First sign-in provisions the profile from GitHub's OAuth metadata. Must be
-- `security definer`: the inserting role is the auth service, not the new user,
-- and profiles has no INSERT policy at all (spec's RLS matrix: "trigger only").
-- It is also where the team allowlist is enforced, because raising here aborts
-- the `auth.users` insert itself — a refused account never exists.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  handle text := nullif(trim(new.raw_user_meta_data ->> 'user_name'), '');
begin
  -- Fail closed. A null/blank handle (a provider that sent no GitHub login, or a
  -- password user minted through the admin API) can never match a row, so the
  -- `handle is null` arm only exists to give the operator a better log line.
  -- The primary key already indexes github_username; the lower() comparison is a
  -- sequential scan over a table with one row per teammate, which is free.
  if handle is null or not exists (
       select 1 from public.allowed_github_users a
       where lower(a.github_username) = lower(handle)) then
    raise exception 'github user % is not on the Kermanych team allowlist',
      coalesce(handle, '(unknown)');
  end if;

  insert into public.profiles (id, github_username, display_name, avatar_url)
  values (
    new.id,
    handle,
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
    --
    --    One exception, and exactly one: the project's OWNER may force 'stopped'.
    --    There is no heartbeat (spec Non-goals), so a status written by a machine
    --    that then crashes persists forever — and rules 2/3 below refuse to
    --    reassign or delete an active task, which would leave the card permanently
    --    stuck. The assignee can already unstick it from any machine via rule 1;
    --    this covers the assignee being gone for good. It is deliberately the
    --    narrowest possible escape hatch: 'stopped' only, owner only. An owner
    --    still cannot park a task in 'thinking', 'done' or anything else.
    if new.status is distinct from old.status
       and auth.uid() is distinct from old.assignee_id
       and auth.uid() is distinct from new.assignee_id
       and not (
         new.status = 'stopped'::task_status
         and exists (
           select 1 from public.projects p
           where p.id = old.project_id and p.owner_id = auth.uid())) then
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
