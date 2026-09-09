-- Linear integration: one Linear team's board mirrored per workspace, two-way.
-- Structural mirror of the Jira integration (20260902090000) — a workspace may have
-- Jira AND Linear connected at once, so this schema is entirely separate: its own
-- integration row, its own mirror tables, its own sync lease.
--
-- Shape of trust: Linear is the source of truth and these tables are a CACHE of it,
-- written by whichever member's local api last synced or acted. That is why every
-- mirror table is member-writable — the sync engine runs under an ordinary member's
-- JWT — while the integration row itself (which team) is the workspace owner's, like
-- the workspace's name.
--
-- No secrets here. Per-user Linear API keys live in each machine's registry SQLite
-- (the localRepoPath rule); this schema carries only addresses and mirrored content.

-- ── the integration row ───────────────────────────────────────────────────────
create table public.workspace_linear_integrations (
  id             uuid primary key default gen_random_uuid(),
  -- UNIQUE: one team per workspace is the agreed model. Changing the team is an
  -- update of this row, not a second row.
  workspace_id   uuid not null unique references public.workspaces(id) on delete cascade,
  org_url_key    text not null check (length(trim(org_url_key)) > 0),
  team_key       text not null check (length(trim(team_key)) > 0),
  -- Linear ids are UUID strings, not numbers — kept as text.
  team_id        text not null,
  team_name      text not null,
  connected_by   uuid references auth.users(id) on delete set null,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

grant select, insert, update, delete on table public.workspace_linear_integrations to authenticated;

create policy workspace_linear_integrations_select_member on public.workspace_linear_integrations
  for select to authenticated
  using (public.is_workspace_member(workspace_id, auth.uid()));

-- Owner-only management, the workspace-rename rule: which external system a whole
-- team's board mirrors is not a member-level decision. Inline owner subquery — the
-- schema's existing convention (no is_workspace_owner helper exists).
create policy workspace_linear_integrations_insert_owner on public.workspace_linear_integrations
  for insert to authenticated
  with check (exists (
    select 1 from public.workspaces w
    where w.id = workspace_id and w.owner_id = auth.uid()));

create policy workspace_linear_integrations_update_owner on public.workspace_linear_integrations
  for update to authenticated
  using (exists (
    select 1 from public.workspaces w
    where w.id = workspace_id and w.owner_id = auth.uid()))
  with check (exists (
    select 1 from public.workspaces w
    where w.id = workspace_id and w.owner_id = auth.uid()));

create policy workspace_linear_integrations_delete_owner on public.workspace_linear_integrations
  for delete to authenticated
  using (exists (
    select 1 from public.workspaces w
    where w.id = workspace_id and w.owner_id = auth.uid()));

alter table public.workspace_linear_integrations enable row level security;

-- Server-owned audit columns, the workspace_release_notes_touch() shape.
create or replace function public.workspace_linear_integrations_touch() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    new.created_at   := now();
    new.connected_by := auth.uid();
  else
    new.workspace_id := old.workspace_id;
    new.created_at   := old.created_at;
    -- A team change is a re-connection: the row keeps naming who last pointed it
    -- somewhere, so «підключив» on the tile is never stale.
    new.connected_by := auth.uid();
  end if;
  new.updated_at := now();
  return new;
end;
$$;

create trigger workspace_linear_integrations_touch
  before insert or update on public.workspace_linear_integrations
  for each row execute function public.workspace_linear_integrations_touch();

-- ── sync lease ────────────────────────────────────────────────────────────────
-- Split from the integration row so ANY member's api can take the polling lease
-- and advance the cursor without owner rights. One row per integration.
-- `last_synced_at` doubles as the lease: a client takes it only when the stamp is
-- older than its staleness window (a guarded UPDATE — race losers update 0 rows).
create table public.linear_sync_state (
  integration_id uuid primary key references public.workspace_linear_integrations(id) on delete cascade,
  -- Denormalised for RLS: one membership probe instead of a join per policy check
  -- (the workspace_risk_events reasoning).
  workspace_id   uuid not null references public.workspaces(id) on delete cascade,
  last_synced_at timestamptz,
  -- High-water Linear `updatedAt` timestamp for the incremental query. Null means
  -- «never fully synced» and forces a full sweep.
  sync_cursor    timestamptz
);

grant select, insert, update, delete on table public.linear_sync_state to authenticated;

create policy linear_sync_state_all_member on public.linear_sync_state
  for all to authenticated
  using      (public.is_workspace_member(workspace_id, auth.uid()))
  with check (public.is_workspace_member(workspace_id, auth.uid()));

alter table public.linear_sync_state enable row level security;

-- ── board columns ─────────────────────────────────────────────────────────────
-- The Linear team's own workflow states, positions and all. One Linear column maps a
-- SINGLE state — Linear's model, so it is the mirror's — but the column keeps a text[]
-- for structural parity with the Jira mirror. Replaced wholesale on every full sync
-- (delete + insert), hence the position-keyed pk.
create table public.linear_columns (
  integration_id uuid not null references public.workspace_linear_integrations(id) on delete cascade,
  workspace_id   uuid not null references public.workspaces(id) on delete cascade,
  position       int  not null,
  name           text not null,
  state_ids      text[] not null default '{}',
  primary key (integration_id, position)
);

grant select, insert, update, delete on table public.linear_columns to authenticated;

create policy linear_columns_all_member on public.linear_columns
  for all to authenticated
  using      (public.is_workspace_member(workspace_id, auth.uid()))
  with check (public.is_workspace_member(workspace_id, auth.uid()));

alter table public.linear_columns enable row level security;

-- ── issues ────────────────────────────────────────────────────────────────────
-- Card + detail body in one row: the board reads all of it anyway, and a split
-- would buy a join, not bytes. `description_md` is Linear's markdown description —
-- the UI renders and sanitizes before display; the database stores what Linear said.
create table public.linear_issues (
  integration_id       uuid not null references public.workspace_linear_integrations(id) on delete cascade,
  workspace_id         uuid not null references public.workspaces(id) on delete cascade,
  issue_id             text not null,
  key                  text not null,
  title                text not null,
  description_md       text not null default '',
  -- Linear priority: 0 None, 1 Urgent, 2 High, 3 Medium, 4 Low.
  priority             int not null default 0,
  priority_name        text not null default '',
  estimate             real not null default 0,
  labels               text[] not null default '{}',
  assignee_id          text,
  assignee_name        text,
  assignee_avatar      text,
  state_id             text not null,
  state_name           text not null,
  -- Linear's workflow-state type mapped to Jira's three-way categorisation:
  -- new | indeterminate | done. The launch dialog's «don't move it» rule reads this,
  -- never the free-form state name.
  state_category       text not null default 'new',
  parent_key           text,
  url                  text not null default '',
  -- Linear's planning dates in Linear's own spelling (YYYY-MM-DD); blank = not set.
  -- `start_date` mirrors the date part of `startedAt` and is read-only (Linear has
  -- no user-editable start date); `due_date` is the TimelessDate `dueDate`.
  start_date           text not null default '',
  due_date             text not null default '',
  linear_updated_at    timestamptz not null,
  -- The launch binding: which Kermanych repo this ticket runs in (remembered so a
  -- relaunch does not re-ask) and the shadow task the session pipeline runs on.
  -- `set null`, both: the mirrored ticket outlives a deleted repo or task row.
  kermanych_project_id uuid references public.projects(id) on delete set null,
  task_id              uuid references public.tasks(id) on delete set null,
  updated_at           timestamptz default now(),
  primary key (integration_id, issue_id)
);

-- The board reads one integration at a time; the subtask list reads by parent.
create index linear_issues_parent_idx on public.linear_issues (integration_id, parent_key);

grant select, insert, update, delete on table public.linear_issues to authenticated;

create policy linear_issues_all_member on public.linear_issues
  for all to authenticated
  using      (public.is_workspace_member(workspace_id, auth.uid()))
  with check (public.is_workspace_member(workspace_id, auth.uid()));

alter table public.linear_issues enable row level security;

-- Live board for every member off the mirror — the tasks-table precedent. Only
-- issues: columns change rarely (refetched on open), children on dialog open.
alter publication supabase_realtime add table public.linear_issues;

-- ── issue children: comments, attachment metadata ─────────────────────────────
-- Attachments are read-only links (Linear has no upload); these rows exist so
-- tokenless members still see the conversation and the file list. Linear has no
-- worklogs, so there is no worklog table.
create table public.linear_comments (
  integration_id  uuid not null references public.workspace_linear_integrations(id) on delete cascade,
  workspace_id    uuid not null references public.workspaces(id) on delete cascade,
  issue_id        text not null,
  comment_id      text not null,
  author_name     text not null default '',
  author_avatar   text not null default '',
  body_md         text not null default '',
  created_at      timestamptz not null,
  updated_at      timestamptz not null,
  primary key (integration_id, comment_id)
);

create index linear_comments_issue_idx on public.linear_comments (integration_id, issue_id);

create table public.linear_attachments (
  integration_id  uuid not null references public.workspace_linear_integrations(id) on delete cascade,
  workspace_id    uuid not null references public.workspaces(id) on delete cascade,
  issue_id        text not null,
  attachment_id   text not null,
  title           text not null default '',
  subtitle        text not null default '',
  url             text not null default '',
  created_at      timestamptz not null,
  primary key (integration_id, attachment_id)
);

create index linear_attachments_issue_idx on public.linear_attachments (integration_id, issue_id);

grant select, insert, update, delete on table public.linear_comments to authenticated;
grant select, insert, update, delete on table public.linear_attachments to authenticated;

create policy linear_comments_all_member on public.linear_comments
  for all to authenticated
  using      (public.is_workspace_member(workspace_id, auth.uid()))
  with check (public.is_workspace_member(workspace_id, auth.uid()));

create policy linear_attachments_all_member on public.linear_attachments
  for all to authenticated
  using      (public.is_workspace_member(workspace_id, auth.uid()))
  with check (public.is_workspace_member(workspace_id, auth.uid()));

alter table public.linear_comments    enable row level security;
alter table public.linear_attachments enable row level security;

-- ── shadow-task marker ────────────────────────────────────────────────────────
-- A launched Linear ticket runs on an ordinary tasks row so the WHOLE session
-- pipeline (worktree, outbox, force-stop, tasks_guard) is reused unchanged. The
-- marker is what keeps the boards honest: the native board filters `linear_key is
-- null`, the Linear view joins the shadow task for its agent chip. Existing policies
-- and tasks_guard() predicate on rows, not column lists, so the column is covered the
-- moment it exists (the jira_key precedent).
alter table public.tasks
  add column if not exists linear_key text;
