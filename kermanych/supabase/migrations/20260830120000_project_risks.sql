-- The project risk register. One ROW per risk, project-scoped like project_skills, and the
-- schema — not a convention in the UI — is what enforces the process rules a register is
-- worthless without:
--
--   * a risk statement is stored as its three PARTS (cause / event / consequence), because
--     «the API might be a problem» cannot be scored, owned or reviewed. There is no free-text
--     `statement` column to fall back into;
--   * a response is stored with its ACTIONS, and a non-accept strategy without actions is
--     rejected: «monitor» is not a response;
--   * a risk is NEVER deleted. `delete` is not granted on this table to anyone and no delete
--     policy exists, so the only way out of the register is `closed`/`materialized` WITH a
--     closure note and a server-stamped date. A deleted row would destroy both the audit
--     trail and the lessons-learned input;
--   * inherent AND residual scores are both kept, so a steering committee can see what the
--     mitigation actually bought;
--   * every material change appends to public.project_risk_events (below), which is the
--     register's freshness record and the evidence that the review cadence is being kept.
--
-- Deliberately NOT added to supabase_realtime: a register is edited a handful of times a
-- week in a screen that reads it on open, so a live channel would buy nothing (same call as
-- project_skills).

-- The base seven a PM scores everything against, plus the IT-specific categories an audit
-- now expects to see forced into every register. Merged into one list rather than two:
-- «security» and «data protection», and «vendor» and «third-party/SaaS lock-in», are the
-- same bucket, and a category a risk can be filed under twice is a category nobody filters on.
create type risk_category as enum (
  'technical',
  'security',        -- security and data protection, GDPR included
  'vendor',          -- third-party / SaaS dependency, vendor lock-in
  'resource',
  'external',
  'compliance',
  'organizational',
  'legacy',          -- legacy integration and technical debt
  'key_person',
  'infrastructure',  -- environment and infrastructure availability
  'data_migration',
  'performance',     -- non-functional requirements
  'licensing',
  'ai_model'         -- AI/model behaviour and data usage
);

-- Uncertainty cuts both ways, and the two directions take different strategies — which is
-- why this is a column and not an assumption that every row is a threat.
create type risk_kind as enum ('threat', 'opportunity');

-- Threat strategies and opportunity strategies in one type; which set applies is enforced
-- by project_risks_response_matches_kind below. `accept` is legal for both.
create type risk_response as enum (
  'avoid', 'reduce', 'transfer', 'escalate',
  'exploit', 'enhance', 'share',
  'accept'
);

-- `materialized` is the exit a risk takes when it stops being uncertain: it is now an issue
-- and needs a resolution plan, not a mitigation. Keeping it as a terminal status here rather
-- than moving the row keeps the audit trail in one place.
create type risk_status as enum ('open', 'treated', 'closed', 'materialized');

create table public.project_risks (
  id          uuid primary key default gen_random_uuid(),
  project_id  uuid not null references public.projects(id) on delete cascade,
  -- The stable reference quoted in reports and meeting minutes. Minted server-side as
  -- R-001, R-002 … per project (see project_risks_touch) and immutable afterwards: a
  -- renumbered risk breaks every document that already cites it.
  code        text not null,

  kind        risk_kind not null default 'threat',
  category    risk_category not null,

  -- cause -> event -> consequence. All three required and all three non-blank: this is the
  -- whole difference between a register that can be scored and a list of worries.
  cause       text not null check (length(btrim(cause, E' \t\r\n')) > 0),
  event       text not null check (length(btrim(event, E' \t\r\n')) > 0),
  consequence text not null check (length(btrim(consequence, E' \t\r\n')) > 0),

  -- The 1..5 scales are fixed before the project starts (see apps/ui/src/lib/risk.ts for the
  -- anchors each number carries). Exposure is derived, never stored by a client, so a row
  -- whose P or I was edited cannot keep a stale severity.
  probability smallint not null check (probability between 1 and 5),
  impact      smallint not null check (impact between 1 and 5),
  exposure    smallint generated always as ((probability * impact)::smallint) stored,

  -- The quantitative lane, for the risks that justify schedule and budget reserve. Both
  -- halves or neither: an EMV computed from a cost with no probability is a made-up number.
  cost_impact     numeric(14, 2) check (cost_impact is null or cost_impact >= 0),
  probability_pct smallint check (probability_pct is null or probability_pct between 0 and 100),
  emv             numeric(16, 2) generated always as (round(cost_impact * probability_pct / 100.0, 2)) stored,

  -- When it could hit. A high risk eight months out is not managed like one due next sprint,
  -- so the register sorts and colours on this independently of exposure.
  proximity   date,

  response         risk_response not null,
  -- Required unless the strategy is `accept` (constraint below). This is where «monitor is
  -- not a response» is actually enforced.
  response_actions text not null default '',
  action_owner     uuid references public.profiles(id) on delete set null,
  action_due       date,

  -- One named person with authority to act. A profile reference, so it cannot be «the team»
  -- or a free-text «PM». Nullable only because a profile row may outlive its account
  -- (`on delete set null`) — the editor refuses to save without one.
  risk_owner  uuid references public.profiles(id) on delete set null,

  -- The score after the response is implemented. Both halves or neither.
  residual_probability smallint check (residual_probability between 1 and 5),
  residual_impact      smallint check (residual_impact between 1 and 5),
  residual_exposure    smallint generated always as ((residual_probability * residual_impact)::smallint) stored,

  -- The observable that says this risk is turning into an issue. Free-text and optional at
  -- the schema level; the editor nags for it, because a risk with no trigger is a risk
  -- nobody will notice arriving.
  early_warning text not null default '',

  status       risk_status not null default 'open',
  -- On `closed` this is the reason; on `materialized` it is the resolution plan for the
  -- issue the risk became. One column, labelled by status in the editor: only ever one of
  -- the two applies, and a nullable pair would let a row carry both.
  closure_note text not null default '',
  closed_at    timestamptz,

  -- Audit trail. Server-owned (project_risks_touch): a client cannot backdate who raised
  -- what, and `last_reviewed_at` is what the weekly/monthly cadence is measured against.
  raised_at        timestamptz not null default now(),
  raised_by        uuid references public.profiles(id) on delete set null,
  last_reviewed_at timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  updated_by       uuid references public.profiles(id) on delete set null,

  unique (project_id, code),

  constraint project_risks_response_matches_kind check (
    (kind = 'threat' and response in ('avoid', 'reduce', 'transfer', 'escalate', 'accept'))
    or (kind = 'opportunity' and response in ('exploit', 'enhance', 'share', 'accept'))
  ),
  -- «Monitor» is not a response: anything but `accept` has to name what will be done.
  constraint project_risks_actions_required check (
    response = 'accept' or length(btrim(response_actions, E' \t\r\n')) > 0
  ),
  -- Never delete — close with a reason. A terminal status without one is refused.
  constraint project_risks_closure_note_required check (
    status in ('open', 'treated') or length(btrim(closure_note, E' \t\r\n')) > 0
  ),
  constraint project_risks_closed_at_matches_status check (
    (closed_at is not null) = (status in ('closed', 'materialized'))
  ),
  constraint project_risks_emv_pair check ((cost_impact is null) = (probability_pct is null)),
  constraint project_risks_residual_pair check (
    (residual_probability is null) = (residual_impact is null)
  )
);

create index project_risks_project_idx on public.project_risks (project_id);

-- The append-only history behind «never delete». Every material change to a risk lands here
-- with its actor and timestamp, which is what makes a closed row still useful at the
-- lessons-learned review and what proves the review cadence was kept.
--
-- `from_value`/`to_value` hold MACHINE tokens (enum labels, `3x4`), never prose: the UI owns
-- the wording, the same way it does for every other enum in this schema.
create type risk_event_kind as enum ('created', 'scored', 'response', 'status', 'reviewed', 'edited');

create table public.project_risk_events (
  id         bigserial primary key,
  risk_id    uuid not null references public.project_risks(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  at         timestamptz not null default now(),
  actor      uuid references public.profiles(id) on delete set null,
  kind       risk_event_kind not null,
  from_value text not null default '',
  to_value   text not null default ''
);

create index project_risk_events_risk_idx on public.project_risk_events (risk_id, at desc);

alter table public.project_risks enable row level security;
alter table public.project_risk_events enable row level security;
revoke all on table public.project_risks from anon;
revoke all on table public.project_risk_events from anon;

-- No `delete` in either grant, and no delete policy below. This is the strongest form the
-- «never delete a risk» rule can take: it fails one layer before RLS, for every client,
-- including psql through PostgREST. Closing a risk is an UPDATE.
grant select, insert, update on table public.project_risks to authenticated;
grant select on table public.project_risk_events to authenticated;

-- A register is maintained by the delivery team, not only by whoever owns the workspace, so
-- writes are member-level like tasks — not owner-only like the skill library. Accountability
-- is carried by `risk_owner`, `updated_by` and the event log, not by withholding the pen.
create policy project_risks_select_member on public.project_risks for select to authenticated
  using (public.is_project_member(project_id, auth.uid()));

create policy project_risks_insert_member on public.project_risks for insert to authenticated
  with check (public.is_project_member(project_id, auth.uid()));

create policy project_risks_update_member on public.project_risks for update to authenticated
  using      (public.is_project_member(project_id, auth.uid()))
  with check (public.is_project_member(project_id, auth.uid()));

create policy project_risk_events_select_member on public.project_risk_events for select to authenticated
  using (public.is_project_member(project_id, auth.uid()));

-- Server-owned identity, audit columns and lifecycle dates, following project_skills_touch().
-- Everything this function writes is something a client must not be able to assert.
create or replace function public.project_risks_touch() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  next_seq integer;
begin
  if tg_op = 'INSERT' then
    -- Serialised per project so two people filing a risk at the same moment cannot mint the
    -- same code. A transaction-scoped advisory lock, so it is released with the insert and
    -- never blocks a different project.
    perform pg_advisory_xact_lock(hashtext('project_risks:' || new.project_id::text));
    select coalesce(max(nullif(regexp_replace(code, '\D', '', 'g'), '')::integer), 0) + 1
      into next_seq
      from public.project_risks
     where project_id = new.project_id;
    new.code := 'R-' || lpad(next_seq::text, 3, '0');
    new.raised_at := now();
    new.raised_by := auth.uid();
    new.last_reviewed_at := now();
  else
    -- Immutable after insert: reports and minutes cite the code, and the raiser is a fact
    -- about the past. A client that sends them anyway is ignored rather than refused, so a
    -- full-row update from the editor does not need to know they exist.
    new.code := old.code;
    new.project_id := old.project_id;
    new.raised_at := old.raised_at;
    new.raised_by := old.raised_by;
  end if;

  -- The closure DATE is stamped when the risk leaves the register, and cleared if it is
  -- reopened, so `closed_at` can never disagree with `status`.
  if new.status in ('closed', 'materialized') then
    if new.closed_at is null then new.closed_at := now(); end if;
  else
    new.closed_at := null;
  end if;

  new.updated_at := now();
  new.updated_by := auth.uid();
  return new;
end;
$$;

create trigger project_risks_touch
  before insert or update on public.project_risks
  for each row execute function public.project_risks_touch();

-- One event per write, classified by what actually changed, most consequential first: a
-- reopen that also re-scored the risk is filed as a status change, because that is the line
-- a steering committee reads. `security definer` so the append happens even though
-- `authenticated` has no insert grant on the log — the history is not client-writable.
create or replace function public.project_risks_log() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  k risk_event_kind;
  v_from text := '';
  v_to   text := '';
begin
  if tg_op = 'INSERT' then
    k := 'created';
    v_to := new.probability || 'x' || new.impact;
  elsif new.status is distinct from old.status then
    k := 'status';
    v_from := old.status::text;
    v_to := new.status::text;
  elsif new.probability is distinct from old.probability
     or new.impact is distinct from old.impact
     or new.residual_probability is distinct from old.residual_probability
     or new.residual_impact is distinct from old.residual_impact then
    k := 'scored';
    v_from := old.probability || 'x' || old.impact
      || coalesce(' / ' || old.residual_probability || 'x' || old.residual_impact, '');
    v_to := new.probability || 'x' || new.impact
      || coalesce(' / ' || new.residual_probability || 'x' || new.residual_impact, '');
  elsif new.response is distinct from old.response
     or new.response_actions is distinct from old.response_actions
     or new.risk_owner is distinct from old.risk_owner
     or new.action_owner is distinct from old.action_owner
     or new.action_due is distinct from old.action_due then
    k := 'response';
    v_from := old.response::text;
    v_to := new.response::text;
  elsif new.last_reviewed_at is distinct from old.last_reviewed_at then
    k := 'reviewed';
  else
    k := 'edited';
  end if;

  insert into public.project_risk_events (risk_id, project_id, actor, kind, from_value, to_value)
  values (new.id, new.project_id, auth.uid(), k, v_from, v_to);
  return null;
end;
$$;

create trigger project_risks_log
  after insert or update on public.project_risks
  for each row execute function public.project_risks_log();
