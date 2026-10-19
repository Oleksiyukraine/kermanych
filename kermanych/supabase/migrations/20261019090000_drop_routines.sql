-- Routines are removed from Kermanych (docs/specs/2026-10-19-remove-routines.md). This undoes
-- 20261017090000_workspace_routines.sql and 20261017100000_routines_cloud_runner.sql, which
-- stay in the history because the hosted project has already applied them.
--
-- DESTRUCTIVE: every routine, its run history and every workspace's cloud-runner keys are
-- deleted. No shipped client reads them once the build without routines is out; a build that
-- still has the Routines screen shows it failing to load.

-- ── 1. the minute tick ────────────────────────────────────────────────────────

-- Nested IFs, not AND: a plpgsql statement is parsed when it first runs, so `cron.job` must not
-- be named where pg_cron is absent (the 20261017100000 migration only scheduled the job where
-- it was). pg_cron and pg_net themselves stay: dropping an extension is not this change's call.
do $$
begin
  if to_regclass('cron.job') is not null then
    if exists (select 1 from cron.job where jobname = 'routines-cloud-tick') then
      perform cron.unschedule('routines-cloud-tick');
    end if;
  end if;
end;
$$;

drop function if exists public.routines_cloud_tick();

-- The tick's two inputs, set by hand in the SQL editor per the README of the time.
do $$
begin
  if to_regclass('vault.secrets') is not null then
    delete from vault.secrets where name in ('routines_project_url', 'routines_runner_secret');
  end if;
end;
$$;

-- ── 2. the tables ─────────────────────────────────────────────────────────────

-- Each drop takes its policies, indexes and triggers with it; runs first, they reference routines.
drop table if exists public.workspace_routine_runs;
drop table if exists public.workspace_routines;
drop table if exists public.workspace_routine_cloud;

drop function if exists public.workspace_routine_runs_touch();
drop function if exists public.workspace_routines_touch();

-- ── 3. release notes are stamped by their caller again ────────────────────────

-- Back to 20261012090000: only the cloud runner (service role, no auth.uid()) needed an
-- insert's own `created_by` kept, and the runner is gone.
create or replace function public.workspace_release_notes_touch() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    new.created_at := now();
    new.created_by := auth.uid();
  else
    new.workspace_id := old.workspace_id;
    new.project_id   := old.project_id;
    new.project_name := old.project_name;
    new.branch       := old.branch;
    new.sources      := old.sources;
    new.range_from   := old.range_from;
    new.range_to     := old.range_to;
    new.created_at   := old.created_at;
    new.created_by   := old.created_by;
  end if;
  new.updated_at := now();
  new.updated_by := auth.uid();
  return new;
end;
$$;
