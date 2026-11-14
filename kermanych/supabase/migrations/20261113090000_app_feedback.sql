-- Feedback from the people who use the app (docs/specs/2026-11-13-feedback-form.md).
--
-- One row per report sent from «Надіслати відгук». A signed-in user may only INSERT, and only
-- as themselves. Nobody reads the table from a client: the maintainers read it in the Supabase
-- dashboard (Table Editor, or SQL joined with public.profiles for the GitHub name).
--
-- Screenshots live in the private bucket `feedback-images`, under `{user_id}/{uuid}-{name}`;
-- the row carries the object paths only, like tasks.image_paths.
--
-- Additive only: no older client reads any of this.

create table public.app_feedback (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null default auth.uid() references public.profiles(id) on delete cascade,
  kind         text not null check (kind in ('bug', 'idea', 'other')),
  message      text not null check (char_length(btrim(message)) between 1 and 5000),
  image_paths  text[] not null default '{}' check (cardinality(image_paths) <= 3),
  -- The context the form adds by itself, so a report can be reproduced: the app version, the
  -- build (desktop or web), the user agent (OS, Electron version), the UI language and the name of
  -- the screen it was sent from (a route name, never its parameters).
  app_version  text check (char_length(app_version) <= 40),
  client       text check (client in ('desktop', 'web')),
  user_agent   text check (char_length(user_agent) <= 500),
  locale       text check (char_length(locale) <= 10),
  screen       text check (char_length(screen) <= 100),
  created_at   timestamptz not null default now()
);

comment on table public.app_feedback is
  'Reports sent from «Надіслати відгук» (docs/specs/2026-11-13-feedback-form.md): insert-only for the author, read in the dashboard.';

create index app_feedback_user_created on public.app_feedback (user_id, created_at desc);
create index app_feedback_created on public.app_feedback (created_at desc);

alter table public.app_feedback enable row level security;

-- Supabase's default privileges grant new public tables to anon and authenticated in full;
-- narrow them to one INSERT by a signed-in user. service_role reads, for a maintainer's
-- server-side tool (a script or an Edge Function with the secret key); no client holds that key.
revoke all on table public.app_feedback from anon, authenticated;
grant insert on table public.app_feedback to authenticated;
grant select on table public.app_feedback to service_role;

create policy app_feedback_insert_own on public.app_feedback for insert to authenticated
  with check (user_id = auth.uid());

-- ── 10 reports per user per hour ──────────────────────────────────────────────
-- Sign-in is open, so the table needs a bound. The trigger also stamps created_at itself: a
-- client-supplied timestamp would otherwise move a row out of the counted hour. security definer:
-- the author cannot SELECT the table, and the count must see their rows.
create or replace function public.app_feedback_rate_limit()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  new.created_at := now();
  if (
    select count(*) from public.app_feedback
    where user_id = new.user_id and created_at > now() - interval '1 hour'
  ) >= 10 then
    raise exception 'feedback_rate_limited' using errcode = 'P0001';
  end if;
  return new;
end;
$$;

revoke all on function public.app_feedback_rate_limit() from public, anon, authenticated;

create trigger app_feedback_rate_limit
  before insert on public.app_feedback
  for each row execute function public.app_feedback_rate_limit();

-- ── screenshots ───────────────────────────────────────────────────────────────
-- Private. 10 MiB per object and the image types the form accepts, enforced by Storage itself.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'feedback-images',
  'feedback-images',
  false,
  10485760,
  array['image/png','image/jpeg','image/gif','image/webp'])
on conflict (id) do nothing;

-- Own folder only. Select and delete exist so the client can remove its own uploads when a send
-- fails half-way (Storage's remove needs both); nobody reads another user's folder.
create policy feedback_images_insert_own on storage.objects
  for insert to authenticated
  with check (bucket_id = 'feedback-images' and (storage.foldername(name))[1] = auth.uid()::text);

create policy feedback_images_select_own on storage.objects
  for select to authenticated
  using (bucket_id = 'feedback-images' and (storage.foldername(name))[1] = auth.uid()::text);

create policy feedback_images_delete_own on storage.objects
  for delete to authenticated
  using (bucket_id = 'feedback-images' and (storage.foldername(name))[1] = auth.uid()::text);
