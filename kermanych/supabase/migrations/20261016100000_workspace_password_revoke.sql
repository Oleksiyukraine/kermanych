-- Workspace password vault, fourth pass: share with several members at once, and take a
-- share back.
--
-- 1. `share_password_with_members` — the share dialog picks several members in one go. The
--    shares land in ONE transaction through share_password, so either every picked member
--    can read the password or none can, and the dialog reports one refusal instead of a
--    half-applied share. share_password(uuid, uuid) stays for builds that predate this.
-- 2. `revoke_password_access` — the password's owner removes a member's grant. Until now the
--    ledger had no path that removed an approved row short of deleting the password. The
--    grant row is DELETED, not flipped to 'declined': the member never asked, and they are
--    simply back to "no access" (free to request again). Same authority as sharing
--    (can_share_password): the filer while still a member, the workspace owner, a manager.
--    Only a grant can be revoked — the workspace owner and managers read every password
--    through their seat, which is a role, not a vault entry.
-- 3. `list_password_holders` gains `via` ('owner' | 'manager' | 'grant'): the seat each
--    person reads through. The screen needs it to offer «Remove access» on grants only, and
--    a filer reseated as a developer cannot work it out from the ledger, whose RLS shows them
--    only their own rows. The return type changes, so the function is dropped and recreated;
--    a client that predates the column ignores it.

-- ── 1. share with several members ───────────────────────────────────────────────
create or replace function public.share_password_with_members(p_password_id uuid, p_user_ids uuid[])
returns setof public.workspace_password_access
language plpgsql
security definer
set search_path = public
as $$
declare
  uid uuid;
begin
  if coalesce(cardinality(p_user_ids), 0) = 0 then
    raise exception 'pick at least one member to share with';
  end if;
  -- share_password checks each recipient (a member, not the caller) and the caller's right
  -- to share; the first refusal aborts the whole call.
  for uid in select distinct u from unnest(p_user_ids) as u loop
    return next public.share_password(p_password_id, uid);
  end loop;
end;
$$;

comment on function public.share_password_with_members(uuid, uuid[]) is
  'Shares one password with several workspace members at once, all or nothing: share_password for each distinct id in one transaction. Returns the approved ledger rows. The password''s filer, the workspace owner or a manager only.';

revoke all on function public.share_password_with_members(uuid, uuid[]) from public, anon;
grant execute on function public.share_password_with_members(uuid, uuid[]) to authenticated;

-- ── 2. take a share back ─────────────────────────────────────────────────────────
-- The fourth writer of the ledger, and its only DELETE path besides the password's own
-- cascade. Removes the member's approved row; a pending or declined ask is left alone, since
-- it grants nothing and answering it is decide_password_access's job.
create or replace function public.revoke_password_access(p_password_id uuid, p_user_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not exists (select 1 from public.workspace_passwords where id = p_password_id) then
    raise exception 'no such password';
  end if;
  if not public.can_share_password(p_password_id, auth.uid()) then
    raise exception 'only the password''s owner or a workspace owner or manager can remove access to it';
  end if;

  delete from public.workspace_password_access
   where password_id = p_password_id
     and requester_id = p_user_id
     and status = 'approved';
  if not found then
    raise exception 'this member has no shared access to remove';
  end if;
end;
$$;

comment on function public.revoke_password_access(uuid, uuid) is
  'Removes one member''s approved grant on one password, so they can no longer read it (they may request again). The password''s filer, the workspace owner or a manager only. Seats (workspace owner, managers) are not grants and cannot be revoked here.';

revoke all on function public.revoke_password_access(uuid, uuid) from public, anon;
grant execute on function public.revoke_password_access(uuid, uuid) to authenticated;

-- ── 3. who may read each password, and through what ──────────────────────────────
-- Same answer and order as 20260928090000_workspace_password_fields.sql, plus `via`.
drop function public.list_password_holders(uuid);

create function public.list_password_holders(p_workspace_id uuid)
returns table (
  password_id uuid,
  user_id uuid,
  via text,
  github_username text,
  display_name text,
  avatar_url text)
language sql
security definer
stable
set search_path = public
as $$
  with holders as (
    select p.id as password_id, ws.owner_id as user_id, 0 as rank, null::timestamptz as since
      from public.workspace_passwords p
      join public.workspaces ws on ws.id = p.workspace_id
     where p.workspace_id = p_workspace_id
    union all
    select p.id, m.user_id, 1, m.added_at
      from public.workspace_passwords p
      join public.workspace_members m
        on m.workspace_id = p.workspace_id and m.role = 'manager'
     where p.workspace_id = p_workspace_id
    union all
    select a.password_id, a.requester_id, 2, a.decided_at
      from public.workspace_password_access a
     where a.workspace_id = p_workspace_id and a.status = 'approved'
  ),
  -- A person reachable two ways (a manager who once asked as a developer) counts once, at
  -- their strongest seat — and that seat is the `via` reported, so a manager is never
  -- offered a revoke that would leave them reading anyway.
  best as (
    select distinct on (h.password_id, h.user_id) h.password_id, h.user_id, h.rank, h.since
      from holders h
     order by h.password_id, h.user_id, h.rank
  )
  select b.password_id,
         b.user_id,
         case b.rank when 0 then 'owner' when 1 then 'manager' else 'grant' end,
         pr.github_username,
         pr.display_name,
         pr.avatar_url
    from best b
    left join public.profiles pr on pr.id = b.user_id
   where public.is_workspace_member(p_workspace_id, auth.uid())
   order by b.password_id, b.rank, b.since nulls first, b.user_id;
$$;

comment on function public.list_password_holders(uuid) is
  'Per password in the workspace, every person who may read its secret (owner, managers, approved requesters), the seat they read through (via: owner | manager | grant) and their public profile fields. Workspace-member-only; empty for anyone else. Never returns secret content.';

revoke all on function public.list_password_holders(uuid) from public, anon;
grant execute on function public.list_password_holders(uuid) to authenticated;
