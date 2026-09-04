-- Deleting a risk. This migration REVERSES a rule the register was built with, so it starts
-- by saying what that rule was and why it is being narrowed rather than dropped.
--
-- 20260830120000_project_risks.sql:10-13 stated it plainly: «a risk is NEVER deleted», with
-- no delete grant and no delete policy, so the only way out of the register was `closed` or
-- `materialized` WITH a closure note. That rule is right about the case it was written for —
-- a risk that HAPPENED or that went away is evidence, and deleting it destroys both the
-- audit trail and the lessons-learned input.
--
-- What it does not cover is the row that was never a risk: a test entry, a duplicate of one
-- already filed, an entry against the wrong workspace. Closing those does not preserve a
-- lesson, it files a lesson that does not exist — and every later reading of the register
-- (the escalation count, the contingency reserve, the lessons-learned review) then measures
-- itself against rows that were noise. That is the case this migration opens, and only that.
--
-- The rule therefore becomes NARROWER rather than gone, in three ways:
--
--   1. closing stays the documented way out. Nothing about `closed`/`materialized`, the
--      closure-note constraint or the event log changes here, and the assistant's prompt
--      still tells the model to prefer closing (management-prompt.ts, riskProtocol());
--   2. delete is workspace-OWNER only, unlike every other write on this table. Insert and
--      update are member-level because «a register is maintained by the delivery team»
--      (20260830140000:186-189) — that argument is about the pen, not the eraser. An
--      irreversible removal that also erases history is an administrative act, and it sits
--      with the seat that already carries administrative acts elsewhere in this schema
--      (invite_workspace_member, set_workspace_member_role, workspaces_delete_owner);
--   3. it stays a HARD delete, deliberately. A `deleted_at` column would have kept the
--      history, but it would also have put a row in the register that every read path must
--      remember to filter — and the rows this exists to remove are exactly the rows nobody
--      should have to keep filtering. The audit trail going with the risk is the accepted
--      cost, and it is the reason for (2).
--
-- Consequence worth stating explicitly: `workspace_risk_events.risk_id` is
-- `on delete cascade` (20260830120000:167), so a deleted risk takes its whole event history
-- with it. That cascade needs no grant and no policy of its own — a referential action runs
-- with the privileges of the table owner, not the caller — so `authenticated` still has
-- nothing but `select` on the event log, and the append-only rule there is untouched.

-- ── the owner test ────────────────────────────────────────────────────────────
-- `security definer`, for the same reason is_workspace_member is: a policy on
-- workspace_risks that subqueried public.workspaces would run that subquery as the CALLER,
-- and so under workspaces_select_member. That policy happens to admit owners today, which
-- makes the naive inline `exists (select 1 from workspaces …)` look correct — and leaves the
-- delete gate silently coupled to a SELECT policy on another table that nothing stops a
-- later migration from tightening. A definer function reads the column directly and says
-- what it means: this is about workspaces.owner_id, nothing else.
--
-- `stable` so the planner calls it once per statement rather than once per row, matching
-- is_workspace_member. Ownership authority is workspaces.owner_id and NOT the 'owner' value
-- of workspace_members.role — see 20260901100000_workspace_member_roles.sql:14-16, where
-- that column is documented as a label rather than a capability.
create or replace function public.is_workspace_owner(w uuid, u uuid)
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select exists (
    select 1 from public.workspaces
    where id = w and owner_id = u);
$$;

comment on function public.is_workspace_owner(uuid, uuid) is
  'True when u owns workspace w (workspaces.owner_id). Authority test for administrative acts on workspace-scoped data; not the workspace_members.role label.';

-- ── the grant and the policy ──────────────────────────────────────────────────
-- Both are required and they are not redundant: the grant is the table-level capability
-- (its absence is what made «never delete» fail one layer before RLS, for every client
-- including psql through PostgREST), and the policy is the row-level test. Granting without
-- the policy would delete nothing; the policy without the grant would be unreachable.
grant delete on table public.workspace_risks to authenticated;

-- No `with check` clause: DELETE policies take `using` only — the row is tested as it
-- stands, and there is no new version of it to check.
-- Idempotent: an earlier (colliding) migration version applied this policy out of band on
-- the shared remote, so drop any existing copy before recreating it at this canonical
-- version. On a fresh database the drop is a no-op and the create runs normally.
drop policy if exists workspace_risks_delete_owner on public.workspace_risks;
create policy workspace_risks_delete_owner on public.workspace_risks for delete to authenticated
  using (public.is_workspace_owner(workspace_id, auth.uid()));

comment on policy workspace_risks_delete_owner on public.workspace_risks is
  'Owner-only, unlike the member-level select/insert/update on this table: a delete is irreversible and cascades the risk''s event history away with it. Closing a risk (status closed/materialized with a closure note) remains the ordinary way out of the register.';

-- `anon` is untouched on purpose. 20260830120000:180-181 revoked everything from it and this
-- migration does not hand any of it back: an unauthenticated client still has no read of
-- this table, let alone a delete.
