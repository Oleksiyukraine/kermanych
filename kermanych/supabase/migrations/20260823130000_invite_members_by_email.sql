-- Membership by email, invited by any member.
--
-- Supersedes two decisions from 20260821090*:
--   1. WHO may invite: `members_insert_owner` said the project owner alone. Anyone already
--      on a project may now bring someone in. The rule moves out of a policy and into
--      `invite_project_member()`, because the resolution step needs `security definer`
--      anyway and two authorization surfaces for one act would be one too many.
--   2. WHAT identifies the invitee: it was `profiles.github_username`; it is now the email
--      address the account signed in with.
--
-- Why the lookup cannot live in the client: `auth.users` is unreachable for the
-- `authenticated` role, and mirroring the address into `profiles` would publish every
-- teammate's email to anyone signed in — `profiles_select` is `using (true)` and sign-in is
-- open (20260823120000). So the address is matched inside the database and never returned.
--
-- Invites are for people who already USE Kermanych: the join against `profiles` is that
-- requirement expressed in SQL, since only `handle_new_user()` writes that row, and only on
-- a real sign-in. There is no pending-invitation state anywhere in this schema.
create or replace function public.invite_project_member(p_project_id uuid, p_email text)
returns public.project_members
language plpgsql
security definer
set search_path = public
as $$
declare
  norm text := lower(nullif(trim(p_email), ''));
  target uuid;
  membership public.project_members;
begin
  if norm is null then
    raise exception 'email is required';
  end if;

  -- THE authorization check. `security definer` means RLS does not apply inside this
  -- function, so this line is the whole gate, not a hint: only someone already on the
  -- project may invite. It also covers the owner, who is always a member (handle_new_project).
  if not public.is_project_member(p_project_id, auth.uid()) then
    raise exception 'only a project member can invite';
  end if;

  -- `auth.users.email` is stored lower-cased, but compare case-insensitively anyway: the
  -- column is plain text, and a teammate typing an address from memory may capitalise it.
  select u.id into target
    from auth.users u
    join public.profiles pr on pr.id = u.id
   where lower(u.email) = norm
   limit 1;

  if target is null then
    raise exception 'no Kermanych account for % — ask them to sign in with GitHub first', norm;
  end if;

  -- Always 'member'. 'owner' exists once per project and only handle_new_project() writes it.
  insert into public.project_members (project_id, user_id, role)
  values (p_project_id, target, 'member')
  on conflict (project_id, user_id) do nothing
  returning * into membership;

  -- DO NOTHING returns no row, so an invite for someone already on the project lands here.
  -- Re-inviting is a no-op that reports the existing membership rather than an error: two
  -- people inviting the same teammate is normal, not a conflict to surface.
  if membership is null then
    select * into membership
      from public.project_members
     where project_id = p_project_id and user_id = target;
  end if;

  return membership;
end;
$$;

comment on function public.invite_project_member(uuid, text) is
  'Adds the holder of an email address to a project as ''member''. Callable by any member of that project. Refuses an address with no Kermanych account; never returns the address or any other user''s email.';

revoke all on function public.invite_project_member(uuid, text) from public, anon;
grant execute on function public.invite_project_member(uuid, text) to authenticated;

-- With the rpc in place, direct writes have no remaining use, and dropping the policy
-- removes the only path by which a client could hand-write a membership row — with a
-- `user_id` that never agreed to join, or `role = 'owner'`. `project_members` now has NO
-- insert policy at all: the two writers left are this function and handle_new_project(),
-- both `security definer` and both owned by the table owner, which RLS does not police.
drop policy members_insert_owner on public.project_members;
