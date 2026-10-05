-- Slack integration: one Slack channel bound to a workspace, answering questions about
-- the workspace's indexed project documentation in threads. Additive only — one new
-- table, nothing existing is altered.
--
-- Shape of trust: there is no cloud worker. Slack is reached over Socket Mode from each
-- member's LOCAL api (it binds 127.0.0.1, so Slack cannot push to it), and that api reads
-- documentation under the member's own JWT — the same RAG path the UI uses. This row only
-- tells every member's machine WHICH Slack workspace and channel the Kermanych workspace
-- is bound to; choosing that binding is the workspace owner's call, like its name.
--
-- No secrets here. The bot token (xoxb-) and app-level token (xapp-) live in each
-- machine's registry SQLite (the localRepoPath rule); this schema carries only addresses.

-- ── the integration row ───────────────────────────────────────────────────────
create table public.workspace_slack_integrations (
  id             uuid primary key default gen_random_uuid(),
  -- UNIQUE: one channel per workspace is the agreed model. Re-pointing at another
  -- channel is an update of this row, not a second row.
  workspace_id   uuid not null unique references public.workspaces(id) on delete cascade,
  -- Slack ids (T…, C…/G…, U…) are opaque strings — kept as text.
  team_id        text not null,
  team_name      text not null,
  channel_id     text not null,
  channel_name   text not null,
  -- The bot's own user id: how a thread reply's @-mention is recognised as a follow-up
  -- and how the bot's own messages are told apart from questions.
  bot_user_id    text not null,
  connected_by   uuid references auth.users(id) on delete set null,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  -- One channel routes to exactly ONE workspace: a message arriving in it must have a
  -- single documentation set to answer from, never two workspaces racing to reply.
  unique (team_id, channel_id)
);

grant select, insert, update, delete on table public.workspace_slack_integrations to authenticated;

create policy workspace_slack_integrations_select_member on public.workspace_slack_integrations
  for select to authenticated
  using (public.is_workspace_member(workspace_id, auth.uid()));

-- Owner-only management, the workspace-rename rule: which Slack channel speaks for the
-- whole workspace is not a member-level decision. Inline owner subquery — the schema's
-- existing convention (no is_workspace_owner helper exists).
create policy workspace_slack_integrations_insert_owner on public.workspace_slack_integrations
  for insert to authenticated
  with check (exists (
    select 1 from public.workspaces w
    where w.id = workspace_id and w.owner_id = auth.uid()));

create policy workspace_slack_integrations_update_owner on public.workspace_slack_integrations
  for update to authenticated
  using (exists (
    select 1 from public.workspaces w
    where w.id = workspace_id and w.owner_id = auth.uid()))
  with check (exists (
    select 1 from public.workspaces w
    where w.id = workspace_id and w.owner_id = auth.uid()));

create policy workspace_slack_integrations_delete_owner on public.workspace_slack_integrations
  for delete to authenticated
  using (exists (
    select 1 from public.workspaces w
    where w.id = workspace_id and w.owner_id = auth.uid()));

alter table public.workspace_slack_integrations enable row level security;

-- Server-owned audit columns, the workspace_linear_integrations_touch() shape.
create or replace function public.workspace_slack_integrations_touch() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    new.created_at   := now();
    new.connected_by := auth.uid();
  else
    new.workspace_id := old.workspace_id;
    new.created_at   := old.created_at;
    -- A channel change is a re-connection: the row keeps naming who last pointed it
    -- somewhere, so «підключив» on the tile is never stale.
    new.connected_by := auth.uid();
  end if;
  new.updated_at := now();
  return new;
end;
$$;

create trigger workspace_slack_integrations_touch
  before insert or update on public.workspace_slack_integrations
  for each row execute function public.workspace_slack_integrations_touch();
