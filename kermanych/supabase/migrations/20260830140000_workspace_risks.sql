-- The risk register moves UP a level: project_risks -> workspace_risks.
--
-- A register belongs to the group that carries the team and the membership, not to one
-- repository. Two reasons, and the second is the one that forced this:
--
--   * the people who raise, own and review risks are a WORKSPACE's members. 20260827100000
--     moved membership up — workspace_members replaced project_members, and
--     public.is_project_member is now only a wrapper that joins projects -> workspace_members.
--     A register scoped one level BELOW its own membership list has no reader of its own:
--     everyone who can see one project's risks can already see every risk in the workspace;
--   * per-project registers cannot answer «what is the risk exposure of product AAA». A
--     product is several repositories — api, ui, infra — and the risks that matter most are
--     exactly the ones that live in none of them alone: a key person, a vendor, a data
--     migration, an expiring licence. Filed per project, such a risk is either duplicated
--     into every repo (three rows, three codes, three owners, no single truth) or filed under
--     whichever repo the raiser happened to have open. Neither version can be summed.
--
-- Everything the register IS stays untouched: the three-part statement, the actions-required
-- rule, inherent AND residual scores, the append-only event log, and above all «a risk is
-- never deleted» — no delete grant, no delete policy. This migration changes only WHICH
-- column carries the scope, and re-mints the handful of codes that per-project minting could
-- have made ambiguous once two projects share a workspace.
--
-- Forward-only: migrations here are an append-only log pushed to the linked hosted project
-- (see scripts/verify-workspace-migration.ts), so 20260830120000_project_risks.sql is left
-- exactly as it was written and this file is the whole story of the move.

-- ── the triggers go FIRST, before any data statement ──────────────────────────
-- Not housekeeping — a correctness precondition. Two statements below run UPDATEs on the
-- register, and project_risks_touch() is a BEFORE UPDATE trigger that would corrupt them
-- three ways:
--
--   * `new.code := old.code` — the immutability rule that protects a code already cited in
--     minutes — would silently revert every re-mint in the dedupe step, leaving duplicate
--     (workspace_id, code) pairs that the new unique constraint then refuses;
--   * `new.updated_at := now(); new.updated_by := auth.uid()` would stamp the whole table
--     with this migration's timestamp and a NULL author (a migration has no auth.uid()),
--     erasing the audit trail this table exists to keep;
--   * project_risks_log() would append an 'edited' event per risk, so every register would
--     look like it had been reviewed on the day of the deploy.
--
-- The functions go with them: they are reachable only from these triggers, and their ports
-- are created at the bottom of this file, once the column they read exists.
drop trigger project_risks_touch on public.project_risks;
drop trigger project_risks_log   on public.project_risks;
drop function public.project_risks_touch();
drop function public.project_risks_log();

-- ── 1. the tables ─────────────────────────────────────────────────────────────
alter table public.project_risks       rename to workspace_risks;
alter table public.project_risk_events rename to workspace_risk_events;

-- ── 2. the objects a table rename does NOT rename ─────────────────────────────
-- A table rename touches pg_class for the table alone. Its primary-key index and the
-- bigserial's owned sequence keep the names Postgres derived from the OLD table name; left
-- alone they would be the only places in the catalog still saying «project» about
-- workspace-scoped data, and the next person reading \d workspace_risks would reasonably
-- conclude the move was half done.
alter index    public.project_risks_pkey           rename to workspace_risks_pkey;
alter index    public.project_risk_events_pkey     rename to workspace_risk_events_pkey;
alter sequence public.project_risk_events_id_seq   rename to workspace_risk_events_id_seq;
-- The event log's index is on (risk_id, at desc): it survives the move untouched, so it is
-- renamed rather than rebuilt.
alter index    public.project_risk_events_risk_idx rename to workspace_risk_events_risk_idx;

-- project_risks_project_idx is deliberately NOT in that list. It indexes project_id, so it
-- cannot outlive the column — `drop column` takes every index over that column with it, and a
-- rename would only have given the corpse the new name. The real
-- workspace_risks_workspace_idx is created below, over the new column.

-- ── 3. the new scope column, backfilled from the parent ───────────────────────
-- Nullable first: the column must exist before it can be filled, and `not null` is set once
-- both tables are complete.
--
-- `on delete cascade` is unchanged in spirit from the project-level version — a register is
-- part of the group it describes, so it goes when the group does. (projects.workspace_id is
-- `restrict` for the opposite reason: deleting a workspace must not silently take its projects
-- and every task on them. That refusal fires first, so this cascade only ever runs for a
-- workspace already emptied of projects.)
alter table public.workspace_risks
  add column workspace_id uuid references public.workspaces(id) on delete cascade;
alter table public.workspace_risk_events
  add column workspace_id uuid references public.workspaces(id) on delete cascade;

update public.workspace_risks r
   set workspace_id = p.workspace_id
  from public.projects p
 where p.id = r.project_id;

-- The event's scope is read from its RISK, not from projects: an event that disagreed with the
-- risk it belongs to would be unexplainable, and joining the risk makes that impossible by
-- construction rather than by two statements happening to agree.
update public.workspace_risk_events e
   set workspace_id = r.workspace_id
  from public.workspace_risks r
 where r.id = e.risk_id;

alter table public.workspace_risks       alter column workspace_id set not null;
alter table public.workspace_risk_events alter column workspace_id set not null;

-- The register screen reads one workspace at a time; this is the index behind that read, the
-- successor of project_risks_project_idx.
create index workspace_risks_workspace_idx on public.workspace_risks (workspace_id);

-- ── 4. dedupe `code` per workspace, BEFORE the new unique constraint ──────────
-- Codes were minted per PROJECT, so two projects that now sit in one workspace can each hold
-- R-001. Moving the scope column alone would therefore produce a table the new
-- `unique (workspace_id, code)` cannot accept.
--
-- The rule, and why it is this rule: within each (workspace_id, code) group the EARLIEST risk
-- by raised_at — tiebroken by id, so the outcome is deterministic even for two rows filed in
-- the same instant — KEEPS its code, because it is the one most likely to be cited in minutes
-- and status reports already written. Every later duplicate is re-minted strictly ABOVE that
-- workspace's current maximum numeric code. Not into the gaps, and not by renumbering the
-- group: a code is a permanent reference, so no number may ever be REUSED (a reader of an old
-- report would land on a different risk), and no renumbering may cascade onto a code that is
-- already cited. Minting above the maximum is the only assignment that satisfies both, and it
-- leaves the per-workspace sequence exactly where the touch function below continues from.
--
-- On almost every deployment this statement is a NO-OP: the 1:1 backfill in 20260827100000
-- gave each project its own workspace carrying the project's id, so project_id = workspace_id
-- and every group of duplicates has exactly one member. It must still exist, because that
-- state is not permanent by design — a team that has since merged its projects into one
-- workspace by drag-and-drop has real collisions, and a migration that assumed the
-- post-deploy shape would fail on precisely the teams that adopted workspaces.
update public.workspace_risks r
   set code = 'R-' || lpad(d.new_seq::text, 3, '0')
  from (
    with numbered as (
      select id,
             workspace_id,
             -- Same extraction the code minter uses, so «current maximum» means the same
             -- thing here and in workspace_risks_touch().
             nullif(regexp_replace(code, '\D', '', 'g'), '')::integer as seq,
             row_number() over (
               partition by workspace_id, code
               order by raised_at, id
             ) as dup_rank
        from public.workspace_risks
    ),
    peak as (
      select workspace_id, coalesce(max(seq), 0) as top_seq
        from numbered
       group by workspace_id
    ),
    -- Everything that is not the first row of its (workspace_id, code) group. The offsets are
    -- numbered per workspace, so the re-minted codes cannot collide with each other either.
    remint as (
      select id,
             workspace_id,
             row_number() over (
               partition by workspace_id
               order by seq nulls last, id
             ) as mint_offset
        from numbered
       where dup_rank > 1
    )
    select remint.id, peak.top_seq + remint.mint_offset as new_seq
      from remint
      join peak on peak.workspace_id = remint.workspace_id
  ) d
 where r.id = d.id;

-- ── 5. the scope of uniqueness follows the scope of the register ──────────────
-- project_risks_project_id_code_key is the Postgres-derived name of the inline
-- `unique (project_id, code)`. Dropped explicitly rather than left to fall with its column, so
-- the swap reads as one decision instead of a side effect.
alter table public.workspace_risks drop constraint project_risks_project_id_code_key;
alter table public.workspace_risks
  add constraint workspace_risks_workspace_id_code_key unique (workspace_id, code);

-- ── 6. RLS ────────────────────────────────────────────────────────────────────
-- The four policies are dropped and recreated rather than merely renamed, because the question
-- they ask has genuinely changed: not «may this user reach this project?» but «is this user a
-- member of this workspace?». public.is_workspace_member is the direct answer — one join
-- instead of is_project_member's projects -> workspace_members hop, and it stays correct for a
-- register whose workspace holds no project at all.
--
-- This has to happen BEFORE project_id is dropped, and that ordering is not cosmetic: a policy
-- is a dependent object of every column its expression names, so `drop column project_id`
-- REFUSES while the three project_risks_* policies still read it. The tempting one-word fix,
-- `drop column ... cascade`, would delete them silently — leaving a table with RLS enabled and
-- no select policy, i.e. a register that reads as empty to every member, and no error anywhere
-- to say why.
--
-- Still member-level, not owner-only: a register is maintained by the delivery team, the way
-- tasks are, not by whoever happens to own the workspace the way the skill library is.
-- Accountability is carried by `risk_owner`, `updated_by` and the event log — not by
-- withholding the pen from the people who meet the risks first.
--
-- There is still NO delete grant and NO delete policy on either table, and note that this
-- survived the move for free: grants and row-level security follow the table through a rename,
-- so «never delete a risk» was not off for a single statement of this migration. Closing a
-- risk is an UPDATE, with a closure note and a server-stamped date.
drop policy project_risks_select_member       on public.workspace_risks;
drop policy project_risks_insert_member       on public.workspace_risks;
drop policy project_risks_update_member       on public.workspace_risks;
drop policy project_risk_events_select_member on public.workspace_risk_events;

create policy workspace_risks_select_member on public.workspace_risks for select to authenticated
  using (public.is_workspace_member(workspace_id, auth.uid()));

create policy workspace_risks_insert_member on public.workspace_risks for insert to authenticated
  with check (public.is_workspace_member(workspace_id, auth.uid()));

create policy workspace_risks_update_member on public.workspace_risks for update to authenticated
  using      (public.is_workspace_member(workspace_id, auth.uid()))
  with check (public.is_workspace_member(workspace_id, auth.uid()));

create policy workspace_risk_events_select_member on public.workspace_risk_events for select to authenticated
  using (public.is_workspace_member(workspace_id, auth.uid()));

-- ── 7. the old scope column goes away ─────────────────────────────────────────
-- This is what makes the cutover clean: with the column gone, no row can carry two scopes and
-- nothing — query, policy or client — can quietly keep reading the old one. The remaining
-- dependent objects fall with it: project_risks_project_idx, project_risks_project_id_fkey and
-- project_risk_events_project_id_fkey.
alter table public.workspace_risks       drop column project_id;
alter table public.workspace_risk_events drop column project_id;

-- ── 8. the surviving constraints ──────────────────────────────────────────────
-- Postgres does not rename dependent objects when a table is renamed, so every constraint —
-- the six named by hand in 20260830120000 and the column checks and foreign keys Postgres
-- named itself — is restated here rather than left half-migrated. They are RENAMED, never
-- dropped and re-added: the rules are unchanged (a threat still cannot take an opportunity's
-- strategy, «monitor» is still not a response, a terminal status still needs a closure note),
-- a re-add would revalidate every row for nothing, and a table that momentarily lacked these
-- checks is a table a concurrent write could slip past.
alter table public.workspace_risks rename constraint project_risks_response_matches_kind      to workspace_risks_response_matches_kind;
alter table public.workspace_risks rename constraint project_risks_actions_required           to workspace_risks_actions_required;
alter table public.workspace_risks rename constraint project_risks_closure_note_required      to workspace_risks_closure_note_required;
alter table public.workspace_risks rename constraint project_risks_closed_at_matches_status   to workspace_risks_closed_at_matches_status;
alter table public.workspace_risks rename constraint project_risks_emv_pair                   to workspace_risks_emv_pair;
alter table public.workspace_risks rename constraint project_risks_residual_pair              to workspace_risks_residual_pair;
alter table public.workspace_risks rename constraint project_risks_cause_check                to workspace_risks_cause_check;
alter table public.workspace_risks rename constraint project_risks_event_check                to workspace_risks_event_check;
alter table public.workspace_risks rename constraint project_risks_consequence_check          to workspace_risks_consequence_check;
alter table public.workspace_risks rename constraint project_risks_probability_check          to workspace_risks_probability_check;
alter table public.workspace_risks rename constraint project_risks_impact_check               to workspace_risks_impact_check;
alter table public.workspace_risks rename constraint project_risks_cost_impact_check          to workspace_risks_cost_impact_check;
alter table public.workspace_risks rename constraint project_risks_probability_pct_check      to workspace_risks_probability_pct_check;
alter table public.workspace_risks rename constraint project_risks_residual_probability_check to workspace_risks_residual_probability_check;
alter table public.workspace_risks rename constraint project_risks_residual_impact_check      to workspace_risks_residual_impact_check;
alter table public.workspace_risks rename constraint project_risks_action_owner_fkey          to workspace_risks_action_owner_fkey;
alter table public.workspace_risks rename constraint project_risks_risk_owner_fkey            to workspace_risks_risk_owner_fkey;
alter table public.workspace_risks rename constraint project_risks_raised_by_fkey             to workspace_risks_raised_by_fkey;
alter table public.workspace_risks rename constraint project_risks_updated_by_fkey            to workspace_risks_updated_by_fkey;

alter table public.workspace_risk_events rename constraint project_risk_events_risk_id_fkey to workspace_risk_events_risk_id_fkey;
alter table public.workspace_risk_events rename constraint project_risk_events_actor_fkey   to workspace_risk_events_actor_fkey;

-- ── 9. the server-owned columns, ported ───────────────────────────────────────
-- A faithful port of project_risks_touch(): same `security definer set search_path = public`,
-- same set of columns a client must not be able to assert, same lifecycle rules. The scope
-- changed in three places only — the advisory-lock key, the max() scan and the
-- immutable-after-insert assignment.
create or replace function public.workspace_risks_touch() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  next_seq integer;
begin
  if tg_op = 'INSERT' then
    -- Serialised per WORKSPACE, because that is now the scope a code is unique in: two people
    -- filing a risk at the same moment — from two different projects of the same product,
    -- which is exactly the case this move makes normal — must not both mint R-014. A
    -- transaction-scoped advisory lock, so it is released with the insert and never blocks a
    -- different workspace.
    perform pg_advisory_xact_lock(hashtext('workspace_risks:' || new.workspace_id::text));
    select coalesce(max(nullif(regexp_replace(code, '\D', '', 'g'), '')::integer), 0) + 1
      into next_seq
      from public.workspace_risks
     where workspace_id = new.workspace_id;
    new.code := 'R-' || lpad(next_seq::text, 3, '0');
    new.raised_at := now();
    new.raised_by := auth.uid();
    new.last_reviewed_at := now();
  else
    -- Immutable after insert: reports and minutes cite the code, and the raiser is a fact
    -- about the past. The scope belongs on that list too — a risk cannot be moved to another
    -- workspace by an update, because its code is only unique inside the one it was minted in.
    -- A client that sends them anyway is ignored rather than refused, so a full-row update
    -- from the editor does not need to know they exist.
    new.code := old.code;
    new.workspace_id := old.workspace_id;
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

create trigger workspace_risks_touch
  before insert or update on public.workspace_risks
  for each row execute function public.workspace_risks_touch();

-- One event per write, classified by what actually changed, most consequential first: a reopen
-- that also re-scored the risk is filed as a status change, because that is the line a
-- steering committee reads. The classification order is reproduced unchanged — it is a product
-- decision, not a detail of the scope. `security definer` so the append happens even though
-- `authenticated` has no insert grant on the log: the history is not client-writable. The
-- event copies the RISK's workspace_id, never a value from the caller, which is what keeps the
-- log readable under exactly the same membership test as the register.
create or replace function public.workspace_risks_log() returns trigger
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

  insert into public.workspace_risk_events (risk_id, workspace_id, actor, kind, from_value, to_value)
  values (new.id, new.workspace_id, auth.uid(), k, v_from, v_to);
  return null;
end;
$$;

create trigger workspace_risks_log
  after insert or update on public.workspace_risks
  for each row execute function public.workspace_risks_log();

-- Still deliberately NOT added to supabase_realtime, and the move does not change the call: a
-- register is edited a handful of times a week in a screen that reads it on open, so a live
-- channel would buy nothing. A wider scope makes that read wider, not more frequent — the same
-- reasoning that keeps project_skills off the publication.
