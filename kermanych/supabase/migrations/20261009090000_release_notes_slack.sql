-- Release notes → Slack: the channel a workspace's release notes are sent to. Additive
-- only — one new table, nothing existing is altered.
--
-- Shape of trust: a note is posted from each member's LOCAL api with that member's own
-- Slack user token (xoxp-, obtained by OAuth with PKCE on their machine), so it appears in
-- Slack under their name. This row only tells every member's machine WHICH Slack app to
-- authorize against and WHICH channel to post to; choosing that is the workspace owner's
-- call, like the Q&A bot's channel (20261005090000_slack_integration.sql).
--
-- No secrets here. The Client ID is public — it is part of every authorize URL. User
-- tokens live in each machine's registry SQLite.

create table public.workspace_release_notes_slack (
  id             uuid primary key default gen_random_uuid(),
  -- UNIQUE: one release-notes channel per workspace. Re-pointing is an update.
  workspace_id   uuid not null unique references public.workspaces(id) on delete cascade,
  -- The Slack app's Client ID (`1234.5678`): the app every member authorizes to post as
  -- themselves. The same app as the Q&A bot — one Slack app per workspace.
  client_id      text not null,
  -- Slack ids (T…, C…/G…) are opaque strings — kept as text.
  team_id        text not null,
  team_name      text not null,
  channel_id     text not null,
  channel_name   text not null,
  configured_by  uuid references auth.users(id) on delete set null,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

grant select, insert, update, delete on table public.workspace_release_notes_slack to authenticated;

create policy workspace_release_notes_slack_select_member on public.workspace_release_notes_slack
  for select to authenticated
  using (public.is_workspace_member(workspace_id, auth.uid()));

create policy workspace_release_notes_slack_insert_owner on public.workspace_release_notes_slack
  for insert to authenticated
  with check (exists (
    select 1 from public.workspaces w
    where w.id = workspace_id and w.owner_id = auth.uid()));

create policy workspace_release_notes_slack_update_owner on public.workspace_release_notes_slack
  for update to authenticated
  using (exists (
    select 1 from public.workspaces w
    where w.id = workspace_id and w.owner_id = auth.uid()))
  with check (exists (
    select 1 from public.workspaces w
    where w.id = workspace_id and w.owner_id = auth.uid()));

create policy workspace_release_notes_slack_delete_owner on public.workspace_release_notes_slack
  for delete to authenticated
  using (exists (
    select 1 from public.workspaces w
    where w.id = workspace_id and w.owner_id = auth.uid()));

alter table public.workspace_release_notes_slack enable row level security;

-- Server-owned audit columns, the workspace_slack_integrations_touch() shape.
create or replace function public.workspace_release_notes_slack_touch() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    new.created_at    := now();
  else
    new.workspace_id  := old.workspace_id;
    new.created_at    := old.created_at;
  end if;
  new.configured_by := auth.uid();
  new.updated_at    := now();
  return new;
end;
$$;

create trigger workspace_release_notes_slack_touch
  before insert or update on public.workspace_release_notes_slack
  for each row execute function public.workspace_release_notes_slack_touch();
