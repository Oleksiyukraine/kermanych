-- Jira integration: one Jira board mirrored per workspace, two-way.
-- Spec: docs/superpowers/specs/2026-09-02-jira-integration-design.md
--
-- Shape of trust: Jira is the source of truth and these tables are a CACHE of it,
-- written by whichever member's local api last synced or acted. That is why every
-- mirror table is member-writable — the sync engine runs under an ordinary member's
-- JWT — while the integration row itself (which board, which site) is the workspace
-- owner's, like the workspace's name.
--
-- No secrets here. Per-user Jira API tokens live in each machine's registry SQLite
-- (the localRepoPath rule); this schema carries only addresses and mirrored content.

-- ── the integration row ───────────────────────────────────────────────────────
create table public.workspace_jira_integrations (
  id               uuid primary key default gen_random_uuid(),
  -- UNIQUE: one board per workspace is the agreed model. Changing the board is an
  -- update of this row, not a second row.
  workspace_id     uuid not null unique references public.workspaces(id) on delete cascade,
  site_url         text not null check (length(trim(site_url)) > 0),
  jira_project_key text not null check (length(trim(jira_project_key)) > 0),
  board_id         bigint not null,
  board_name       text not null,
  connected_by     uuid references auth.users(id) on delete set null,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

grant select, insert, update, delete on table public.workspace_jira_integrations to authenticated;

create policy workspace_jira_integrations_select_member on public.workspace_jira_integrations
  for select to authenticated
  using (public.is_workspace_member(workspace_id, auth.uid()));

-- Owner-only management, the workspace-rename rule: which external system a whole
-- team's board mirrors is not a member-level decision. Inline owner subquery — the
-- schema's existing convention (no is_workspace_owner helper exists).
create policy workspace_jira_integrations_insert_owner on public.workspace_jira_integrations
  for insert to authenticated
  with check (exists (
    select 1 from public.workspaces w
    where w.id = workspace_id and w.owner_id = auth.uid()));

create policy workspace_jira_integrations_update_owner on public.workspace_jira_integrations
  for update to authenticated
  using (exists (
    select 1 from public.workspaces w
    where w.id = workspace_id and w.owner_id = auth.uid()))
  with check (exists (
    select 1 from public.workspaces w
    where w.id = workspace_id and w.owner_id = auth.uid()));

create policy workspace_jira_integrations_delete_owner on public.workspace_jira_integrations
  for delete to authenticated
  using (exists (
    select 1 from public.workspaces w
    where w.id = workspace_id and w.owner_id = auth.uid()));

alter table public.workspace_jira_integrations enable row level security;

-- Server-owned audit columns, the workspace_release_notes_touch() shape.
create or replace function public.workspace_jira_integrations_touch() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    new.created_at   := now();
    new.connected_by := auth.uid();
  else
    new.workspace_id := old.workspace_id;
    new.created_at   := old.created_at;
    -- A board change is a re-connection: the row keeps naming who last pointed it
    -- somewhere, so «підключив» on the tile is never stale.
    new.connected_by := auth.uid();
  end if;
  new.updated_at := now();
  return new;
end;
$$;

create trigger workspace_jira_integrations_touch
  before insert or update on public.workspace_jira_integrations
  for each row execute function public.workspace_jira_integrations_touch();

-- ── sync lease ────────────────────────────────────────────────────────────────
-- Split from the integration row so ANY member's api can take the polling lease
-- and advance the cursor without owner rights. One row per integration.
-- `last_synced_at` doubles as the lease: a client takes it only when the stamp is
-- older than its staleness window (a guarded UPDATE — race losers update 0 rows).
create table public.jira_sync_state (
  integration_id uuid primary key references public.workspace_jira_integrations(id) on delete cascade,
  -- Denormalised for RLS: one membership probe instead of a join per policy check
  -- (the workspace_risk_events reasoning).
  workspace_id   uuid not null references public.workspaces(id) on delete cascade,
  last_synced_at timestamptz,
  -- High-water Jira `updated` timestamp for the incremental JQL. Null means «never
  -- fully synced» and forces a full sweep.
  sync_cursor    timestamptz
);

grant select, insert, update, delete on table public.jira_sync_state to authenticated;

create policy jira_sync_state_all_member on public.jira_sync_state
  for all to authenticated
  using      (public.is_workspace_member(workspace_id, auth.uid()))
  with check (public.is_workspace_member(workspace_id, auth.uid()));

alter table public.jira_sync_state enable row level security;

-- ── board columns ─────────────────────────────────────────────────────────────
-- The Jira board's own column layout, positions and all. One Jira column maps a SET
-- of statuses — that is Jira's model, so it is the mirror's. Replaced wholesale on
-- every full sync (delete + insert), hence the position-keyed pk.
create table public.jira_columns (
  integration_id uuid not null references public.workspace_jira_integrations(id) on delete cascade,
  workspace_id   uuid not null references public.workspaces(id) on delete cascade,
  position       int  not null,
  name           text not null,
  status_ids     text[] not null default '{}',
  primary key (integration_id, position)
);

grant select, insert, update, delete on table public.jira_columns to authenticated;

create policy jira_columns_all_member on public.jira_columns
  for all to authenticated
  using      (public.is_workspace_member(workspace_id, auth.uid()))
  with check (public.is_workspace_member(workspace_id, auth.uid()));

alter table public.jira_columns enable row level security;

-- ── issues ────────────────────────────────────────────────────────────────────
-- Card + detail body in one row: the board reads all of it anyway, and a split
-- would buy a join, not bytes. `description_html` is Jira's renderedFields HTML —
-- the UI sanitizes before display; the database stores what Jira said.
create table public.jira_issues (
  integration_id      uuid not null references public.workspace_jira_integrations(id) on delete cascade,
  workspace_id        uuid not null references public.workspaces(id) on delete cascade,
  issue_id            text not null,
  key                 text not null,
  summary             text not null,
  description_html    text not null default '',
  type_name           text not null default '',
  type_icon           text not null default '',
  priority_name       text not null default '',
  priority_icon       text not null default '',
  labels              text[] not null default '{}',
  assignee_account_id text,
  assignee_name       text,
  assignee_avatar     text,
  reporter_name       text,
  status_id           text not null,
  status_name         text not null,
  -- Jira's own three-way categorisation: new | indeterminate | done. The launch
  -- dialog's «don't move it» rule reads this, never the free-form status name.
  status_category     text not null default 'new',
  parent_key          text,
  jira_updated_at     timestamptz not null,
  -- The launch binding: which Kermanych repo this ticket runs in (remembered so a
  -- relaunch does not re-ask) and the shadow task the session pipeline runs on.
  -- `set null`, both: the mirrored ticket outlives a deleted repo or task row.
  kermanych_project_id uuid references public.projects(id) on delete set null,
  task_id             uuid references public.tasks(id) on delete set null,
  updated_at          timestamptz not null default now(),
  primary key (integration_id, issue_id)
);

-- The board reads one integration at a time; the subtask list reads by parent.
create index jira_issues_parent_idx on public.jira_issues (integration_id, parent_key);

grant select, insert, update, delete on table public.jira_issues to authenticated;

create policy jira_issues_all_member on public.jira_issues
  for all to authenticated
  using      (public.is_workspace_member(workspace_id, auth.uid()))
  with check (public.is_workspace_member(workspace_id, auth.uid()));

alter table public.jira_issues enable row level security;

-- Live board for every member off the mirror — the tasks-table precedent. Only
-- issues: columns change rarely (refetched on open), children on dialog open.
alter publication supabase_realtime add table public.jira_issues;

-- ── issue children: comments, worklogs, attachment metadata ───────────────────
-- Attachment CONTENT never lands here — download is a live, token-authenticated
-- stream through the local api. These rows exist so tokenless members still see
-- the conversation and the file list.
create table public.jira_comments (
  integration_id  uuid not null references public.workspace_jira_integrations(id) on delete cascade,
  workspace_id    uuid not null references public.workspaces(id) on delete cascade,
  issue_id        text not null,
  comment_id      text not null,
  author_name     text not null default '',
  author_avatar   text not null default '',
  body_html       text not null default '',
  jira_created_at timestamptz not null,
  jira_updated_at timestamptz not null,
  primary key (integration_id, comment_id)
);

create index jira_comments_issue_idx on public.jira_comments (integration_id, issue_id);

create table public.jira_worklogs (
  integration_id  uuid not null references public.workspace_jira_integrations(id) on delete cascade,
  workspace_id    uuid not null references public.workspaces(id) on delete cascade,
  issue_id        text not null,
  worklog_id      text not null,
  author_name     text not null default '',
  author_avatar   text not null default '',
  time_spent      text not null default '',
  seconds         bigint not null default 0,
  started_at      timestamptz not null,
  comment_html    text not null default '',
  primary key (integration_id, worklog_id)
);

create index jira_worklogs_issue_idx on public.jira_worklogs (integration_id, issue_id);

create table public.jira_attachments (
  integration_id  uuid not null references public.workspace_jira_integrations(id) on delete cascade,
  workspace_id    uuid not null references public.workspaces(id) on delete cascade,
  issue_id        text not null,
  attachment_id   text not null,
  filename        text not null,
  mime            text not null default '',
  size            bigint not null default 0,
  author_name     text not null default '',
  jira_created_at timestamptz not null,
  primary key (integration_id, attachment_id)
);

create index jira_attachments_issue_idx on public.jira_attachments (integration_id, issue_id);

grant select, insert, update, delete on table public.jira_comments to authenticated;
grant select, insert, update, delete on table public.jira_worklogs to authenticated;
grant select, insert, update, delete on table public.jira_attachments to authenticated;

create policy jira_comments_all_member on public.jira_comments
  for all to authenticated
  using      (public.is_workspace_member(workspace_id, auth.uid()))
  with check (public.is_workspace_member(workspace_id, auth.uid()));

create policy jira_worklogs_all_member on public.jira_worklogs
  for all to authenticated
  using      (public.is_workspace_member(workspace_id, auth.uid()))
  with check (public.is_workspace_member(workspace_id, auth.uid()));

create policy jira_attachments_all_member on public.jira_attachments
  for all to authenticated
  using      (public.is_workspace_member(workspace_id, auth.uid()))
  with check (public.is_workspace_member(workspace_id, auth.uid()));

alter table public.jira_comments   enable row level security;
alter table public.jira_worklogs   enable row level security;
alter table public.jira_attachments enable row level security;

-- ── shadow-task marker ────────────────────────────────────────────────────────
-- A launched Jira ticket runs on an ordinary tasks row so the WHOLE session
-- pipeline (worktree, outbox, force-stop, tasks_guard) is reused unchanged. The
-- marker is what keeps the two boards honest: the native board filters
-- `jira_key is null`, the Jira view joins the shadow task for its agent chip.
-- Existing policies and tasks_guard() predicate on rows, not column lists, so the
-- column is covered the moment it exists (the task_effort precedent).
alter table public.tasks
  add column if not exists jira_key text;
