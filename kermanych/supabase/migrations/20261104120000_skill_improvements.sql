-- Skill self-improvement (docs/specs/2026-11-04-skill-self-improvement.md). A session's agent
-- improves a skill of the operator's library through the `improve_skill` MCP tool; the api writes
-- the result into the operator's PERSONAL layer (an ai_skills row at user scope, which already
-- outranks project, workspace and the code defaults) and records the change here. ЦУК's
-- «Центр сповіщень» lists these records, shows a change and rolls it back.
--
-- One row per change, owned by the operator it was made for. Only that operator reads or writes
-- it: the personal layer is theirs alone, and so is its history. The api writes as the signed-in
-- operator (no service-role key exists), the browser marks rows seen and changes their state.
--
-- Forward-only, like every migration here.

create table public.skill_improvements (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references public.profiles(id) on delete cascade,
  -- Same expression as ai_skills.name: the name is also a directory name on disk.
  skill_name text not null check (skill_name ~ '^[a-z0-9][a-z0-9-]{0,63}$'),
  -- What the skill resolves to WITHOUT the personal layer at the time of the change: a Kermanych
  -- default, a workspace row, a project row, or nothing ('none': the skill exists only as the
  -- operator's own row). «Поширити на команду» writes back to it; the entry view compares it with
  -- the text the personal copy started from.
  team_scope text not null check (team_scope in ('default', 'workspace', 'project', 'none')),
  team_owner_id uuid,
  -- True when this change created the personal copy: rolling it back deletes the copy instead of
  -- restoring a text, so the team or default text applies again.
  created_copy boolean not null,
  -- The skill's text before the change. The text after is this with `edits` applied — computed,
  -- not stored, so a record costs one copy of the skill, not two.
  before_body text not null,
  edits jsonb not null check (jsonb_typeof(edits) = 'array' and jsonb_array_length(edits) between 1 and 5),
  summary text not null check (char_length(summary) between 1 and 120),
  reason text not null check (char_length(reason) between 1 and 1000),
  -- The session that made the change. Sessions live on one machine, so its name is copied for the
  -- column on every other machine. No foreign keys on project_id / workspace_id: a session may
  -- belong to a local-only project the cloud has never seen; the ids are labels the browser
  -- resolves against its own project list.
  session_id text not null,
  session_name text not null default '',
  project_id text,
  workspace_id uuid,
  state text not null default 'applied' check (state in ('applied', 'rolled_back', 'promoted')),
  state_at timestamptz not null default now(),
  seen_at timestamptz,
  created_at timestamptz not null default now()
);

comment on table public.skill_improvements is
  'Changes agents made to the operator''s skills (docs/specs/2026-11-04-skill-self-improvement.md): one row per change, owner-only, the newest 100 per user kept.';

-- The column's list (newest first) and the per-session cap the tool checks.
create index skill_improvements_user_created on public.skill_improvements (user_id, created_at desc);
create index skill_improvements_user_session on public.skill_improvements (user_id, session_id);

alter table public.skill_improvements enable row level security;

create policy skill_improvements_select_own on public.skill_improvements for select to authenticated
  using (user_id = auth.uid());

create policy skill_improvements_insert_own on public.skill_improvements for insert to authenticated
  with check (user_id = auth.uid());

create policy skill_improvements_update_own on public.skill_improvements for update to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

create policy skill_improvements_delete_own on public.skill_improvements for delete to authenticated
  using (user_id = auth.uid());

-- ── the newest 100 per user ────────────────────────────────────────────────────
-- Pruned on insert, so the table never holds more than the column can show and the history a
-- user can roll back is bounded (decision 5). security definer: it deletes the caller's own older
-- rows, which RLS would allow anyway, but must not depend on the caller's grants to do it.
create or replace function public.skill_improvements_prune()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  delete from public.skill_improvements
   where id in (
     select id from public.skill_improvements
      where user_id = new.user_id
      order by created_at desc, id desc
     offset 100
   );
  return null;
end;
$$;

create trigger skill_improvements_prune
  after insert on public.skill_improvements
  for each row execute function public.skill_improvements_prune();

-- Every machine where the operator's Kermanych is open hears a new change (the toast) and a
-- state change made on another machine. The browser binds with a `select` of the light columns,
-- so the skill's text never travels through Realtime.
alter publication supabase_realtime add table public.skill_improvements;

-- ── the switch ─────────────────────────────────────────────────────────────────
-- «Вдосконалювати навички» in Settings → «ШІ-провайдер». On by default; off means sessions launched
-- afterwards are not given the tool. RLS is unchanged: profiles_update_own already lets a user set
-- their own value, as for agent_language.
alter table public.profiles add column skill_improvement boolean not null default true;
