-- Kermanych workspace password vault — the "Storage" management section, made real.
--
-- A workspace keeps shared credentials: a database password, an API key, a service
-- account, sometimes with a key FILE beside it. Three roles, three different sights of the
-- same vault — and this is the FIRST feature in the schema where the role column carries
-- authorization weight rather than being a label (20260901100000_workspace_member_roles.sql
-- said roles "carry NO authorization weight yet"; the vault is the "yet" ending):
--
--   * owner (workspaces.owner_id) and manager (workspace_members.role = 'manager')
--     — create, edit, delete a password, and read its secret and file. They also decide
--     access requests.
--   * developer (any other member) — sees every password's TITLE, so the team knows which
--     credentials exist, but never a secret or a file until a manager approves a request.
--     A developer never edits or deletes.
--
-- The hard part is "sees the title, not the secret". RLS is ROW-level, not column-level: a
-- developer permitted to read a password row would read every column of it. So the secret
-- and the file path live in a SEPARATE table (workspace_password_secrets) whose read policy
-- is stricter than the title table's. Splitting the row is the only way one person can be
-- allowed the title and refused the secret.
--
-- Forward-only, like every migration here (scripts/verify-workspace-migration.ts pushes this
-- append-only log to the linked hosted project).

-- ── the vault's authority predicate ───────────────────────────────────────────
-- "May u administer this workspace's vault?" — the owner, or a member seated 'manager'.
-- security definer + stable, the same shape as is_workspace_member, so a policy that calls
-- it never recurses into the table it protects, and the planner calls it once per statement.
create or replace function public.can_manage_workspace_passwords(w uuid, u uuid)
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select exists (
    select 1 from public.workspaces ws
    where ws.id = w and ws.owner_id = u)
  or exists (
    select 1 from public.workspace_members m
    where m.workspace_id = w and m.user_id = u and m.role = 'manager');
$$;

-- ── 1. the title table: what every member may see ─────────────────────────────
-- Metadata only. `title` is deliberately the WHOLE of it — no username, url or note lives
-- here, because everything except the title is "inside the password" the developer must not
-- read. `created_by`/`updated_by` are `on delete set null` so a password outlives the
-- account that filed it, exactly like tasks.created_by.
create table public.workspace_passwords (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  title text not null,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_by uuid references public.profiles(id) on delete set null,
  updated_at timestamptz not null default now(),
  constraint workspace_passwords_title_check check (length(btrim(title)) > 0));

create index workspace_passwords_workspace_idx on public.workspace_passwords (workspace_id);

-- ── 2. the secret table: what a title-reader still may not see ─────────────────
-- 1:1 with a password (password_id is the primary key AND the foreign key), and split out
-- for the row-vs-column reason in the header. `secret` may be an empty string — a
-- file-only credential (a .pem, a service-account json) is a real case — but the row must
-- exist, so a password always has exactly one secret record. `file_path` is the object path
-- in the private `password-files` bucket (never a URL; the screen mints a signed URL on
-- demand), `file_name` the original name for the download affordance.
create table public.workspace_password_secrets (
  password_id uuid primary key references public.workspace_passwords(id) on delete cascade,
  secret text not null default '',
  file_path text,
  file_name text,
  updated_by uuid references public.profiles(id) on delete set null,
  updated_at timestamptz not null default now());

-- ── 3. the access ledger: request -> approve/decline ──────────────────────────
-- One row per (password, requester). `workspace_id` is denormalized here — unlike the
-- secret table — because the manager's screen lists "every pending request in this
-- workspace" and a member's screen reads "my request state for these passwords", both
-- filtered by workspace; the rpcs are the only writers, so it cannot drift. `decided_by`
-- is `on delete set null` (the decision outlives the decider); the requester cascades
-- (their rows go with the account).
create table public.workspace_password_access (
  id uuid primary key default gen_random_uuid(),
  password_id uuid not null references public.workspace_passwords(id) on delete cascade,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  requester_id uuid not null references public.profiles(id) on delete cascade,
  status text not null default 'pending'
    check (status in ('pending','approved','declined')),
  requested_at timestamptz not null default now(),
  decided_by uuid references public.profiles(id) on delete set null,
  decided_at timestamptz,
  unique (password_id, requester_id));

create index workspace_password_access_workspace_idx on public.workspace_password_access (workspace_id);
create index workspace_password_access_requester_idx on public.workspace_password_access (requester_id);

-- "May u read THIS password's secret?" — a manager/owner of its workspace, or a developer
-- holding an approved grant for exactly this password. Keyed by password_id so both the
-- secret table's read policy and the storage bucket's read policy ask the one question the
-- same way. Nested security-definer calls are fine.
create or replace function public.can_read_password_secret(p_password_id uuid, u uuid)
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select exists (
    select 1 from public.workspace_passwords p
    where p.id = p_password_id
      and public.can_manage_workspace_passwords(p.workspace_id, u))
  or exists (
    select 1 from public.workspace_password_access a
    where a.password_id = p_password_id
      and a.requester_id = u
      and a.status = 'approved');
$$;

-- "May u WRITE this password's secret/file?" — manager/owner only, resolved through the
-- password's workspace so the secret table needs no denormalized workspace_id to keep in
-- sync. Used by the secret write policies and the storage insert/delete policies.
create or replace function public.can_manage_password(p_password_id uuid, u uuid)
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select exists (
    select 1 from public.workspace_passwords p
    where p.id = p_password_id
      and public.can_manage_workspace_passwords(p.workspace_id, u));
$$;

-- ── 4. server-owned authorship, so a client cannot forge it ───────────────────
-- Same shape as workspace_risks_touch(): stamp created_by/updated_by from auth.uid() and the
-- timestamps from now(), and make id/workspace/creation immutable after insert. A client
-- that sends these keys anyway is ignored, so a full-row update from the editor does not
-- need to know they exist.
create or replace function public.workspace_passwords_touch() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    new.created_by := auth.uid();
    new.created_at := now();
  else
    new.created_by := old.created_by;
    new.created_at := old.created_at;
    new.workspace_id := old.workspace_id;
  end if;
  new.updated_by := auth.uid();
  new.updated_at := now();
  return new;
end;
$$;

create trigger workspace_passwords_touch
  before insert or update on public.workspace_passwords
  for each row execute function public.workspace_passwords_touch();

create or replace function public.workspace_password_secrets_touch() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'UPDATE' then new.password_id := old.password_id; end if;
  new.updated_by := auth.uid();
  new.updated_at := now();
  return new;
end;
$$;

create trigger workspace_password_secrets_touch
  before insert or update on public.workspace_password_secrets
  for each row execute function public.workspace_password_secrets_touch();

-- ── 5. the two access rpcs: the ONLY writers of the ledger ────────────────────
-- The ledger has no INSERT/UPDATE grant (below), so these `security definer` rpcs are the
-- sole way a row is created or decided — which is what stops a developer forging a row with
-- status='approved'.

-- A member asks to see one password. Idempotent and re-requestable: a fresh ask after a
-- decline resets the row to 'pending' and clears the prior decision, so a declined developer
-- is not locked out forever. Managers/owners have no reason to call it (they can already read
-- every secret), but it is harmless if they do.
create or replace function public.request_password_access(p_password_id uuid)
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
  if not public.is_workspace_member(ws, auth.uid()) then
    raise exception 'only a workspace member can request access';
  end if;

  insert into public.workspace_password_access
    (password_id, workspace_id, requester_id, status)
  values (p_password_id, ws, auth.uid(), 'pending')
  on conflict (password_id, requester_id) do update
    set status = 'pending', requested_at = now(), decided_by = null, decided_at = null
  returning * into req;

  return req;
end;
$$;

comment on function public.request_password_access(uuid) is
  'Files (or re-files) a pending access request for one password on behalf of the caller. Workspace-member-only. Idempotent; a fresh call after a decline resets the row to pending. The only INSERT path into workspace_password_access.';

-- Approve or decline a request. Manager/owner-only, enforced here because the ledger has no
-- UPDATE grant. Stamps the decider and the moment so the requester's screen can show who
-- answered and when. A no-match update would otherwise succeed with zero rows, so the final
-- guard turns "no such request" into a legible error.
create or replace function public.decide_password_access(p_request_id uuid, p_approve boolean)
returns public.workspace_password_access
language plpgsql
security definer
set search_path = public
as $$
declare
  req public.workspace_password_access;
begin
  select * into req from public.workspace_password_access where id = p_request_id;
  if req.id is null then raise exception 'no such access request'; end if;
  if not public.can_manage_workspace_passwords(req.workspace_id, auth.uid()) then
    raise exception 'only a workspace owner or manager can decide access';
  end if;

  update public.workspace_password_access
     set status = case when p_approve then 'approved' else 'declined' end,
         decided_by = auth.uid(),
         decided_at = now()
   where id = p_request_id
  returning * into req;

  return req;
end;
$$;

comment on function public.decide_password_access(uuid, boolean) is
  'Approves (true) or declines (false) a pending access request. Owner/manager of the request''s workspace only. The only UPDATE path into workspace_password_access.';

-- ── 6. RLS and grants ─────────────────────────────────────────────────────────
alter table public.workspace_passwords        enable row level security;
alter table public.workspace_password_secrets enable row level security;
alter table public.workspace_password_access  enable row level security;

-- Defensive, like the workspaces migration: nothing to anon even if a future config flips
-- auto_expose_new_tables back on.
revoke all on table public.workspace_passwords        from anon;
revoke all on table public.workspace_password_secrets from anon;
revoke all on table public.workspace_password_access  from anon;

grant select, insert, update, delete on table public.workspace_passwords        to authenticated;
grant select, insert, update, delete on table public.workspace_password_secrets to authenticated;
-- The ledger gets SELECT only: its two writers are `security definer` rpcs, and a missing
-- grant denies one layer earlier than a missing policy would — the same no-forgery shape
-- workspace_members uses for its role column.
grant select                          on table public.workspace_password_access  to authenticated;

-- Titles: every member reads; only a manager/owner writes.
create policy workspace_passwords_select_member on public.workspace_passwords
  for select to authenticated
  using (public.is_workspace_member(workspace_id, auth.uid()));

create policy workspace_passwords_insert_manager on public.workspace_passwords
  for insert to authenticated
  with check (public.can_manage_workspace_passwords(workspace_id, auth.uid()));

create policy workspace_passwords_update_manager on public.workspace_passwords
  for update to authenticated
  using      (public.can_manage_workspace_passwords(workspace_id, auth.uid()))
  with check (public.can_manage_workspace_passwords(workspace_id, auth.uid()));

create policy workspace_passwords_delete_manager on public.workspace_passwords
  for delete to authenticated
  using (public.can_manage_workspace_passwords(workspace_id, auth.uid()));

-- Secrets: read is the vault's whole point — manager/owner, or an approved developer.
-- Writes are manager/owner only. INSERT ... RETURNING re-checks SELECT on the new row, and
-- can_read_password_secret is true for a manager through its manage branch, so the editor's
-- insert returns its row.
create policy workspace_password_secrets_select_reader on public.workspace_password_secrets
  for select to authenticated
  using (public.can_read_password_secret(password_id, auth.uid()));

create policy workspace_password_secrets_insert_manager on public.workspace_password_secrets
  for insert to authenticated
  with check (public.can_manage_password(password_id, auth.uid()));

create policy workspace_password_secrets_update_manager on public.workspace_password_secrets
  for update to authenticated
  using      (public.can_manage_password(password_id, auth.uid()))
  with check (public.can_manage_password(password_id, auth.uid()));

create policy workspace_password_secrets_delete_manager on public.workspace_password_secrets
  for delete to authenticated
  using (public.can_manage_password(password_id, auth.uid()));

-- Ledger: a member sees their OWN requests (so the screen can show pending/approved/declined
-- and toggle the button), a manager/owner sees every request in the workspace. No write
-- policy: the rpcs are the only writers.
create policy workspace_password_access_select on public.workspace_password_access
  for select to authenticated
  using (
    requester_id = auth.uid()
    or public.can_manage_workspace_passwords(workspace_id, auth.uid()));

-- ── 7. rpc grants ─────────────────────────────────────────────────────────────
revoke all on function public.request_password_access(uuid)         from public, anon;
revoke all on function public.decide_password_access(uuid, boolean) from public, anon;
grant execute on function public.request_password_access(uuid)         to authenticated;
grant execute on function public.decide_password_access(uuid, boolean) to authenticated;

-- ── 8. the file bucket ────────────────────────────────────────────────────────
-- Private, 10 MiB, ANY mime type: a credential file is a .pem, a .json, a .p12 or a .txt —
-- there is no useful allow-list. Object paths are `{password_id}/{uuid}-{filename}`, so the
-- first folder segment IS the password, which is what the policies below check the same
-- way task-images checks its project.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('password-files', 'password-files', false, 10485760, null)
on conflict (id) do nothing;

-- Reading the file is exactly as restricted as reading the secret — same predicate, keyed on
-- the password id in the path. Writing/removing it is manager/owner only. The upload happens
-- AFTER the password row exists (the cloud client creates the row, then uploads under its
-- id), so can_manage_password resolves.
create policy password_files_select_reader on storage.objects
  for select to authenticated
  using (
    bucket_id = 'password-files'
    and public.can_read_password_secret(((storage.foldername(name))[1])::uuid, auth.uid()));

create policy password_files_insert_manager on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'password-files'
    and public.can_manage_password(((storage.foldername(name))[1])::uuid, auth.uid()));

create policy password_files_delete_manager on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'password-files'
    and public.can_manage_password(((storage.foldername(name))[1])::uuid, auth.uid()));
