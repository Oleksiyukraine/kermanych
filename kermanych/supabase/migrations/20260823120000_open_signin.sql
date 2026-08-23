-- Open sign-in. Supersedes the allowed_github_users gate from
-- 20260821090100_team_cloud_functions.sql: any GitHub account may now create an
-- account. Data stays isolated per project by RLS (a new user sees only projects
-- they own or are added to as a member — see 20260821090200_team_cloud_rls.sql);
-- the removed gate only decided WHO could hold an authenticated JWT at all.
--
-- Trade-off accepted deliberately: the repository is public, so with no gate any
-- GitHub account can create a user on this backend and consume its quota. RLS,
-- not the allowlist, is now the sole authorization surface.

-- Redefine WITHOUT the allowlist check; keep the profile provisioning verbatim.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  handle text := nullif(trim(new.raw_user_meta_data ->> 'user_name'), '');
begin
  insert into public.profiles (id, github_username, display_name, avatar_url)
  values (
    new.id,
    handle,
    new.raw_user_meta_data ->> 'full_name',
    new.raw_user_meta_data ->> 'avatar_url')
  on conflict (id) do nothing;
  return new;
end;
$$;

-- The gate table is now unread by anything; drop it (function above no longer references it).
drop table if exists public.allowed_github_users;
