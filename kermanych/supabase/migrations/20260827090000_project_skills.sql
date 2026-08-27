-- Per-project skill library. One ROW per skill, not a JSON blob on `projects`: bodies are
-- prose several members edit repeatedly, and a blob write would clobber a concurrent edit.
-- Deliberately NOT added to supabase_realtime: skills are read when a session launches.
create table public.project_skills (
  project_id  uuid not null references public.projects(id) on delete cascade,
  -- Also a directory name under ~/.kermanych/skills/<projectId>/, hence the strict pattern.
  name        text not null check (name ~ '^[a-z0-9][a-z0-9-]{0,63}$'),
  -- omp drops a custom-directory skill that has no description, so an empty one is invalid.
  description text not null check (length(btrim(description)) > 0),
  body        text not null,
  enabled     boolean not null default true,
  updated_at  timestamptz not null default now(),
  updated_by  uuid references public.profiles(id) on delete set null,
  primary key (project_id, name)
);

alter table public.project_skills enable row level security;
revoke all on public.project_skills from anon;
grant select, insert, update, delete on public.project_skills to authenticated;

-- Read: any member of the project. Write: the owner only, mirroring projects_update_owner.
create policy project_skills_select_member on public.project_skills for select to authenticated
  using (exists (select 1 from public.projects p
                 where p.id = project_id
                   and (p.owner_id = auth.uid() or public.is_project_member(p.id, auth.uid()))));

create policy project_skills_insert_owner on public.project_skills for insert to authenticated
  with check (exists (select 1 from public.projects p
                      where p.id = project_id and p.owner_id = auth.uid()));

create policy project_skills_update_owner on public.project_skills for update to authenticated
  using      (exists (select 1 from public.projects p
                      where p.id = project_id and p.owner_id = auth.uid()))
  with check (exists (select 1 from public.projects p
                      where p.id = project_id and p.owner_id = auth.uid()));

create policy project_skills_delete_owner on public.project_skills for delete to authenticated
  using (exists (select 1 from public.projects p
                 where p.id = project_id and p.owner_id = auth.uid()));

-- Server-owned audit columns, following tasks_guard(): a client cannot backdate an edit.
create or replace function public.project_skills_touch() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  new.updated_at := now();
  new.updated_by := auth.uid();
  return new;
end;
$$;

create trigger project_skills_touch
  before insert or update on public.project_skills
  for each row execute function public.project_skills_touch();
