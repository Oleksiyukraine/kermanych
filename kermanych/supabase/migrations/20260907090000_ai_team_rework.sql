-- «ШІ-команда» rework: both entities that DO something — an agent and a trigger — now
-- carry an editable instruction plus an ORDERED SEQUENCE of skills, instead of a trigger
-- pointing at exactly one thing through the old single `target` column.
--
-- Two shapes change:
--   * a trigger's action is now 'prompt' (inject an instruction and/or a skill sequence) or
--     'agent' (launch a Kermanych agent). The old 'skill' action was 'prompt' with exactly
--     one skill and no text, so it migrates without asking the operator anything.
--   * an agent's compile-time instruction gains a per-project override (project_agents).
--
-- Forward-only, and it moves the existing rows: the order below is what keeps the data
-- readable at every step — the skill sequence is filled from `target` BEFORE `target` stops
-- meaning a skill name.

-- 1. The free-form text a 'prompt' trigger injects. DEFAULT '' and NOT NULL: every existing
--    trigger delivered a skill and no prose, which is exactly what the empty string says,
--    and «no instruction» must not be a third state beside «empty instruction».
alter table public.project_triggers
  add column if not exists instruction text not null default '';

-- 2. The trigger's skill sequence. Mirrors project_agent_skills row for row: one row per
--    assignment, `position` for the order, member reads, workspace-owner writes,
--    server-owned audit columns, not in the realtime publication (read at launch).
create table public.project_trigger_skills (
  project_id uuid not null,
  trigger_id text not null check (trigger_id ~ '^[a-z0-9][a-z0-9-]{0,63}$'),
  -- A NAME, not a foreign key: a Kermanych default has no project_skills row at all, and
  -- assigning one must be possible. Resolution happens at launch.
  skill_name text not null check (skill_name ~ '^[a-z0-9][a-z0-9-]{0,63}$'),
  position   int  not null default 0,
  updated_at timestamptz not null default now(),
  updated_by uuid references public.profiles(id) on delete set null,
  primary key (project_id, trigger_id, skill_name),
  -- The composite parent, not projects(id): deleting a trigger must take its sequence with
  -- it, and a dropped project already cascades into project_triggers and so into here.
  foreign key (project_id, trigger_id)
    references public.project_triggers(project_id, id) on delete cascade
);

-- 3. Backfill: an action='skill' trigger WAS a one-skill sequence. Position 0 — a single
--    entry has no order to preserve.
insert into public.project_trigger_skills (project_id, trigger_id, skill_name, position)
select project_id, id, target, 0
  from public.project_triggers
 where action = 'skill';

-- 4. `target` meant «a skill name or an agent id, depending on the action». Now only the
--    agent action needs it, so it becomes `agent_id` and NULLABLE.
alter table public.project_triggers
  rename column target to agent_id;
alter table public.project_triggers
  rename constraint project_triggers_target_check to project_triggers_agent_id_check;
alter table public.project_triggers
  alter column agent_id drop not null;

-- 5. Retire the 'skill' action, then clear the column it no longer owns. The old CHECK goes
--    FIRST: it still lists 'skill' and would reject the very update that retires it. The
--    replacement goes last, once every row reads 'prompt' or 'agent'.
alter table public.project_triggers
  drop constraint project_triggers_action_check;

update public.project_triggers set action = 'prompt' where action = 'skill';
update public.project_triggers set agent_id = null   where action = 'prompt';

alter table public.project_triggers
  add constraint project_triggers_action_check check (action in ('prompt', 'agent'));

-- 6. The two invariants the editor also enforces, stated where they are actually true —
--    for psql and for a direct PostgREST call as much as for the UI. A child omp process
--    cannot call back into Kermanych, so a trigger that RUNS AN AGENT is only meaningful
--    when Kermanych itself matched it, that is `source = 'operator'`.
alter table public.project_triggers
  drop constraint project_triggers_agent_action_is_operator;
alter table public.project_triggers
  add constraint project_triggers_agent_action_is_operator
    check (action <> 'agent' or (agent_id is not null and source = 'operator'));
alter table public.project_triggers
  add constraint project_triggers_prompt_action_has_no_agent
    check (action <> 'prompt' or agent_id is null);

-- 7. The per-project override of an agent's instruction. A MISSING row means «use the
--    compile-time default from packages/core's AGENTS registry» — which is why there is no
--    `enabled` flag and no empty-instruction sentinel: deleting the row IS the reset.
create table public.project_agents (
  project_id  uuid not null references public.projects(id) on delete cascade,
  -- The id of an entry in packages/core's AGENTS registry. Deliberately not an enum: the
  -- registry is code and gains entries without a migration.
  agent_id    text not null check (agent_id ~ '^[a-z0-9][a-z0-9-]{0,63}$'),
  -- Not length-checked: whether an override is usable depends on the `{{holes}}` the agent
  -- declares in code, which Postgres cannot see. core's instructionErrors() decides, and the
  -- api falls back to the default when the answer is «unusable».
  instruction text not null,
  updated_at  timestamptz not null default now(),
  updated_by  uuid references public.profiles(id) on delete set null,
  primary key (project_id, agent_id)
);

alter table public.project_trigger_skills enable row level security;
alter table public.project_agents         enable row level security;
revoke all on public.project_trigger_skills from anon;
revoke all on public.project_agents         from anon;
grant select, insert, update, delete on public.project_trigger_skills to authenticated;
grant select, insert, update, delete on public.project_agents         to authenticated;

-- Read: any project member. Write: the workspace owner. Same predicates project_skills and
-- project_agent_skills already carry.
create policy project_trigger_skills_select_member on public.project_trigger_skills
  for select to authenticated
  using (public.is_project_member(project_id, auth.uid()));

create policy project_trigger_skills_insert_owner on public.project_trigger_skills
  for insert to authenticated
  with check (exists (select 1 from public.projects p
                      join public.workspaces w on w.id = p.workspace_id
                      where p.id = project_id and w.owner_id = auth.uid()));

create policy project_trigger_skills_update_owner on public.project_trigger_skills
  for update to authenticated
  using      (exists (select 1 from public.projects p
                      join public.workspaces w on w.id = p.workspace_id
                      where p.id = project_id and w.owner_id = auth.uid()))
  with check (exists (select 1 from public.projects p
                      join public.workspaces w on w.id = p.workspace_id
                      where p.id = project_id and w.owner_id = auth.uid()));

create policy project_trigger_skills_delete_owner on public.project_trigger_skills
  for delete to authenticated
  using (exists (select 1 from public.projects p
                 join public.workspaces w on w.id = p.workspace_id
                 where p.id = project_id and w.owner_id = auth.uid()));

create policy project_agents_select_member on public.project_agents
  for select to authenticated
  using (public.is_project_member(project_id, auth.uid()));

create policy project_agents_insert_owner on public.project_agents
  for insert to authenticated
  with check (exists (select 1 from public.projects p
                      join public.workspaces w on w.id = p.workspace_id
                      where p.id = project_id and w.owner_id = auth.uid()));

create policy project_agents_update_owner on public.project_agents
  for update to authenticated
  using      (exists (select 1 from public.projects p
                      join public.workspaces w on w.id = p.workspace_id
                      where p.id = project_id and w.owner_id = auth.uid()))
  with check (exists (select 1 from public.projects p
                      join public.workspaces w on w.id = p.workspace_id
                      where p.id = project_id and w.owner_id = auth.uid()));

create policy project_agents_delete_owner on public.project_agents
  for delete to authenticated
  using (exists (select 1 from public.projects p
                 join public.workspaces w on w.id = p.workspace_id
                 where p.id = project_id and w.owner_id = auth.uid()));

-- Server-owned audit columns, the same ai_team_touch() the 20260828 tables use.
create trigger project_trigger_skills_touch
  before insert or update on public.project_trigger_skills
  for each row execute function public.ai_team_touch();

create trigger project_agents_touch
  before insert or update on public.project_agents
  for each row execute function public.ai_team_touch();
