-- Workspace password vault, third pass: the owner of a password shares it directly.
--
-- Until now the only way a developer could read a secret was to ask for it
-- (request_password_access) and wait for a manager to approve (decide_password_access).
-- The person who filed a credential often already knows who needs it, and making that
-- colleague ask first is a round trip for nothing. `share_password` lets the password's
-- OWNER hand it to a workspace member in one step.
--
-- Who is the owner of a password: the account that filed it (workspace_passwords.created_by,
-- server-stamped by workspace_passwords_touch, so it cannot be forged). The workspace owner
-- and every seated manager may share too — they already approve requests for every password,
-- so sharing is the same authority without the request. The filer keeps the right on their
-- own password even if later reseated as a developer, but loses it on leaving the workspace.
-- A share always goes to SOMEONE ELSE: a reseated filer cannot hand the secret back to
-- themselves.
--
-- A share is written into the existing ledger as an APPROVED row for the recipient, not into
-- a table of its own: can_read_password_secret, the password-files read policy and
-- list_password_holders all read that ledger, so a shared password becomes readable, and its
-- recipient appears in the access column, with no policy change. For a shared row
-- `requester_id` is the recipient and `decided_by` the sharer. A recipient who had already
-- asked has their pending (or declined) row turned into the approval, so their request
-- leaves the manager's pending list at the same moment.

-- "May u share THIS password?" — its filer while still a member, or a manager/owner of its
-- workspace. Same shape as can_manage_password.
create or replace function public.can_share_password(p_password_id uuid, u uuid)
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select exists (
    select 1 from public.workspace_passwords p
    where p.id = p_password_id
      and (
        (p.created_by = u and public.is_workspace_member(p.workspace_id, u))
        or public.can_manage_workspace_passwords(p.workspace_id, u)));
$$;

-- The third writer of the ledger, beside request_password_access and
-- decide_password_access; the ledger still has no INSERT/UPDATE grant, so a client cannot
-- write an approved row any other way. Idempotent: sharing again re-stamps the decision.
create or replace function public.share_password(p_password_id uuid, p_user_id uuid)
returns public.workspace_password_access
language plpgsql
security definer
set search_path = public
as $$
declare
  ws uuid;
  req public.workspace_password_access;
begin
  select workspace_id into ws from public.workspace_passwords where id = p_password_id;
  if ws is null then raise exception 'no such password'; end if;
  if not public.can_share_password(p_password_id, auth.uid()) then
    raise exception 'only the password''s owner or a workspace owner or manager can share it';
  end if;
  if p_user_id = auth.uid() then
    raise exception 'a password is shared with someone else, not with yourself';
  end if;
  if not public.is_workspace_member(ws, p_user_id) then
    raise exception 'a password can only be shared with a workspace member';
  end if;

  insert into public.workspace_password_access
    (password_id, workspace_id, requester_id, status, decided_by, decided_at)
  values (p_password_id, ws, p_user_id, 'approved', auth.uid(), now())
  on conflict (password_id, requester_id) do update
    set status = 'approved', decided_by = auth.uid(), decided_at = now()
  returning * into req;

  return req;
end;
$$;

comment on function public.share_password(uuid, uuid) is
  'Grants one workspace member read access to one password without a request: writes (or turns) their ledger row into an approved one. The password''s filer, the workspace owner or a manager only.';

revoke all on function public.share_password(uuid, uuid) from public, anon;
grant execute on function public.share_password(uuid, uuid) to authenticated;
