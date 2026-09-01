-- Kermanych workspace member roles — three named roles instead of the flat
-- owner/member split.
--
-- This narrowly reverses ONE decision from 20260827100000_workspaces.sql:137-142
-- ("no role-change feature exists"). That comment argued against granting UPDATE on
-- workspace_members because a table-level UPDATE would let an owner rewrite `user_id`
-- OR `role` — arbitrary forgery. We keep that invariant intact: NO update grant is
-- added here. The single new capability — change a member's role — arrives as a
-- `security definer` rpc that touches `role` ONLY, validates the target, and refuses
-- anyone but the workspace owner. Exactly the shape invite_workspace_member already
-- uses to be the sole INSERT path.
--
-- Roles carry NO authorization weight yet (labels-only, by request): every affordance
-- in the workspace scope is still decided by workspaces.owner_id, never by this column
-- — see apps/ui/src/pages/SettingsPage.vue:689-693. 'owner' stays the creator's seat
-- (workspaces.owner_id); ownership transfer remains out of scope, so the rpc cannot set
-- 'owner'. The two assignable roles are 'manager' and 'developer'.

-- ── the role vocabulary ───────────────────────────────────────────────────────
-- The inline check from the workspaces migration is auto-named
-- workspace_members_role_check. Drop it and widen to the three-role set. 'developer'
-- replaces the former default 'member'; the backfill below carries every existing
-- plain member across.
alter table public.workspace_members drop constraint if exists workspace_members_role_check;
alter table public.workspace_members
  add constraint workspace_members_role_check check (role in ('owner','manager','developer'));

update public.workspace_members set role = 'developer' where role = 'member';

-- ── invite now seats a developer ──────────────────────────────────────────────
-- Verbatim reproduction of 20260827100000_workspaces.sql's body with ONE change: the
-- default role of a freshly invited member is 'developer' rather than 'member'.
-- `create or replace` preserves the existing grants, so only the comment is restated.
create or replace function public.invite_workspace_member(p_workspace_id uuid, p_email text)
returns public.workspace_members
language plpgsql
security definer
set search_path = public
as $$
declare
  norm text := lower(nullif(trim(p_email), ''));
  target uuid;
  membership public.workspace_members;
begin
  if norm is null then raise exception 'email is required'; end if;

  if not exists (
       select 1 from public.workspaces w
       where w.id = p_workspace_id and w.owner_id = auth.uid()) then
    raise exception 'only the workspace owner can invite';
  end if;

  select u.id into target
    from auth.users u
    join public.profiles pr on pr.id = u.id
   where lower(u.email) = norm
   limit 1;

  if target is null then
    raise exception 'no Kermanych account for % — ask them to sign in with GitHub first', norm;
  end if;

  insert into public.workspace_members (workspace_id, user_id, role)
  values (p_workspace_id, target, 'developer')
  on conflict (workspace_id, user_id) do nothing
  returning * into membership;

  if membership is null then
    select * into membership from public.workspace_members
     where workspace_id = p_workspace_id and user_id = target;
  end if;

  return membership;
end;
$$;

comment on function public.invite_workspace_member(uuid, text) is
  'Adds the holder of an email address to a workspace as ''developer''. Owner-only. The address must already belong to a Kermanych account; no pending-invitation state exists. Idempotent. Never returns an email.';

-- ── set a member's role ───────────────────────────────────────────────────────
-- The sole role-mutation path, and the reason no UPDATE grant is needed on the table.
-- `security definer` so it runs as the function owner and bypasses the (deliberately
-- absent) member-write policies — the same mechanism invite_workspace_member relies on.
--
-- Three refusals, in order: not the owner; a role outside the assignable set (so 'owner'
-- can never be handed out — ownership lives in workspaces.owner_id and transfer is out of
-- scope); and the owner's OWN seat, which stays 'owner' forever. A no-match UPDATE would
-- otherwise silently succeed with zero rows, so the final guard turns "no such member"
-- into a legible error rather than a quiet no-op.
create or replace function public.set_workspace_member_role(
  p_workspace_id uuid, p_user_id uuid, p_role text)
returns public.workspace_members
language plpgsql
security definer
set search_path = public
as $$
declare
  ws public.workspaces;
  membership public.workspace_members;
begin
  select * into ws from public.workspaces where id = p_workspace_id;
  if ws.id is null or ws.owner_id <> auth.uid() then
    raise exception 'only the workspace owner can change roles';
  end if;

  if p_role not in ('manager','developer') then
    raise exception 'role must be manager or developer';
  end if;

  if p_user_id = ws.owner_id then
    raise exception 'the workspace owner keeps the owner role';
  end if;

  update public.workspace_members
     set role = p_role
   where workspace_id = p_workspace_id and user_id = p_user_id
  returning * into membership;

  if membership is null then
    raise exception 'no such workspace member';
  end if;

  return membership;
end;
$$;

comment on function public.set_workspace_member_role(uuid, uuid, text) is
  'Sets a workspace member''s role to ''manager'' or ''developer''. Owner-only. Cannot touch the owner''s own seat and cannot grant ''owner''. The only writer of workspace_members.role — the table has no UPDATE grant.';

revoke all on function public.set_workspace_member_role(uuid, uuid, text) from public, anon;
grant execute on function public.set_workspace_member_role(uuid, uuid, text) to authenticated;
