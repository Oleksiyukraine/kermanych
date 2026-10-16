-- Routines: scheduled tasks of a workspace or of one of its projects
-- (docs/specs/2026-10-16-routines.md). Additive only — two new tables, nothing existing is
-- altered, so it is safe to push before the client that reads it ships.
--
-- Shape of trust. A routine is DEFINED here, where the whole team can see it, and RUN by exactly
-- one runner (`runner`):
--   local — the local api of the member who created it (`created_by`), while Kermanych is open
--           and signed in there, with that member's JWT, Slack user token, checkouts and plan;
--   cloud — the workspace's cloud runner (20261016100000_routines_cloud_runner.sql and the
--           routines-runner Edge Function), with the workspace's own keys, whoever is online.
-- Either way it acts on the author's decision, which is why only the author may change what it
-- does (the touch trigger below) while the workspace owner may still pause or delete it.
--
-- Exactly-once. A run is CLAIMED by inserting its row: `(routine_id, scheduled_for)` is unique,
-- so the author signed in on two computers, or an api restarted mid-minute, cannot run one
-- occurrence twice — the second insert is a unique violation the runner drops. Manual runs have
-- no `scheduled_for` and are not deduplicated (NULLs are distinct).
--
-- Deliberately NOT added to supabase_realtime: the runner tells its own window over the local
-- socket, and every other member's screen refetches on open (the release-notes call).

-- ── 1. routines ───────────────────────────────────────────────────────────────

create table public.workspace_routines (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  -- Null = a workspace routine. A project routine means nothing without its project, so it goes
  -- with it; the trigger keeps the project inside the routine's workspace.
  project_id   uuid references public.projects(id) on delete cascade,
  name         text not null check (length(trim(name)) between 1 and 120),

  -- packages/core/src/routines.ts owns both vocabularies (`RoutineAction`, `RoutineSchedule`);
  -- the checks here only keep a row from naming a kind nobody runs.
  action       jsonb not null check (
    jsonb_typeof(action) = 'object' and action ->> 'kind' in ('prompt', 'release_notes')),
  schedule     jsonb not null check (
    jsonb_typeof(schedule) = 'object'
    and schedule ->> 'kind' in ('manual', 'once', 'hourly', 'daily', 'weekdays', 'weekly', 'monthly')),
  -- IANA zone the schedule's wall-clock times are read in — the author's, captured by the editor.
  timezone     text not null check (length(trim(timezone)) > 0),
  -- The channel a run's document is posted to, as the author: { teamId, channelId, channelName }.
  -- Slack ids, no secrets — the author's user token stays in their machine's registry.
  slack        jsonb check (slack is null or jsonb_typeof(slack) = 'object'),
  -- Where it runs (packages/core `ROUTINE_RUNNERS`).
  runner       text not null default 'local' check (runner in ('local', 'cloud')),

  enabled      boolean not null default true,
  -- Server-owned: the moment the schedule last started counting. An occurrence at or before it
  -- is never run, so saving a new time, or resuming a paused routine, never fires the past.
  armed_at     timestamptz not null default now(),

  created_at   timestamptz not null default now(),
  created_by   uuid references auth.users(id) on delete set null,
  updated_at   timestamptz not null default now(),
  updated_by   uuid references auth.users(id) on delete set null
);

-- The screen reads one workspace at a time; the runner reads its author's enabled rows.
create index workspace_routines_workspace_idx on public.workspace_routines (workspace_id, created_at);
create index workspace_routines_runner_idx on public.workspace_routines (runner, created_by) where enabled;

grant select, insert, update, delete on table public.workspace_routines to authenticated;

create policy workspace_routines_select_member on public.workspace_routines for select to authenticated
  using (public.is_workspace_member(workspace_id, auth.uid()));

create policy workspace_routines_insert_member on public.workspace_routines for insert to authenticated
  with check (public.is_workspace_member(workspace_id, auth.uid()));

-- The author or the workspace owner. WHAT the owner may change is narrowed by the trigger: only
-- `enabled`, because everything else is the author speaking.
create policy workspace_routines_update_author on public.workspace_routines for update to authenticated
  using (
    public.is_workspace_member(workspace_id, auth.uid())
    and (created_by = auth.uid() or public.is_workspace_owner(workspace_id, auth.uid())))
  with check (public.is_workspace_member(workspace_id, auth.uid()));

create policy workspace_routines_delete_author on public.workspace_routines for delete to authenticated
  using (created_by = auth.uid() or public.is_workspace_owner(workspace_id, auth.uid()));

alter table public.workspace_routines enable row level security;

create or replace function public.workspace_routines_touch() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    new.created_at := now();
    new.created_by := auth.uid();
    new.armed_at   := now();
  else
    new.workspace_id := old.workspace_id;
    new.created_at   := old.created_at;
    new.created_by   := old.created_by;
    -- A routine acts in its author's name, so only the author changes what it does. Anyone the
    -- policy admits (the owner) may still switch it on or off.
    if auth.uid() is distinct from old.created_by
       and (new.name, new.project_id, new.runner, new.action, new.schedule, new.timezone, new.slack)
           is distinct from (old.name, old.project_id, old.runner, old.action, old.schedule, old.timezone, old.slack) then
      raise exception 'only the author of a routine can change what it does' using errcode = '42501';
    end if;
    if new.schedule is distinct from old.schedule
       or new.timezone is distinct from old.timezone
       or new.runner is distinct from old.runner
       or (new.enabled and not old.enabled) then
      new.armed_at := now();
    else
      new.armed_at := old.armed_at;
    end if;
  end if;
  if new.project_id is not null and not exists (
    select 1 from public.projects p where p.id = new.project_id and p.workspace_id = new.workspace_id) then
    raise exception 'the project is not in this workspace' using errcode = '23514';
  end if;
  new.updated_at := now();
  new.updated_by := auth.uid();
  return new;
end;
$$;

create trigger workspace_routines_touch
  before insert or update on public.workspace_routines
  for each row execute function public.workspace_routines_touch();

-- ── 2. runs ───────────────────────────────────────────────────────────────────

create table public.workspace_routine_runs (
  id            uuid primary key default gen_random_uuid(),
  routine_id    uuid not null references public.workspace_routines(id) on delete cascade,
  -- Copied from the routine by the trigger, for RLS and the screen's one-workspace read.
  workspace_id  uuid not null references public.workspaces(id) on delete cascade,
  trigger       text not null check (trigger in ('schedule', 'catch_up', 'manual')),
  -- The occurrence a scheduled run is for; null for «Run now».
  scheduled_for timestamptz,
  status        text not null check (status in ('running', 'succeeded', 'failed', 'skipped')),
  started_at    timestamptz not null default now(),
  finished_at   timestamptz,
  run_by        uuid references auth.users(id) on delete set null,

  -- What the run produced. A release note and a task card outlive the run's link to them.
  note_id            uuid references public.workspace_release_notes(id) on delete set null,
  task_id            uuid references public.tasks(id) on delete set null,
  commit_count       integer,
  -- A workspace prompt's report, markdown.
  output_md          text,
  slack_channel_name text,
  -- Why it failed or was skipped: an api error code (localized by the ui when it knows it), the
  -- fallback sentence, and the code's interpolation values.
  error_code         text,
  error_message      text,
  error_params       jsonb,

  constraint workspace_routine_runs_once unique (routine_id, scheduled_for)
);

create index workspace_routine_runs_workspace_idx on public.workspace_routine_runs (workspace_id, started_at desc);

-- No delete: the history goes with its routine (cascade) and not before.
grant select, insert, update on table public.workspace_routine_runs to authenticated;

create policy workspace_routine_runs_select_member on public.workspace_routine_runs for select to authenticated
  using (public.is_workspace_member(workspace_id, auth.uid()));

-- Only the routine's author starts its runs: the scheduler runs in the author's api, and «Run
-- now» is the author's button. `workspace_id` has been copied from the routine by then (the
-- BEFORE trigger runs ahead of the policy check).
create policy workspace_routine_runs_insert_author on public.workspace_routine_runs for insert to authenticated
  with check (
    public.is_workspace_member(workspace_id, auth.uid())
    and exists (select 1 from public.workspace_routines r where r.id = routine_id and r.created_by = auth.uid()));

-- The runner finishes its own run.
create policy workspace_routine_runs_update_runner on public.workspace_routine_runs for update to authenticated
  using (run_by = auth.uid())
  with check (run_by = auth.uid());

alter table public.workspace_routine_runs enable row level security;

create or replace function public.workspace_routine_runs_touch() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    new.workspace_id := (select r.workspace_id from public.workspace_routines r where r.id = new.routine_id);
    new.run_by       := auth.uid();
    new.started_at   := now();
  else
    -- What the run WAS is fixed at its claim; only its outcome is written afterwards.
    new.routine_id    := old.routine_id;
    new.workspace_id  := old.workspace_id;
    new.trigger       := old.trigger;
    new.scheduled_for := old.scheduled_for;
    new.started_at    := old.started_at;
    new.run_by        := old.run_by;
  end if;
  return new;
end;
$$;

create trigger workspace_routine_runs_touch
  before insert or update on public.workspace_routine_runs
  for each row execute function public.workspace_routine_runs_touch();
