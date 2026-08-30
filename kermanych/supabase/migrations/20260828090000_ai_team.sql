-- «ШІ команда»: which skills a project assigns to Kermanych's agents, and which triggers
-- fire them. Both mirror project_skills: one row per fact, member reads, workspace-owner
-- writes, server-owned audit columns, and NOT in the realtime publication (both are read
-- when a session launches).

create table public.project_agent_skills (
  project_id uuid not null references public.projects(id) on delete cascade,
  -- The id of an entry in packages/core's AGENTS registry. Deliberately not an enum: the
  -- registry is code and gains entries without a migration.
  agent_id   text not null check (agent_id ~ '^[a-z0-9][a-z0-9-]{0,63}$'),
  -- A NAME, not a foreign key: a Kermanych default has no project_skills row at all, and
  -- assigning one must be possible. Resolution happens at launch.
  skill_name text not null check (skill_name ~ '^[a-z0-9][a-z0-9-]{0,63}$'),
  position   int  not null default 0,
  updated_at timestamptz not null default now(),
  updated_by uuid references public.profiles(id) on delete set null,
  primary key (project_id, agent_id, skill_name)
);

create table public.project_triggers (
  project_id uuid not null references public.projects(id) on delete cascade,
  id         text not null check (id ~ '^[a-z0-9][a-z0-9-]{0,63}$'),
  label      text not null check (length(btrim(label, E' \t\r\n')) > 0),
  enabled    boolean not null default true,
  -- operator = matched by Kermanych before the message is forwarded;
  -- the rest = a TTSR rule inside the omp child.
  source     text not null check (source in ('operator', 'assistant', 'thinking', 'tool')),
  pattern    text not null check (length(btrim(pattern, E' \t\r\n')) > 0),
  path_globs text[],
  action     text not null check (action in ('skill', 'agent')),
  target     text not null check (target ~ '^[a-z0-9][a-z0-9-]{0,63}$'),
  mode       text not null default 'remind' check (mode in ('remind', 'interrupt')),
  repeat     text not null default 'once' check (repeat in ('once', 'after-gap')),
  updated_at timestamptz not null default now(),
  updated_by uuid references public.profiles(id) on delete set null,
  primary key (project_id, id),
  -- A child cannot call back into Kermanych, so only an operator-sourced trigger may run an
  -- agent. The editor blocks this too; the constraint is what makes it true.
  constraint project_triggers_agent_action_is_operator
    check (action <> 'agent' or source = 'operator')
);

alter table public.project_agent_skills enable row level security;
alter table public.project_triggers     enable row level security;
revoke all on public.project_agent_skills from anon;
revoke all on public.project_triggers     from anon;
grant select, insert, update, delete on public.project_agent_skills to authenticated;
grant select, insert, update, delete on public.project_triggers     to authenticated;

-- Read: any project member. Write: the workspace owner. Same predicates the workspaces
-- migration left on project_skills.
create policy project_agent_skills_select_member on public.project_agent_skills
  for select to authenticated
  using (public.is_project_member(project_id, auth.uid()));

create policy project_agent_skills_insert_owner on public.project_agent_skills
  for insert to authenticated
  with check (exists (select 1 from public.projects p
                      join public.workspaces w on w.id = p.workspace_id
                      where p.id = project_id and w.owner_id = auth.uid()));

create policy project_agent_skills_update_owner on public.project_agent_skills
  for update to authenticated
  using      (exists (select 1 from public.projects p
                      join public.workspaces w on w.id = p.workspace_id
                      where p.id = project_id and w.owner_id = auth.uid()))
  with check (exists (select 1 from public.projects p
                      join public.workspaces w on w.id = p.workspace_id
                      where p.id = project_id and w.owner_id = auth.uid()));

create policy project_agent_skills_delete_owner on public.project_agent_skills
  for delete to authenticated
  using (exists (select 1 from public.projects p
                 join public.workspaces w on w.id = p.workspace_id
                 where p.id = project_id and w.owner_id = auth.uid()));

create policy project_triggers_select_member on public.project_triggers
  for select to authenticated
  using (public.is_project_member(project_id, auth.uid()));

create policy project_triggers_insert_owner on public.project_triggers
  for insert to authenticated
  with check (exists (select 1 from public.projects p
                      join public.workspaces w on w.id = p.workspace_id
                      where p.id = project_id and w.owner_id = auth.uid()));

create policy project_triggers_update_owner on public.project_triggers
  for update to authenticated
  using      (exists (select 1 from public.projects p
                      join public.workspaces w on w.id = p.workspace_id
                      where p.id = project_id and w.owner_id = auth.uid()))
  with check (exists (select 1 from public.projects p
                      join public.workspaces w on w.id = p.workspace_id
                      where p.id = project_id and w.owner_id = auth.uid()));

create policy project_triggers_delete_owner on public.project_triggers
  for delete to authenticated
  using (exists (select 1 from public.projects p
                 join public.workspaces w on w.id = p.workspace_id
                 where p.id = project_id and w.owner_id = auth.uid()));

-- Server-owned audit columns, following project_skills_touch().
create or replace function public.ai_team_touch() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  new.updated_at := now();
  new.updated_by := auth.uid();
  return new;
end;
$$;

create trigger project_agent_skills_touch
  before insert or update on public.project_agent_skills
  for each row execute function public.ai_team_touch();

create trigger project_triggers_touch
  before insert or update on public.project_triggers
  for each row execute function public.ai_team_touch();
