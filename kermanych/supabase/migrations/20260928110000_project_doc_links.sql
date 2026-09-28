-- Documentation that does not live in the repository: a Google Doc, a Figma file, a published
-- Claude artifact, a Notion page. The Project Documentation screen lists these links beside
-- the repository folders and opens each one embedded in its preview pane.
--
-- ADDITIVE ONLY — one table, its policy and its touch trigger — so it is safe to push
-- whenever. Only the LINK is stored (title + URL): the page itself is loaded by each
-- member's own app straight from its host, never fetched or cached here.
--
-- One ROW per link, not a JSON array on `projects` like doc_folders: members add, rename and
-- remove links independently, and a blob write would clobber a concurrent edit (the same call
-- project_skills made). Deliberately NOT added to supabase_realtime: the screen reads the
-- list when a project is opened.
create table public.project_doc_links (
  id         uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  title      text not null check (length(btrim(title, E' \t\r\n')) between 1 and 200),
  -- http(s) only: the URL is loaded into an iframe and handed to the OS browser, and a
  -- `javascript:`/`file:` value must not be storable by any client, not just refused by ours.
  url        text not null check (url ~* '^https?://[^[:space:]]+$' and length(url) <= 2048),
  created_at timestamptz not null default now(),
  created_by uuid references public.profiles(id) on delete set null,
  updated_at timestamptz not null default now(),
  updated_by uuid references public.profiles(id) on delete set null
);

-- The screen reads one project at a time, in the order the links were added.
create index project_doc_links_project_idx on public.project_doc_links (project_id, created_at);

alter table public.project_doc_links enable row level security;
revoke all on table public.project_doc_links from anon;
grant select, insert, update, delete on table public.project_doc_links to authenticated;

-- Read AND write = any project member, derived live through is_project_member() (never a
-- denormalised workspace_id, so a moved project takes its links with it). Member-level like
-- the doc index, not owner-only like project_skills: pointing the team at a spec is an
-- ordinary member action, and a wrong link is removed by whoever notices it.
create policy project_doc_links_member on public.project_doc_links
  for all to authenticated
  using      (public.is_project_member(project_id, auth.uid()))
  with check (public.is_project_member(project_id, auth.uid()));

-- Server-owned audit columns, following workspace_release_notes_touch(): the client never
-- asserts who added a link or when, and a link cannot be re-homed to another project by an
-- update (the project is part of who may see it).
create or replace function public.project_doc_links_touch() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    new.created_at := now();
    new.created_by := auth.uid();
  else
    new.project_id := old.project_id;
    new.created_at := old.created_at;
    new.created_by := old.created_by;
  end if;
  new.updated_at := now();
  new.updated_by := auth.uid();
  return new;
end;
$$;

create trigger project_doc_links_touch
  before insert or update on public.project_doc_links
  for each row execute function public.project_doc_links_touch();
