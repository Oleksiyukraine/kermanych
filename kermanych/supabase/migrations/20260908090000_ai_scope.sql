-- «ШІ-команда» rescope. The five tables that were always project-scoped
-- (project_skills, project_agents, project_agent_skills, project_triggers,
-- project_trigger_skills) now belong to exactly ONE of a workspace, a project or a user.
-- Only the SCOPE is unified — the three entity kinds keep their own typed tables and their
-- own CHECK constraints; a skill is still a name+body, an agent is still an override of a
-- code-registry id, a trigger is still a rule. What changes is the owner: a nullable triad
-- (workspace_id, project_id, user_id) with a CHECK that exactly one is set.
--
--   workspace  — shared defaults for the whole group (read: member, write: owner)
--   project    — this project's specifics       (read: member, write: workspace owner)
--   user       — the signed-in operator's private overlay (read/write: only that user)
--
-- Precedence at launch (resolved in apps/api SkillsService, not here):
--   instruction override : user > project > workspace > code default
--   skill body by name    : repo > user > project > workspace > DEFAULT_SKILLS
--   agent skill sequence  : the most specific scope that defines one (user→project→workspace)
--   triggers              : the UNION of all three scopes; on a slug clash, user > project > workspace
--
-- Forward-only. The existing project_* rows are copied in as scope=project BEFORE the audit
-- triggers exist (so their original updated_at/updated_by survive the copy), then the old
-- tables are dropped.

-- ── shared authorization predicates ─────────────────────────────────────────
-- One reader/writer test reused by all five tables, so the policy shape lives in one place
-- instead of being retyped per table. security definer + stable, like is_workspace_member:
-- they never recurse into the table they protect and the planner calls them once per
-- statement. `else false` covers the degenerate all-null row the CHECK already forbids.
create or replace function public.ai_can_read(ws uuid, proj uuid, usr uuid)
returns boolean language sql security definer stable set search_path = public as $$
  select case
    when ws   is not null then public.is_workspace_member(ws, auth.uid())
    when proj is not null then public.is_project_member(proj, auth.uid())
    when usr  is not null then usr = auth.uid()
    else false
  end
$$;

create or replace function public.ai_can_write(ws uuid, proj uuid, usr uuid)
returns boolean language sql security definer stable set search_path = public as $$
  select case
    when ws   is not null then public.is_workspace_owner(ws, auth.uid())
    when proj is not null then exists (
      select 1 from public.projects p
       where p.id = proj and public.is_workspace_owner(p.workspace_id, auth.uid()))
    when usr  is not null then usr = auth.uid()
    else false
  end
$$;

grant execute on function public.ai_can_read(uuid, uuid, uuid)  to authenticated;
grant execute on function public.ai_can_write(uuid, uuid, uuid) to authenticated;

-- ── the library ──────────────────────────────────────────────────────────────
create table public.ai_skills (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid references public.workspaces(id) on delete cascade,
  project_id   uuid references public.projects(id)   on delete cascade,
  user_id      uuid references public.profiles(id)   on delete cascade,
  constraint ai_skills_one_owner check (num_nonnulls(workspace_id, project_id, user_id) = 1),
  name        text not null check (name ~ '^[a-z0-9][a-z0-9-]{0,63}$'),
  description text not null default '',
  body        text not null default '',
  -- enabled=false on a row whose name matches a DEFAULT_SKILL turns that default off at this
  -- scope — the same lever project_skills carried.
  enabled     boolean not null default true,
  updated_at  timestamptz not null default now(),
  updated_by  uuid references public.profiles(id) on delete set null
);
-- A name is unique WITHIN one owner; the same name may exist at every scope, and the launch
-- resolver picks by precedence. ONE constraint over the whole triad with NULLS NOT DISTINCT
-- (PG15): the two null owner columns of any row compare equal, so (null, p1, null, 'x') can
-- appear once — and onConflict can infer this constraint, which a partial index cannot give.
alter table public.ai_skills add constraint ai_skills_owner_name
  unique nulls not distinct (workspace_id, project_id, user_id, name);

-- ── agent instruction overrides ────────────────────────────────────────────
create table public.ai_agents (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid references public.workspaces(id) on delete cascade,
  project_id   uuid references public.projects(id)   on delete cascade,
  user_id      uuid references public.profiles(id)   on delete cascade,
  constraint ai_agents_one_owner check (num_nonnulls(workspace_id, project_id, user_id) = 1),
  -- The id of an entry in packages/core's AGENTS registry. Not an enum: the registry is code
  -- and gains entries without a migration. A MISSING row means «use the compile-time default».
  agent_id    text not null check (agent_id ~ '^[a-z0-9][a-z0-9-]{0,63}$'),
  instruction text not null,
  updated_at  timestamptz not null default now(),
  updated_by  uuid references public.profiles(id) on delete set null
);
alter table public.ai_agents add constraint ai_agents_owner_agent
  unique nulls not distinct (workspace_id, project_id, user_id, agent_id);

-- ── agent skill sequences ──────────────────────────────────────────────────
-- Independent of ai_agents on purpose: a scope can hand an agent a skill sequence without
-- overriding its instruction, exactly as project_agent_skills was independent of
-- project_agents. skill_name is a NAME, not a foreign key — a Kermanych default has no row.
create table public.ai_agent_skills (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid references public.workspaces(id) on delete cascade,
  project_id   uuid references public.projects(id)   on delete cascade,
  user_id      uuid references public.profiles(id)   on delete cascade,
  constraint ai_agent_skills_one_owner check (num_nonnulls(workspace_id, project_id, user_id) = 1),
  agent_id   text not null check (agent_id   ~ '^[a-z0-9][a-z0-9-]{0,63}$'),
  skill_name text not null check (skill_name ~ '^[a-z0-9][a-z0-9-]{0,63}$'),
  position   int  not null default 0,
  updated_at timestamptz not null default now(),
  updated_by uuid references public.profiles(id) on delete set null
);
alter table public.ai_agent_skills add constraint ai_agent_skills_owner_key
  unique nulls not distinct (workspace_id, project_id, user_id, agent_id, skill_name);

-- ── triggers ───────────────────────────────────────────────────────────────
-- A trigger is a created entity with a user-chosen slug, so it carries a surrogate id and its
-- skill child hangs off that id — cleaner than a composite (owner, slug) foreign key across a
-- nullable triad.
create table public.ai_triggers (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid references public.workspaces(id) on delete cascade,
  project_id   uuid references public.projects(id)   on delete cascade,
  user_id      uuid references public.profiles(id)   on delete cascade,
  constraint ai_triggers_one_owner check (num_nonnulls(workspace_id, project_id, user_id) = 1),
  slug       text not null check (slug ~ '^[a-z0-9][a-z0-9-]{0,63}$'),
  label      text not null check (length(btrim(label, E' \t\r\n')) > 0),
  enabled    boolean not null default true,
  source     text not null check (source in ('operator', 'assistant', 'thinking', 'tool')),
  pattern    text not null check (length(btrim(pattern, E' \t\r\n')) > 0),
  path_globs text[],
  action     text not null check (action in ('prompt', 'agent')),
  instruction text not null default '',
  agent_id   text check (agent_id ~ '^[a-z0-9][a-z0-9-]{0,63}$'),
  mode       text not null default 'remind' check (mode in ('remind', 'interrupt')),
  repeat     text not null default 'once' check (repeat in ('once', 'after-gap')),
  updated_at timestamptz not null default now(),
  updated_by uuid references public.profiles(id) on delete set null,
  -- A child omp process cannot call back into Kermanych, so an agent action is meaningful only
  -- when Kermanych itself matched the trigger — that is source='operator' — and it needs an
  -- agent id. A prompt action carries no agent id.
  constraint ai_triggers_agent_action  check (action <> 'agent'  or (agent_id is not null and source = 'operator')),
  constraint ai_triggers_prompt_action check (action <> 'prompt' or agent_id is null)
);
alter table public.ai_triggers add constraint ai_triggers_owner_slug
  unique nulls not distinct (workspace_id, project_id, user_id, slug);

create table public.ai_trigger_skills (
  id uuid primary key default gen_random_uuid(),
  -- The owner is the trigger's; cascade takes the sequence with the trigger, and the trigger's
  -- own owner cascade already takes it when a workspace/project/user is deleted.
  trigger_id uuid not null references public.ai_triggers(id) on delete cascade,
  skill_name text not null check (skill_name ~ '^[a-z0-9][a-z0-9-]{0,63}$'),
  position   int  not null default 0,
  updated_at timestamptz not null default now(),
  updated_by uuid references public.profiles(id) on delete set null,
  unique (trigger_id, skill_name)
);

-- ── move the existing project rows in (scope=project) ───────────────────────
-- Before the audit triggers exist, so the copied updated_at/updated_by are the originals and
-- not now()/null. RLS is not yet enabled either; this runs as the migration role regardless.
insert into public.ai_skills (project_id, name, description, body, enabled, updated_at, updated_by)
select project_id, name, description, body, enabled, updated_at, updated_by from public.project_skills;

insert into public.ai_agents (project_id, agent_id, instruction, updated_at, updated_by)
select project_id, agent_id, instruction, updated_at, updated_by from public.project_agents;

insert into public.ai_agent_skills (project_id, agent_id, skill_name, position, updated_at, updated_by)
select project_id, agent_id, skill_name, position, updated_at, updated_by from public.project_agent_skills;

with moved as (
  insert into public.ai_triggers
    (project_id, slug, label, enabled, source, pattern, path_globs, action, instruction, agent_id, mode, repeat, updated_at, updated_by)
  select project_id, id, label, enabled, source, pattern, path_globs, action, instruction, agent_id, mode, repeat, updated_at, updated_by
    from public.project_triggers
  returning id as new_id, project_id, slug
)
insert into public.ai_trigger_skills (trigger_id, skill_name, position, updated_at, updated_by)
select m.new_id, ts.skill_name, ts.position, ts.updated_at, ts.updated_by
  from public.project_trigger_skills ts
  join moved m on m.project_id = ts.project_id and m.slug = ts.trigger_id;

-- ── audit triggers (after the copy) ─────────────────────────────────────────
-- ai_team_touch() (20260828090000) stamps updated_at + updated_by = auth.uid() on every write.
create trigger ai_skills_touch        before insert or update on public.ai_skills        for each row execute function public.ai_team_touch();
create trigger ai_agents_touch        before insert or update on public.ai_agents        for each row execute function public.ai_team_touch();
create trigger ai_agent_skills_touch  before insert or update on public.ai_agent_skills  for each row execute function public.ai_team_touch();
create trigger ai_triggers_touch      before insert or update on public.ai_triggers      for each row execute function public.ai_team_touch();
create trigger ai_trigger_skills_touch before insert or update on public.ai_trigger_skills for each row execute function public.ai_team_touch();

-- ── RLS ──────────────────────────────────────────────────────────────────────
alter table public.ai_skills        enable row level security;
alter table public.ai_agents        enable row level security;
alter table public.ai_agent_skills  enable row level security;
alter table public.ai_triggers      enable row level security;
alter table public.ai_trigger_skills enable row level security;

revoke all on public.ai_skills, public.ai_agents, public.ai_agent_skills, public.ai_triggers, public.ai_trigger_skills from anon;
grant select, insert, update, delete on public.ai_skills, public.ai_agents, public.ai_agent_skills, public.ai_triggers, public.ai_trigger_skills to authenticated;

-- The four owner-triad tables share one policy shape via the helpers. `all` with the same
-- predicate on USING and WITH CHECK: a read is ai_can_read, every write is ai_can_write.
-- Two policies (select member, write owner) rather than one `for all`, because read and write
-- differ (a member reads, only the owner writes).
create policy ai_skills_read  on public.ai_skills for select to authenticated using (public.ai_can_read(workspace_id, project_id, user_id));
create policy ai_skills_write on public.ai_skills for all to authenticated
  using (public.ai_can_write(workspace_id, project_id, user_id)) with check (public.ai_can_write(workspace_id, project_id, user_id));

create policy ai_agents_read  on public.ai_agents for select to authenticated using (public.ai_can_read(workspace_id, project_id, user_id));
create policy ai_agents_write on public.ai_agents for all to authenticated
  using (public.ai_can_write(workspace_id, project_id, user_id)) with check (public.ai_can_write(workspace_id, project_id, user_id));

create policy ai_agent_skills_read  on public.ai_agent_skills for select to authenticated using (public.ai_can_read(workspace_id, project_id, user_id));
create policy ai_agent_skills_write on public.ai_agent_skills for all to authenticated
  using (public.ai_can_write(workspace_id, project_id, user_id)) with check (public.ai_can_write(workspace_id, project_id, user_id));

create policy ai_triggers_read  on public.ai_triggers for select to authenticated using (public.ai_can_read(workspace_id, project_id, user_id));
create policy ai_triggers_write on public.ai_triggers for all to authenticated
  using (public.ai_can_write(workspace_id, project_id, user_id)) with check (public.ai_can_write(workspace_id, project_id, user_id));

-- The child inherits its parent's owner: a member of the trigger's scope may read the
-- sequence, and whoever may write the trigger may write its skills.
create policy ai_trigger_skills_read on public.ai_trigger_skills for select to authenticated
  using (exists (select 1 from public.ai_triggers t where t.id = trigger_id
                 and public.ai_can_read(t.workspace_id, t.project_id, t.user_id)));
create policy ai_trigger_skills_write on public.ai_trigger_skills for all to authenticated
  using      (exists (select 1 from public.ai_triggers t where t.id = trigger_id
                      and public.ai_can_write(t.workspace_id, t.project_id, t.user_id)))
  with check (exists (select 1 from public.ai_triggers t where t.id = trigger_id
                      and public.ai_can_write(t.workspace_id, t.project_id, t.user_id)));

-- ── drop the old project-only tables ────────────────────────────────────────
-- Children first. DROP TABLE takes each table's own policies and triggers with it; the shared
-- ai_team_touch() and the membership helpers stay, still used above.
drop table public.project_trigger_skills;
drop table public.project_triggers;
drop table public.project_agent_skills;
drop table public.project_agents;
drop table public.project_skills;
