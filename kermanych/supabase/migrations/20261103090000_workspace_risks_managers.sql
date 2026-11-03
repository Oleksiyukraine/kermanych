-- The risk register becomes a manager surface: the workspace owner and members seated
-- 'manager' read and keep it; a 'developer' no longer sees it at all.
--
-- Until now the register was member-level (20260830140000_workspace_risks.sql §6): any member
-- could read, file and edit a risk. The product decision reverses that — a register names
-- exposure, money and people, and it is the management team's working document, not the
-- delivery team's. The ui hides the section, its home tile and the assistant's risk actions
-- from a developer, but that is presentation; these policies are what make it true for a
-- direct PostgREST call too.
--
-- Delete stays exactly as 20260904130000_risk_delete.sql left it: owner-only, because a
-- delete is irreversible and cascades the event log away.
--
-- Forward-only, like every migration here.

-- ── the authority predicate ───────────────────────────────────────────────────
-- "May u see and keep this workspace's risk register?" — the owner, or a member seated
-- 'manager'. Its own function rather than a call to can_manage_workspace_passwords: the two
-- answers coincide today, but they are two product decisions, and a vault rule changed later
-- must not silently widen or narrow who reads the register. Same shape as is_workspace_member
-- (security definer + stable), so a policy calling it never recurses into a table it protects.
create or replace function public.can_access_workspace_risks(w uuid, u uuid)
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select exists (
    select 1 from public.workspaces ws
    where ws.id = w and ws.owner_id = u)
  or exists (
    select 1 from public.workspace_members m
    where m.workspace_id = w and m.user_id = u and m.role = 'manager');
$$;

comment on function public.can_access_workspace_risks(uuid, uuid) is
  'True when u owns workspace w or is seated there as ''manager''. The read and write gate of the risk register (workspace_risks, workspace_risk_events); a ''developer'' member is refused.';

-- ── the policies ──────────────────────────────────────────────────────────────
-- Dropped and recreated under new names, because the question they ask changed from
-- «is u a member» to «is u the owner or a manager». The event log follows the register: it is
-- written only by the security-definer workspace_risks_log() trigger, and its rows describe
-- the risks, so whoever cannot read a risk must not read its history either.
drop policy if exists workspace_risks_select_member       on public.workspace_risks;
drop policy if exists workspace_risks_insert_member       on public.workspace_risks;
drop policy if exists workspace_risks_update_member       on public.workspace_risks;
drop policy if exists workspace_risk_events_select_member on public.workspace_risk_events;

drop policy if exists workspace_risks_select_manager       on public.workspace_risks;
drop policy if exists workspace_risks_insert_manager       on public.workspace_risks;
drop policy if exists workspace_risks_update_manager       on public.workspace_risks;
drop policy if exists workspace_risk_events_select_manager on public.workspace_risk_events;

create policy workspace_risks_select_manager on public.workspace_risks for select to authenticated
  using (public.can_access_workspace_risks(workspace_id, auth.uid()));

create policy workspace_risks_insert_manager on public.workspace_risks for insert to authenticated
  with check (public.can_access_workspace_risks(workspace_id, auth.uid()));

create policy workspace_risks_update_manager on public.workspace_risks for update to authenticated
  using      (public.can_access_workspace_risks(workspace_id, auth.uid()))
  with check (public.can_access_workspace_risks(workspace_id, auth.uid()));

create policy workspace_risk_events_select_manager on public.workspace_risk_events for select to authenticated
  using (public.can_access_workspace_risks(workspace_id, auth.uid()));

-- The delete policy's comment contrasted it with the «member-level» policies above; restated
-- so \d+ does not describe a rule that no longer exists.
comment on policy workspace_risks_delete_owner on public.workspace_risks is
  'Owner-only, narrower than the owner-or-manager select/insert/update on this table: a delete is irreversible and cascades the risk''s event history away with it. Closing a risk (status closed/materialized with a closure note) remains the ordinary way out of the register.';
