-- Kermanych team cloud — coordination schema.
-- Execution stays local: this database holds users, projects, membership and task
-- cards ONLY. No transcripts, no tool events, no secret values, ever.

-- Mirrors @kermanych/core SessionStatus (packages/core/src/types.ts:4-5) exactly.
-- 'backlog' exists only in the cloud; from 'queued' on, the local session is the
-- source of truth and pushes coarse status back.
create type task_status as enum (
  'backlog','queued','thinking','tool','waiting_input',
  'done','error','stopped','merged','conflict');

-- One row per auth.users row, filled by the handle_new_user trigger.
create table profiles (
  id uuid primary key references auth.users on delete cascade,
  github_username text,
  display_name text,
  avatar_url text,
  created_at timestamptz not null default now());

-- The cloud project. Its id is ALSO the local SQLite projects.id on every machine
-- (spec D1), so a project is one identity across the team.
create table projects (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  git_remote_url text,                    -- informational only; no auto-clone
  conventions text,
  preview_command text,
  api_command text,
  default_branch text,
  carry_files text[] not null default array['.env'],
  env_keys text[] not null default '{}',  -- NAMES only, never values
  color text,
  owner_id uuid not null references profiles(id) on delete restrict,
  created_at timestamptz not null default now());

create table project_members (
  project_id uuid not null references projects on delete cascade,
  user_id uuid not null references profiles on delete cascade,
  role text not null check (role in ('owner','member')),
  added_at timestamptz not null default now(),
  primary key (project_id, user_id));

-- A task is a card born in the cloud; a session is its local execution.
-- model/prefix/platform/kind/branch are the launch params the assignee's machine
-- feeds into registry.createSession().
create table tasks (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects on delete cascade,
  title text not null,
  description text,
  status task_status not null default 'backlog',
  assignee_id uuid references profiles(id) on delete set null,
  created_by uuid references profiles(id) on delete set null,
  model text,
  prefix text,
  platform text,
  kind text,
  branch text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now());

create index tasks_project_idx on tasks (project_id);
create index members_user_idx on project_members (user_id);

-- Realtime is the board engine: a status push from anyone's local Nest, or an
-- assignment from anyone's UI, fans out through this publication. RLS still
-- applies, so a member only ever receives rows from their own projects.
alter publication supabase_realtime add table tasks;
