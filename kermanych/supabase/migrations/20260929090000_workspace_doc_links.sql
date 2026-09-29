-- Documentation links move UP a level: project_doc_links -> workspace_doc_links.
--
-- A link points at a page that lives OUTSIDE every repository — a Google Doc, a Figma file, a
-- published artifact — so it has no project of its own to belong to. A product spec covers
-- the api, the ui and the infra repos at once; filed per project it is either pasted into each
-- (three rows, three titles drifting apart) or hidden under whichever repo the author had
-- open. The Project Documentation screen therefore shows its Links tab for the WORKSPACE:
-- always present, whatever project the Repository tab has selected, and even for a workspace
-- that has no project yet. The membership already agrees — is_project_member() is only a
-- wrapper over workspace_members, so no reader gains or loses a link by this move.
--
-- Forward-only, like 20260830140000_workspace_risks.sql, which this follows step for step:
-- 20260928110000_project_doc_links.sql stays exactly as it was pushed, and this file is the
-- whole story of the move. Existing links are kept, each re-homed to its project's workspace.

-- ── the trigger goes FIRST, before any data statement ─────────────────────────
-- project_doc_links_touch() is a BEFORE UPDATE trigger: it would pin `project_id := old`,
-- which is harmless here, but also stamp every row with this migration's time and a NULL
-- editor (a migration has no auth.uid()) — erasing who last touched each link. Its port is
-- created at the bottom, once the column it reads exists.
drop trigger project_doc_links_touch on public.project_doc_links;
drop function public.project_doc_links_touch();

-- ── 1. the table, and the objects a rename does not rename ────────────────────
alter table public.project_doc_links rename to workspace_doc_links;
alter index public.project_doc_links_pkey rename to workspace_doc_links_pkey;
-- project_doc_links_project_idx is NOT renamed: it indexes project_id and falls with that
-- column below. Its successor is created over the new column.

-- ── 2. the new scope column, backfilled from the parent ───────────────────────
-- Nullable first, `not null` once filled. `on delete cascade` like the register: a workspace
-- is only ever deleted once emptied of projects (projects.workspace_id is `restrict`), and its
-- links go with it.
alter table public.workspace_doc_links
  add column workspace_id uuid references public.workspaces(id) on delete cascade;

update public.workspace_doc_links l
   set workspace_id = p.workspace_id
  from public.projects p
 where p.id = l.project_id;

alter table public.workspace_doc_links alter column workspace_id set not null;

-- The screen reads one workspace at a time, in the order the links were added.
create index workspace_doc_links_workspace_idx on public.workspace_doc_links (workspace_id, created_at);

-- ── 3. RLS ────────────────────────────────────────────────────────────────────
-- Dropped and recreated, not renamed: the question changed from «may this user reach this
-- project?» to «is this user a member of this workspace?». It must happen BEFORE project_id is
-- dropped — the policy depends on that column, and `drop column ... cascade` would silently
-- leave a table with RLS on and no policy, i.e. links that read as empty to everyone.
-- Still member-level for read AND write: pointing the team at a spec is an ordinary member
-- action, and a wrong link is removed by whoever notices it.
drop policy project_doc_links_member on public.workspace_doc_links;

create policy workspace_doc_links_member on public.workspace_doc_links
  for all to authenticated
  using      (public.is_workspace_member(workspace_id, auth.uid()))
  with check (public.is_workspace_member(workspace_id, auth.uid()));

-- ── 4. the old scope column goes away ─────────────────────────────────────────
-- With it go project_doc_links_project_idx and project_doc_links_project_id_fkey; no row can
-- carry two scopes and no client can quietly keep reading the old one.
alter table public.workspace_doc_links drop column project_id;

-- ── 5. the surviving constraints, renamed (never dropped and re-added) ─────────
alter table public.workspace_doc_links rename constraint project_doc_links_title_check      to workspace_doc_links_title_check;
alter table public.workspace_doc_links rename constraint project_doc_links_url_check        to workspace_doc_links_url_check;
alter table public.workspace_doc_links rename constraint project_doc_links_created_by_fkey  to workspace_doc_links_created_by_fkey;
alter table public.workspace_doc_links rename constraint project_doc_links_updated_by_fkey  to workspace_doc_links_updated_by_fkey;

-- ── 6. the server-owned columns, ported ───────────────────────────────────────
-- A faithful port of project_doc_links_touch(): the client never asserts who added a link or
-- when, and a link cannot be re-homed to another workspace by an update (the workspace is
-- who may see it).
create or replace function public.workspace_doc_links_touch() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    new.created_at := now();
    new.created_by := auth.uid();
  else
    new.workspace_id := old.workspace_id;
    new.created_at := old.created_at;
    new.created_by := old.created_by;
  end if;
  new.updated_at := now();
  new.updated_by := auth.uid();
  return new;
end;
$$;

create trigger workspace_doc_links_touch
  before insert or update on public.workspace_doc_links
  for each row execute function public.workspace_doc_links_touch();

-- Still deliberately NOT added to supabase_realtime: the screen reads the list when a
-- workspace's documentation is opened.
