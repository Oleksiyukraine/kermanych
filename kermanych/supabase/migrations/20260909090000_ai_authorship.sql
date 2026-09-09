-- «ШІ-команда» authorship. Every entity already recorded who last WROTE it
-- (updated_by / updated_at); this adds who FIRST created it (created_by / created_at), so the
-- UI can show both «автор» and «останній редагував». Additive and forward-only: existing rows
-- get created_at = now() (their real creation time is unrecoverable) and a NULL author.
alter table public.ai_skills        add column if not exists created_at timestamptz not null default now();
alter table public.ai_skills        add column if not exists created_by uuid references public.profiles(id) on delete set null;
alter table public.ai_agents        add column if not exists created_at timestamptz not null default now();
alter table public.ai_agents        add column if not exists created_by uuid references public.profiles(id) on delete set null;
alter table public.ai_agent_skills  add column if not exists created_at timestamptz not null default now();
alter table public.ai_agent_skills  add column if not exists created_by uuid references public.profiles(id) on delete set null;
alter table public.ai_triggers      add column if not exists created_at timestamptz not null default now();
alter table public.ai_triggers      add column if not exists created_by uuid references public.profiles(id) on delete set null;
alter table public.ai_trigger_skills add column if not exists created_at timestamptz not null default now();
alter table public.ai_trigger_skills add column if not exists created_by uuid references public.profiles(id) on delete set null;

-- ai_team_touch() stamps the audit columns server-side so a client cannot forge them. It now
-- ALSO stamps created_by/created_at, but ONLY on INSERT — an update must never rewrite the
-- author. Every one of the five ai_* tables carries the columns (above) and this same trigger,
-- and no other table uses this function (the old project_* tables were dropped), so reading
-- new.created_* is always valid.
create or replace function public.ai_team_touch() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  new.updated_at := now();
  new.updated_by := auth.uid();
  if tg_op = 'INSERT' then
    new.created_at := now();
    new.created_by := auth.uid();
  end if;
  return new;
end;
$$;
