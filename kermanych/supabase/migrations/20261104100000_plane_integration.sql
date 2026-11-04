-- Plane integration: up to ten Plane projects mirrored per workspace, two-way.
-- Spec: docs/specs/2026-11-04-plane-integration.md
--
-- Structural mirror of the Jira integration (20260902090000, in its multi-board form of
-- 20260923100000) — a workspace may have Jira, Linear AND Plane connected at once, so this
-- schema is entirely separate: its own integration rows, its own mirror tables, its own
-- sync lease.
--
-- Shape of trust: Plane is the source of truth and these tables are a CACHE of it,
-- written by whichever member's local api last synced or acted. That is why every
-- mirror table is member-writable — the sync engine runs under an ordinary member's
-- JWT — while the integration rows themselves (which projects, which site) are the
-- workspace owner's, like the workspace's name.
--
-- No secrets here. Per-user Plane API keys live in each machine's registry SQLite
-- (the localRepoPath rule); this schema carries only addresses and mirrored content.

-- ── the integration rows ──────────────────────────────────────────────────────
create table public.workspace_plane_integrations (
  id                 uuid primary key default gen_random_uuid(),
  workspace_id       uuid not null references public.workspaces(id) on delete cascade,
  -- The Plane WEB origin («https://app.plane.so» for Cloud, the instance origin when
  -- self-hosted). The api derives the REST base from it.
  site_url           text not null check (length(trim(site_url)) > 0),
  workspace_slug     text not null check (length(trim(workspace_slug)) > 0),
  -- Plane ids are UUID strings, not numbers — kept as text.
  project_id         text not null check (length(trim(project_id)) > 0),
  -- The project's key prefix («WEB»): a work item's key is IDENT-sequence.
  project_identifier text not null check (length(trim(project_identifier)) > 0),
  project_name       text not null,
  connected_by       uuid references auth.users(id) on delete set null,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  -- One row per (workspace, project): re-connecting a project (a name/identifier/site
  -- refresh) is an upsert on this key, so it updates the existing row rather than
  -- creating a twin. A different project is a new row, up to the cap below.
  constraint workspace_plane_integrations_workspace_project_key unique (workspace_id, project_id)
);

grant select, insert, update, delete on table public.workspace_plane_integrations to authenticated;

create policy workspace_plane_integrations_select_member on public.workspace_plane_integrations
  for select to authenticated
  using (public.is_workspace_member(workspace_id, auth.uid()));

-- Owner-only management, the workspace-rename rule: which external system a whole
-- team's board mirrors is not a member-level decision. Inline owner subquery — the
-- schema's existing convention (no is_workspace_owner helper exists).
create policy workspace_plane_integrations_insert_owner on public.workspace_plane_integrations
  for insert to authenticated
  with check (exists (
    select 1 from public.workspaces w
    where w.id = workspace_id and w.owner_id = auth.uid()));

create policy workspace_plane_integrations_update_owner on public.workspace_plane_integrations
  for update to authenticated
  using (exists (
    select 1 from public.workspaces w
    where w.id = workspace_id and w.owner_id = auth.uid()))
  with check (exists (
    select 1 from public.workspaces w
    where w.id = workspace_id and w.owner_id = auth.uid()));

create policy workspace_plane_integrations_delete_owner on public.workspace_plane_integrations
  for delete to authenticated
  using (exists (
    select 1 from public.workspaces w
    where w.id = workspace_id and w.owner_id = auth.uid()));

alter table public.workspace_plane_integrations enable row level security;

-- Server-owned audit columns, the workspace_release_notes_touch() shape.
create or replace function public.workspace_plane_integrations_touch() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    new.created_at   := now();
    new.connected_by := auth.uid();
  else
    new.workspace_id := old.workspace_id;
    new.created_at   := old.created_at;
    -- A refresh is a re-connection: the row keeps naming who last pointed it
    -- somewhere, so «підключив» on the tile is never stale.
    new.connected_by := auth.uid();
  end if;
  new.updated_at := now();
  return new;
end;
$$;

create trigger workspace_plane_integrations_touch
  before insert or update on public.workspace_plane_integrations
  for each row execute function public.workspace_plane_integrations_touch();

-- ── the cap: at most 10 projects per workspace ─────────────────────────────────
-- The Jira multi-board ceiling (20260923100000), for the same reasons: the mirror, the
-- sync ticker and the board switcher all stay cheap at ten — and here every project also
-- spends the same 60-requests-a-minute Plane key. Enforced in a trigger because a CHECK
-- cannot count sibling rows. `upsertPlaneIntegration` re-connects an existing project as
-- INSERT … ON CONFLICT DO UPDATE, and the BEFORE INSERT trigger fires for that too — so
-- the count EXCLUDES the project being written (`project_id <> new.project_id`):
-- re-connecting one of ten is unaffected, only a genuinely new eleventh is refused.
create or replace function public.workspace_plane_integrations_limit() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if (select count(*) from public.workspace_plane_integrations
        where workspace_id = new.workspace_id and project_id <> new.project_id) >= 10 then
    raise exception 'a workspace may connect at most 10 Plane projects'
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

create trigger workspace_plane_integrations_limit
  before insert on public.workspace_plane_integrations
  for each row execute function public.workspace_plane_integrations_limit();

-- ── sync lease ────────────────────────────────────────────────────────────────
-- Split from the integration row so ANY member's api can take the polling lease
-- and advance the cursor without owner rights. One row per integration.
-- `last_synced_at` doubles as the lease: a client takes it only when the stamp is
-- older than its staleness window (a guarded UPDATE — race losers update 0 rows).
create table public.plane_sync_state (
  integration_id uuid primary key references public.workspace_plane_integrations(id) on delete cascade,
  -- Denormalised for RLS: one membership probe instead of a join per policy check
  -- (the workspace_risk_events reasoning).
  workspace_id   uuid not null references public.workspaces(id) on delete cascade,
  last_synced_at timestamptz,
  -- High-water Plane `updated_at` timestamp for the incremental read. Null means
  -- «never fully synced» and forces a full sweep.
  sync_cursor    timestamptz
);

grant select, insert, update, delete on table public.plane_sync_state to authenticated;

create policy plane_sync_state_all_member on public.plane_sync_state
  for all to authenticated
  using      (public.is_workspace_member(workspace_id, auth.uid()))
  with check (public.is_workspace_member(workspace_id, auth.uid()));

alter table public.plane_sync_state enable row level security;

-- ── board columns ─────────────────────────────────────────────────────────────
-- The project's own states, one column each, ordered by state group (backlog →
-- unstarted → started → completed → cancelled) and then by Plane's sequence. The column
-- keeps a text[] for structural parity with the Jira mirror (which maps a set). Replaced
-- wholesale on every full sync (delete + insert), hence the position-keyed pk.
create table public.plane_columns (
  integration_id uuid not null references public.workspace_plane_integrations(id) on delete cascade,
  workspace_id   uuid not null references public.workspaces(id) on delete cascade,
  position       int  not null,
  name           text not null,
  state_ids      text[] not null default '{}',
  state_group    text not null default '',
  color          text not null default '',
  primary key (integration_id, position)
);

grant select, insert, update, delete on table public.plane_columns to authenticated;

create policy plane_columns_all_member on public.plane_columns
  for all to authenticated
  using      (public.is_workspace_member(workspace_id, auth.uid()))
  with check (public.is_workspace_member(workspace_id, auth.uid()));

alter table public.plane_columns enable row level security;

-- ── issues ────────────────────────────────────────────────────────────────────
-- Card + detail body in one row: the board reads all of it anyway, and a split
-- would buy a join, not bytes. `description_html` is Plane's editor HTML — the UI
-- sanitizes before display; the database stores what Plane said.
create table public.plane_issues (
  integration_id            uuid not null references public.workspace_plane_integrations(id) on delete cascade,
  workspace_id              uuid not null references public.workspaces(id) on delete cascade,
  issue_id                  text not null,
  key                       text not null,
  summary                   text not null,
  description_html          text not null default '',
  -- The work-item type's name (Plane Pro); blank when the project has none.
  type_name                 text not null default '',
  -- Plane's fixed enum: urgent | high | medium | low | none.
  priority                  text not null default 'none',
  labels                    text[] not null default '{}',
  -- The estimate point the item carries and its display value («3», «M», «90»).
  estimate_point_id         text,
  estimate                  text not null default '',
  -- Filled only for a `time`-type estimate (its value read as minutes); 0 otherwise, so
  -- Team Capacity reports Plane items as unestimated rather than inventing hours.
  original_estimate_seconds integer not null default 0,
  -- The item's worklog total from /total-worklogs/, in Jira's display spelling
  -- («1h 30m») and in seconds. Blank/0 = no time tracking or nothing logged.
  time_spent                text not null default '',
  time_spent_seconds        integer not null default 0,
  -- Plane's planning dates (`start_date`, `target_date`) in its own spelling
  -- (YYYY-MM-DD); blank = not set. text, not date: the jira_issues reasoning.
  start_date                text not null default '',
  due_date                  text not null default '',
  -- The FIRST assignee: Kermanych shows one person per ticket (spec Decision 6).
  assignee_account_id       text,
  assignee_name             text,
  assignee_avatar           text,
  reporter_name             text,
  status_id                 text not null,
  status_name               text not null,
  -- Plane's state group mapped onto Jira's three-way categorisation:
  -- new | indeterminate | done. The launch dialog's «don't move it» rule reads this,
  -- never the free-form state name.
  status_category           text not null default 'new',
  parent_key                text,
  plane_updated_at          timestamptz not null,
  -- When this item's comments/attachments/worklogs were last mirrored. Plane allows 60
  -- requests a minute per key, so the sync drains a few stale items per tick instead
  -- of refetching children for every changed item: null or older than
  -- plane_updated_at = due.
  children_synced_at        timestamptz,
  -- The launch binding: which Kermanych repo this ticket runs in (remembered so a
  -- relaunch does not re-ask) and the shadow task the session pipeline runs on.
  -- `set null`, both: the mirrored ticket outlives a deleted repo or task row.
  kermanych_project_id      uuid references public.projects(id) on delete set null,
  task_id                   uuid references public.tasks(id) on delete set null,
  updated_at                timestamptz not null default now(),
  primary key (integration_id, issue_id)
);

-- The board reads one integration at a time; the subtask list reads by parent.
create index plane_issues_parent_idx on public.plane_issues (integration_id, parent_key);

grant select, insert, update, delete on table public.plane_issues to authenticated;

create policy plane_issues_all_member on public.plane_issues
  for all to authenticated
  using      (public.is_workspace_member(workspace_id, auth.uid()))
  with check (public.is_workspace_member(workspace_id, auth.uid()));

alter table public.plane_issues enable row level security;

-- Live board for every member off the mirror — the tasks-table precedent. Only
-- issues: columns change rarely (refetched on open), children on dialog open.
alter publication supabase_realtime add table public.plane_issues;

-- ── issue children: comments, worklogs, attachment metadata ───────────────────
-- Attachment CONTENT never lands here — download is a live, token-authenticated
-- stream through the local api. These rows exist so tokenless members still see
-- the conversation and the file list.
create table public.plane_comments (
  integration_id   uuid not null references public.workspace_plane_integrations(id) on delete cascade,
  workspace_id     uuid not null references public.workspaces(id) on delete cascade,
  issue_id         text not null,
  comment_id       text not null,
  author_name      text not null default '',
  author_avatar    text not null default '',
  body_html        text not null default '',
  plane_created_at timestamptz not null,
  plane_updated_at timestamptz not null,
  primary key (integration_id, comment_id)
);

create index plane_comments_issue_idx on public.plane_comments (integration_id, issue_id);

-- Plane worklogs (time tracking, a Pro feature). Plane keeps the duration in minutes and
-- has no work-date field: `started_at` is the entry's created_at, `seconds` is
-- duration × 60, `time_spent` the same in Jira's display spelling. `author_account_id`
-- is the Plane user id the «own versus anyone's» edit rule is decided from.
create table public.plane_worklogs (
  integration_id    uuid not null references public.workspace_plane_integrations(id) on delete cascade,
  workspace_id      uuid not null references public.workspaces(id) on delete cascade,
  issue_id          text not null,
  worklog_id        text not null,
  author_account_id text not null default '',
  author_name       text not null default '',
  author_avatar     text not null default '',
  time_spent        text not null default '',
  seconds           bigint not null default 0,
  started_at        timestamptz not null,
  description       text not null default '',
  primary key (integration_id, worklog_id)
);

create index plane_worklogs_issue_idx on public.plane_worklogs (integration_id, issue_id);

-- The capacity screen reads worklogs by calendar range across the whole project, which
-- the per-issue index cannot serve (the jira_worklogs_started_idx reasoning).
create index plane_worklogs_started_idx on public.plane_worklogs (integration_id, started_at);

create table public.plane_attachments (
  integration_id   uuid not null references public.workspace_plane_integrations(id) on delete cascade,
  workspace_id     uuid not null references public.workspaces(id) on delete cascade,
  issue_id         text not null,
  attachment_id    text not null,
  filename         text not null,
  mime             text not null default '',
  size             bigint not null default 0,
  author_name      text not null default '',
  plane_created_at timestamptz not null,
  primary key (integration_id, attachment_id)
);

create index plane_attachments_issue_idx on public.plane_attachments (integration_id, issue_id);

grant select, insert, update, delete on table public.plane_comments to authenticated;
grant select, insert, update, delete on table public.plane_worklogs to authenticated;
grant select, insert, update, delete on table public.plane_attachments to authenticated;

create policy plane_comments_all_member on public.plane_comments
  for all to authenticated
  using      (public.is_workspace_member(workspace_id, auth.uid()))
  with check (public.is_workspace_member(workspace_id, auth.uid()));

create policy plane_worklogs_all_member on public.plane_worklogs
  for all to authenticated
  using      (public.is_workspace_member(workspace_id, auth.uid()))
  with check (public.is_workspace_member(workspace_id, auth.uid()));

create policy plane_attachments_all_member on public.plane_attachments
  for all to authenticated
  using      (public.is_workspace_member(workspace_id, auth.uid()))
  with check (public.is_workspace_member(workspace_id, auth.uid()));

alter table public.plane_comments    enable row level security;
alter table public.plane_worklogs    enable row level security;
alter table public.plane_attachments enable row level security;

-- ── shadow-task marker ────────────────────────────────────────────────────────
-- A launched Plane work item runs on an ordinary tasks row so the WHOLE session
-- pipeline (worktree, outbox, force-stop, tasks_guard) is reused unchanged. The
-- marker is what keeps the boards honest: the native board filters `plane_key is
-- null`, the Plane view joins the shadow task for its agent chip. Existing policies
-- and tasks_guard() predicate on rows, not column lists, so the column is covered the
-- moment it exists (the jira_key precedent).
alter table public.tasks
  add column if not exists plane_key text;
