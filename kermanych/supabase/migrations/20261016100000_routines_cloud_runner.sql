-- Routines that run in the cloud (docs/specs/2026-10-16-routines.md, «Cloud runner»). A routine
-- with `runner = 'cloud'` is fired by the routines-runner Edge Function, every minute, whether
-- or not any member has Kermanych open. Additive: one new table, one trigger function widened,
-- one scheduled job.
--
-- Shape of trust — a deliberate exception, agreed for this feature. Every other cloud path runs
-- under the CALLER's JWT (docs-rag says «do not weaken»). A timer has no caller, so the runner
-- reads and writes with the SERVICE ROLE, which only exists inside Supabase's own Edge Runtime —
-- still never on a machine running Kermanych. It acts with the workspace's own keys, stored
-- below: the code is read from GitHub, the model is the workspace's Anthropic API key (billed per
-- use, not a member's subscription), Slack posts come from the workspace's bot.

-- ── 1. the workspace's cloud keys ─────────────────────────────────────────────

-- One row per workspace that turned the cloud runner on. SECRETS: no grant to `authenticated` or
-- `anon`, RLS on with no policy — only the service role (the Edge Function) reads or writes it.
-- The owner sets the keys through the function's `configure` action, which checks them against
-- Anthropic, GitHub and Slack before storing; members see only what `status` answers (which keys
-- are set, the model, the Slack workspace), never a key.
create table public.workspace_routine_cloud (
  workspace_id      uuid primary key references public.workspaces(id) on delete cascade,
  anthropic_api_key text,
  -- The model every cloud run uses, picked by the owner from the key's own model list.
  anthropic_model   text,
  -- A read-only GitHub token (fine-grained: Contents + Metadata, read) for the workspace's repos.
  github_token      text,
  -- The workspace's Slack bot token (xoxb-) — the Q&A bot's app. Posts appear from the bot.
  slack_bot_token   text,
  slack_team_id     text,
  slack_team_name   text,
  updated_at        timestamptz not null default now(),
  updated_by        uuid references auth.users(id) on delete set null
);

revoke all on table public.workspace_routine_cloud from anon, authenticated;
alter table public.workspace_routine_cloud enable row level security;

-- ── 2. notes written by the cloud runner keep their author ───────────────────

-- The service role has no auth.uid(), so the stamp below would leave a cloud-written note with
-- no author. It now keeps the `created_by` the insert carries when — and only when — there is no
-- caller: every member's own write is still stamped with their uid, whatever it claims, and
-- `anon` holds no grant on the table. Otherwise identical to 20261012090000.
create or replace function public.workspace_release_notes_touch() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    new.created_at := now();
    new.created_by := coalesce(auth.uid(), new.created_by);
    new.updated_by := new.created_by;
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
    new.updated_by   := coalesce(auth.uid(), old.updated_by);
  end if;
  new.updated_at := now();
  return new;
end;
$$;

-- ── 3. the minute tick ────────────────────────────────────────────────────────

-- Calls the Edge Function's `tick` action. Its two inputs live in Supabase Vault, set once by the
-- maintainer (README «Cloud runner»), never in a migration:
--   routines_project_url    — https://<project-ref>.supabase.co
--   routines_runner_secret  — the same random value as the function's ROUTINES_RUNNER_SECRET
-- Without either it does nothing, so a project that never set the runner up pays one cheap query
-- a minute and nothing else.
create or replace function public.routines_cloud_tick() returns void
language plpgsql security definer set search_path = public as $$
declare
  project_url text := (select decrypted_secret from vault.decrypted_secrets where name = 'routines_project_url');
  runner_secret text := (select decrypted_secret from vault.decrypted_secrets where name = 'routines_runner_secret');
begin
  if project_url is null or runner_secret is null then
    return;
  end if;
  perform net.http_post(
    url := rtrim(project_url, '/') || '/functions/v1/routines-runner',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-routines-secret', runner_secret),
    body := jsonb_build_object('action', 'tick'),
    timeout_milliseconds := 10000
  );
end;
$$;

revoke all on function public.routines_cloud_tick() from public, anon, authenticated;

-- Scheduled only where the platform has the pieces (the hosted project and the local Supabase
-- stack do): pg_cron for the timer, pg_net for the call, Vault for the two inputs. Elsewhere the
-- migration still applies and the cloud runner simply never ticks.
do $$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_cron')
     and exists (select 1 from pg_available_extensions where name = 'pg_net')
     and to_regclass('vault.decrypted_secrets') is not null then
    create extension if not exists pg_cron with schema pg_catalog;
    create extension if not exists pg_net with schema extensions;
    -- cron.schedule upserts by job name, so re-applying this is harmless.
    perform cron.schedule('routines-cloud-tick', '* * * * *', 'select public.routines_cloud_tick()');
  end if;
end;
$$;
