-- Workspace password vault, second pass: extra fields, a 2FA marker, and "who holds it".
--
-- Three additions to 20260907120000_workspace_passwords.sql, all forward-only:
--
--   1. Additional fields. A credential is rarely one string: a username beside the password,
--      a recovery code, a region, a note on how to rotate it. Each field is a label, a value
--      and a `secret` flag — a secret value is masked on screen, a descriptive one is not.
--   2. A 2FA marker. `requires_two_factor` says the credential alone will not sign anyone
--      in, and `two_factor_owner` is free text naming who holds the second factor ("Olena's
--      phone", "the ops YubiKey") so a reader knows whom to ask for the code.
--   3. `list_password_holders`, the per-password list of people who may read the secret —
--      the table's "access" column with its avatars.
--
-- (1) and (2) live on `workspace_password_secrets`, NOT on the title table, for the reason
-- the original header gives: everything except the title is "inside the password". A field
-- may itself be a password, and who owns the 2FA device says who to phish — neither is
-- something a developer without an approved grant should read. RLS on that table already
-- enforces exactly that, so the new columns inherit it with no policy change.

-- ── 1 + 2. the new secret-side columns ────────────────────────────────────────
-- Shape check for `fields`: a JSON array of objects, each with a non-blank string `label`,
-- a string `value` (empty allowed, like `secret`) and a boolean `secret`. Immutable so it can
-- back a CHECK constraint (which cannot hold a subquery directly). The CASE guards
-- jsonb_array_elements, which RAISES on a non-array rather than returning false.
create or replace function public.workspace_password_fields_valid(f jsonb)
returns boolean
language sql
immutable
set search_path = public
as $$
  select case
    when jsonb_typeof(f) is distinct from 'array' then false
    else not exists (
      select 1 from jsonb_array_elements(f) e
      where jsonb_typeof(e) <> 'object'
         or jsonb_typeof(e -> 'label')  is distinct from 'string'
         or length(btrim(e ->> 'label')) = 0
         or jsonb_typeof(e -> 'value')  is distinct from 'string'
         or jsonb_typeof(e -> 'secret') is distinct from 'boolean')
  end;
$$;

alter table public.workspace_password_secrets
  add column fields jsonb not null default '[]'::jsonb,
  add column requires_two_factor boolean not null default false,
  add column two_factor_owner text,
  add constraint workspace_password_secrets_fields_check
    check (public.workspace_password_fields_valid(fields)),
  -- An owner without the flag is a stale leftover of an unticked box; refuse it so the
  -- screen never shows "2FA held by X" on a credential that no longer needs 2FA.
  add constraint workspace_password_secrets_two_factor_check
    check (requires_two_factor or two_factor_owner is null);

comment on column public.workspace_password_secrets.fields is
  'Additional fields: [{label, value, secret}]. `secret` = mask the value on screen. Same readers as the secret itself.';
comment on column public.workspace_password_secrets.requires_two_factor is
  'The credential needs a second factor to sign in.';
comment on column public.workspace_password_secrets.two_factor_owner is
  'Free text naming who holds the second factor. Only set when requires_two_factor.';

-- ── 3. who may read each password ─────────────────────────────────────────────
-- The access column on the vault table is shown to EVERY member, developers included, but a
-- developer's RLS on workspace_password_access only returns their own rows — so the count
-- cannot be computed client-side. This security-definer rpc answers it server-side, and
-- answers it the way can_read_password_secret decides it (the owner, every seated manager,
-- and every approved requester), so the number on screen is the number Postgres enforces.
--
-- It returns WHO, never WHAT: password ids the caller can already list, and the public
-- profile fields (handle, name, avatar) the members panel already shows. Profile fields ride
-- along because an approved requester may have since left the workspace — their grant still
-- reads, so they still count, and the roster alone could not draw their face.
--
-- One row per (password, person). Ordered owner → managers → approved grants (oldest
-- decision first), so the first four faces the table draws are stable between reads.
-- A non-member gets an empty set, the same "refused read is empty" shape as RLS.
create or replace function public.list_password_holders(p_workspace_id uuid)
returns table (
  password_id uuid,
  user_id uuid,
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
  -- their strongest seat.
  best as (
    select distinct on (h.password_id, h.user_id) h.password_id, h.user_id, h.rank, h.since
      from holders h
     order by h.password_id, h.user_id, h.rank
  )
  select b.password_id, b.user_id, pr.github_username, pr.display_name, pr.avatar_url
    from best b
    left join public.profiles pr on pr.id = b.user_id
   where public.is_workspace_member(p_workspace_id, auth.uid())
   order by b.password_id, b.rank, b.since nulls first, b.user_id;
$$;

comment on function public.list_password_holders(uuid) is
  'Per password in the workspace, every person who may read its secret (owner, managers, approved requesters) with their public profile fields. Workspace-member-only; empty for anyone else. Never returns secret content.';

revoke all on function public.list_password_holders(uuid) from public, anon;
grant execute on function public.list_password_holders(uuid) to authenticated;
