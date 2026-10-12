-- The oldest desktop app version this cloud still serves
-- (docs/specs/2026-10-12-desktop-releases-and-updates.md, decision 8).
--
-- Every installed app reads this one row at launch and with every update check; a packaged app
-- older than `min_app_version` shows a blocking «update» screen. Additive only.
--
-- THE RULE: a migration that breaks older clients (renames or drops a table or column they
-- read, tightens a policy they rely on) raises the minimum IN THE SAME FILE, to the first
-- release that works with the new schema:
--
--   update public.app_release_policy set min_app_version = '0.4.0', updated_at = now();
--
-- Readable without signing in: the gate must also stop an old app on the sign-in screen.
-- Nobody writes it from a client; it changes only through migrations.

create table public.app_release_policy (
  -- One row, enforced: the primary key can only ever be `true`.
  id               boolean primary key default true check (id),
  min_app_version  text not null check (min_app_version ~ '^[0-9]+\.[0-9]+\.[0-9]+$'),
  updated_at       timestamptz not null default now()
);

insert into public.app_release_policy (min_app_version) values ('0.0.0');

alter table public.app_release_policy enable row level security;

-- Supabase's default privileges grant new public tables to anon and authenticated in full;
-- narrow both to SELECT.
revoke all on table public.app_release_policy from anon, authenticated;
grant select on table public.app_release_policy to anon, authenticated;

create policy app_release_policy_select_all on public.app_release_policy
  for select to anon, authenticated using (true);
