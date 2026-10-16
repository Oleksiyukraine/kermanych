-- Slack cloud answers: the documentation bot answering with NOBODY online. Additive only —
-- two new tables and seven functions; nothing existing is altered.
--
-- The desktop bot (20261005090000_slack_integration.sql) answers over Socket Mode from a
-- member's machine, reading documentation under that member's JWT. A workspace owner may
-- instead switch the Slack app to HTTP events aimed at the `slack-events` Edge Function,
-- which answers from the cloud with an AI key the owner provides. That needs, by
-- definition, what the desktop design keeps out of the cloud: Slack and AI secrets, and a
-- way to read documentation without a user JWT. This migration makes both opt-in per
-- workspace and as narrow as they can be:
--
--   • Secrets live in workspace_slack_cloud, which has RLS on, NO policies and NO grants to
--     anon/authenticated. Owners write it through set_slack_cloud; members see a status
--     without secrets through get_slack_cloud_status. Nothing returns a secret to a client.
--   • The Edge Function runs with the service role but is granted NO table privileges. It
--     reaches data only through the slack_cloud_* functions below (execute: service_role
--     only), and the documentation functions return nothing unless the workspace's cloud
--     mode is enabled, and only that workspace's projects. The workspace id the function is
--     called with comes from the Request URL and is trusted only after the request's Slack
--     signature verified against THAT workspace's signing secret.
--   • project_doc_chunks stays untouched by the service role directly; the search goes
--     through the existing match_project_doc_chunks, called by a security definer function
--     that has already fixed the project to the opted-in workspace.

-- ── the cloud-mode row ────────────────────────────────────────────────────────
-- References the integration row, not the workspace: cloud answers are a mode OF a
-- connected channel, and «Disconnect» (deleting the integration) must take the secrets
-- with it — the cascade does that without a second call that could be forgotten.
create table public.workspace_slack_cloud (
  workspace_id    uuid primary key references public.workspace_slack_integrations(workspace_id) on delete cascade,
  -- The switch. Off keeps the secrets so switching back needs no re-entry; the functions
  -- the Edge Function uses answer nothing while it is off.
  enabled         boolean not null default false,
  -- The bot token (xoxb-) the cloud posts with, copied from the owner's machine registry
  -- by the local api, and the Slack app's signing secret that proves a request is Slack's.
  bot_token       text not null check (bot_token like 'xoxb-%'),
  signing_secret  text not null check (length(signing_secret) > 0),
  ai_provider     text not null check (ai_provider in ('anthropic', 'openai')),
  ai_model        text not null check (length(trim(ai_model)) > 0),
  -- «openai» only: any OpenAI-compatible API. Null = OpenAI itself.
  ai_base_url     text check (ai_base_url is null or ai_base_url ~ '^https://'),
  ai_api_key      text not null check (length(ai_api_key) > 0),
  -- Stamped by every request whose signature verified: the settings card's proof that the
  -- Slack app really points at the cloud.
  events_seen_at  timestamptz,
  configured_by   uuid references auth.users(id) on delete set null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

alter table public.workspace_slack_cloud enable row level security;
revoke all on table public.workspace_slack_cloud from anon, authenticated;

-- Slack redelivers an event it thinks was missed, and occasionally one that was not. One
-- row per answered event makes a redelivery a no-op — the cloud counterpart of the desktop
-- socket's seen-event set. Pruned after a day by slack_cloud_claim_event; Slack's retries
-- end within minutes.
create table public.slack_cloud_events (
  workspace_id uuid not null references public.workspace_slack_cloud(workspace_id) on delete cascade,
  event_id     text not null,
  received_at  timestamptz not null default now(),
  primary key (workspace_id, event_id)
);

alter table public.slack_cloud_events enable row level security;
revoke all on table public.slack_cloud_events from anon, authenticated;

-- ── owner and member surface (authenticated) ──────────────────────────────────

-- Owner-only, the workspace_slack_integrations write rule. Provider, model and base URL
-- are always taken as given; a NULL secret keeps the stored one, so flipping the switch or
-- re-saving the form does not need the secrets again. The first save needs all three.
create or replace function public.set_slack_cloud(
  p_workspace_id   uuid,
  p_enabled        boolean,
  p_bot_token      text,
  p_signing_secret text,
  p_ai_provider    text,
  p_ai_model       text,
  p_ai_base_url    text,
  p_ai_api_key     text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not exists (
       select 1 from public.workspaces w
       where w.id = p_workspace_id and w.owner_id = auth.uid()) then
    raise exception 'only the workspace owner can set up cloud answers';
  end if;
  if not exists (select 1 from public.workspace_slack_integrations i where i.workspace_id = p_workspace_id) then
    raise exception 'connect a Slack channel before setting up cloud answers';
  end if;

  update public.workspace_slack_cloud c set
    enabled        = p_enabled,
    bot_token      = coalesce(p_bot_token, c.bot_token),
    signing_secret = coalesce(p_signing_secret, c.signing_secret),
    ai_provider    = p_ai_provider,
    ai_model       = trim(p_ai_model),
    ai_base_url    = nullif(trim(coalesce(p_ai_base_url, '')), ''),
    ai_api_key     = coalesce(p_ai_api_key, c.ai_api_key),
    configured_by  = auth.uid(),
    updated_at     = now()
  where c.workspace_id = p_workspace_id;

  if not found then
    if p_bot_token is null or p_signing_secret is null or p_ai_api_key is null then
      raise exception 'the bot token, the signing secret and the AI key are all required the first time';
    end if;
    insert into public.workspace_slack_cloud
      (workspace_id, enabled, bot_token, signing_secret, ai_provider, ai_model, ai_base_url, ai_api_key, configured_by)
    values
      (p_workspace_id, p_enabled, p_bot_token, p_signing_secret, p_ai_provider, trim(p_ai_model),
       nullif(trim(coalesce(p_ai_base_url, '')), ''), p_ai_api_key, auth.uid());
  end if;
end;
$$;

revoke all on function public.set_slack_cloud(uuid, boolean, text, text, text, text, text, text) from public, anon;
grant execute on function public.set_slack_cloud(uuid, boolean, text, text, text, text, text, text) to authenticated;

-- «Remove cloud keys»: the secrets leave the cloud, the channel binding stays.
create or replace function public.delete_slack_cloud(p_workspace_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not exists (
       select 1 from public.workspaces w
       where w.id = p_workspace_id and w.owner_id = auth.uid()) then
    raise exception 'only the workspace owner can remove cloud answers';
  end if;
  delete from public.workspace_slack_cloud where workspace_id = p_workspace_id;
end;
$$;

revoke all on function public.delete_slack_cloud(uuid) from public, anon;
grant execute on function public.delete_slack_cloud(uuid) to authenticated;

-- What any member may know: the mode, the provider and model, and the AI key's last four
-- characters so an owner can tell which key is in use. No secret leaves through here. No
-- row = cloud answers were never set up (or the caller is not a member).
create or replace function public.get_slack_cloud_status(p_workspace_id uuid)
returns table (
  enabled        boolean,
  ai_provider    text,
  ai_model       text,
  ai_base_url    text,
  ai_key_hint    text,
  events_seen_at timestamptz,
  updated_at     timestamptz
)
language sql
security definer
stable
set search_path = public
as $$
  select c.enabled, c.ai_provider, c.ai_model, c.ai_base_url, right(c.ai_api_key, 4), c.events_seen_at, c.updated_at
  from public.workspace_slack_cloud c
  where c.workspace_id = p_workspace_id
    and public.is_workspace_member(p_workspace_id, auth.uid());
$$;

revoke all on function public.get_slack_cloud_status(uuid) from public, anon;
grant execute on function public.get_slack_cloud_status(uuid) to authenticated;

-- ── the Edge Function's surface (service_role only) ───────────────────────────

-- Everything one request needs: the secrets to verify and answer with, and the channel
-- binding to route by. Returned whether or not the mode is enabled — the function must
-- still verify a request to know it may ignore it.
create or replace function public.slack_cloud_config(p_workspace_id uuid)
returns table (
  enabled        boolean,
  team_id        text,
  channel_id     text,
  bot_user_id    text,
  workspace_name text,
  bot_token      text,
  signing_secret text,
  ai_provider    text,
  ai_model       text,
  ai_base_url    text,
  ai_api_key     text
)
language sql
security definer
stable
set search_path = public
as $$
  select c.enabled, i.team_id, i.channel_id, i.bot_user_id, w.name,
         c.bot_token, c.signing_secret, c.ai_provider, c.ai_model, c.ai_base_url, c.ai_api_key
  from public.workspace_slack_cloud c
  join public.workspace_slack_integrations i on i.workspace_id = c.workspace_id
  join public.workspaces w on w.id = c.workspace_id
  where c.workspace_id = p_workspace_id;
$$;

-- Called once per verified request. Stamps events_seen_at; with an event id, records it and
-- answers whether this delivery is the first (true) or a redelivery (false). A NULL event
-- id (url_verification) only stamps.
create or replace function public.slack_cloud_claim_event(p_workspace_id uuid, p_event_id text)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  claimed boolean := true;
begin
  update public.workspace_slack_cloud set events_seen_at = now() where workspace_id = p_workspace_id;
  if p_event_id is not null then
    delete from public.slack_cloud_events
    where workspace_id = p_workspace_id and received_at < now() - interval '1 day';
    insert into public.slack_cloud_events (workspace_id, event_id)
    values (p_workspace_id, p_event_id)
    on conflict do nothing;
    claimed := found;
  end if;
  return claimed;
end;
$$;

-- The projects the desktop bot would search: every project of the workspace that has a
-- documentation index, oldest first (listProjects' order). Empty while the mode is off.
create or replace function public.slack_cloud_indexed_projects(p_workspace_id uuid)
returns table (project_id uuid, project_name text)
language sql
security definer
stable
set search_path = public
as $$
  select p.id, p.name
  from public.projects p
  where p.workspace_id = p_workspace_id
    and exists (select 1 from public.workspace_slack_cloud c where c.workspace_id = p_workspace_id and c.enabled)
    and exists (select 1 from public.project_doc_index_state s where s.project_id = p.id)
  order by p.created_at;
$$;

-- One project's hybrid search — match_project_doc_chunks itself — once the project is
-- proven to belong to the workspace and the workspace's cloud mode is on. This, not a
-- direct table grant, is the only way the service role reads documentation.
create or replace function public.slack_cloud_match_docs(
  p_workspace_id    uuid,
  p_project_id      uuid,
  p_query_embedding halfvec(1024),
  p_query_text      text,
  p_match_count     int,
  p_embedding_model text
)
returns table (
  folder       text,
  path         text,
  chunk_ix     int,
  heading_path text,
  start_line   int,
  end_line     int,
  content      text,
  score        double precision
)
language plpgsql
security definer
volatile
set search_path = public
as $$
begin
  if not exists (
       select 1
       from public.projects p
       join public.workspace_slack_cloud c on c.workspace_id = p.workspace_id
       where p.id = p_project_id and p.workspace_id = p_workspace_id and c.enabled) then
    return;
  end if;
  return query
    select * from public.match_project_doc_chunks(p_project_id, p_query_embedding, p_query_text, p_match_count, p_embedding_model);
end;
$$;

revoke all on function public.slack_cloud_config(uuid) from public, anon, authenticated;
revoke all on function public.slack_cloud_claim_event(uuid, text) from public, anon, authenticated;
revoke all on function public.slack_cloud_indexed_projects(uuid) from public, anon, authenticated;
revoke all on function public.slack_cloud_match_docs(uuid, uuid, halfvec, text, int, text) from public, anon, authenticated;
grant execute on function public.slack_cloud_config(uuid) to service_role;
grant execute on function public.slack_cloud_claim_event(uuid, text) to service_role;
grant execute on function public.slack_cloud_indexed_projects(uuid) to service_role;
grant execute on function public.slack_cloud_match_docs(uuid, uuid, halfvec, text, int, text) to service_role;
