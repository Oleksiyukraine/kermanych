-- Release notes, stored where they are read: in the workspace. The Менеджмент tab's
-- Release Notes section generates a note from one repository's git history (branch +
-- date range, on the machine where the project is bound), but the DOCUMENT belongs to
-- the group — every member of the workspace sees the same history, may copy it, and may
-- edit it, exactly like the risk register one section up the rail.
--
-- One table, no event log: a note is a document, not an audit register. Edits overwrite
-- the body and stamp `updated_at`/`updated_by`; the history the section shows is the list
-- of NOTES, not the list of edits to one note.
--
-- Deliberately NOT added to supabase_realtime: a note is generated a handful of times per
-- release cycle in a screen that refetches on open, so a live channel would buy nothing
-- (same call as workspace_risks and project_skills).

create table public.workspace_release_notes (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,

  -- The repository the note was generated from. `set null` rather than cascade: a note is
  -- workspace history and outlives the repo row it described — which is why `project_name`
  -- is denormalised beside it, a snapshot taken at generation so the header of an old note
  -- can still say which repo it covered after the project is deleted or renamed.
  project_id   uuid references public.projects(id) on delete set null,
  project_name text not null check (length(trim(project_name)) > 0),

  -- The shape the release ships in, in the reader's vocabulary — «що нового в iOS?».
  -- The list is RELEASE_PLATFORMS in @kermanych/core (release-notes.ts); this CHECK is the
  -- same list, and the api validates against the same constant before generating.
  platform     text not null check (platform in ('frontend', 'backend', 'ios', 'android')),

  -- What was generated FROM: the branch whose log was read, and the inclusive date range
  -- the commits were taken over. Facts about the generation, kept so the list can answer
  -- «чи вже є нотатка за серпень?» without opening every note.
  branch       text not null check (length(trim(branch)) > 0),
  range_from   date not null,
  range_to     date not null,

  title        text not null check (length(trim(title)) > 0),
  -- Markdown, the way the generator wrote it or the way a member last edited it.
  body_md      text not null,

  created_at   timestamptz not null default now(),
  created_by   uuid references auth.users(id) on delete set null,
  updated_at   timestamptz not null default now(),
  updated_by   uuid references auth.users(id) on delete set null,

  constraint workspace_release_notes_range check (range_to >= range_from)
);

-- The section reads one workspace at a time, newest first.
create index workspace_release_notes_workspace_idx
  on public.workspace_release_notes (workspace_id, created_at desc);

-- No `delete` grant and no delete policy, the register's rule for the register's reason:
-- the section's promise is «все, що згенеровано, зберігається у воркспейсі». A note that
-- came out wrong is EDITED — the body is a member's to rewrite entirely.
grant select, insert, update on table public.workspace_release_notes to authenticated;

-- Member-level like tasks and risks, not owner-only like the skill library: release notes
-- are written and polished by the delivery team, and membership already decides who may
-- read the workspace at all.
create policy workspace_release_notes_select_member on public.workspace_release_notes for select to authenticated
  using (public.is_workspace_member(workspace_id, auth.uid()));

create policy workspace_release_notes_insert_member on public.workspace_release_notes for insert to authenticated
  with check (public.is_workspace_member(workspace_id, auth.uid()));

create policy workspace_release_notes_update_member on public.workspace_release_notes for update to authenticated
  using      (public.is_workspace_member(workspace_id, auth.uid()))
  with check (public.is_workspace_member(workspace_id, auth.uid()));

alter table public.workspace_release_notes enable row level security;

-- Server-owned audit columns, the same shape as workspace_risks_touch() minus the code
-- minting: the client never asserts who wrote what or when.
create or replace function public.workspace_release_notes_touch() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    new.created_at := now();
    new.created_by := auth.uid();
  else
    -- Immutable after insert. The scope for the same reason a risk's is (the note was
    -- shared under this workspace's membership), the provenance because it is a fact
    -- about the past: an edit changes the TEXT, not what the note was generated from.
    new.workspace_id := old.workspace_id;
    new.project_id   := old.project_id;
    new.project_name := old.project_name;
    new.platform     := old.platform;
    new.branch       := old.branch;
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

create trigger workspace_release_notes_touch
  before insert or update on public.workspace_release_notes
  for each row execute function public.workspace_release_notes_touch();
