-- Kermanych team cloud — task image attachments.
--
-- A task card may carry screenshots or mockups. The IMAGES live in Supabase Storage
-- (execution state never does), and the task row carries only the object PATHS. The
-- bucket is private: the board mints short-lived signed URLs on demand, so a leaked
-- row id never exposes a project's images to a non-member.
--
-- Paths are `{project_id}/{uuid}-{filename}`. The first folder segment IS the project,
-- which is what the storage policies below check membership against — the same
-- `is_project_member` predicate the tasks policies use, so an image is readable by
-- exactly the people who can read the task that names it.

-- Object paths only, never URLs. `not null default '{}'` so a task without images is an
-- empty array, never null — one shape for the mapper and the realtime payload to carry.
alter table public.tasks
  add column image_paths text[] not null default '{}';

-- Private bucket. 10 MiB per object and image mime types only, enforced by Storage
-- itself so a bad upload is refused before it ever reaches a task row.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'task-images',
  'task-images',
  false,
  10485760,
  array['image/png','image/jpeg','image/gif','image/webp','image/svg+xml'])
on conflict (id) do nothing;

-- storage.objects already has RLS enabled by Supabase; these policies are scoped to the
-- one bucket. The cast is safe because insert (below) is the only way an object lands in
-- this bucket, and it enforces the same well-formed `{project_id}/…` shape.
create policy task_images_select_member on storage.objects
  for select to authenticated
  using (
    bucket_id = 'task-images'
    and public.is_project_member(((storage.foldername(name))[1])::uuid, auth.uid()));

create policy task_images_insert_member on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'task-images'
    and public.is_project_member(((storage.foldername(name))[1])::uuid, auth.uid()));

create policy task_images_delete_member on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'task-images'
    and public.is_project_member(((storage.foldername(name))[1])::uuid, auth.uid()));
