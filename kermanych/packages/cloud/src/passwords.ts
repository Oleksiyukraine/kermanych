// Data access for the workspace password vault (the "Storage" section). Owns the snake_case
// <-> camelCase boundary for `workspace_passwords`, `workspace_password_secrets` and
// `workspace_password_access`, plus the `password-files` Storage bucket. Every call runs
// under the caller's JWT, so the RLS policies and the rpcs in
// 20260907120000_workspace_passwords.sql, 20260928090000_workspace_password_fields.sql and
// 20260928100000_workspace_password_share.sql —
// not this code — are the authorization surface; refusals surface as thrown postgrest
// messages, or (for a read a developer is not entitled to) as an empty result the caller
// reads as "not permitted".
//
// The title/secret split is the whole design: `listWorkspacePasswords` is readable by every
// member and returns titles; `getPasswordSecret` returns a row ONLY when the caller may read
// it, so a developer without an approved grant gets `null` rather than a leaked secret. The
// additional fields and the 2FA marker live on the secret row, so they share its readers.
import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  PasswordHolder,
  WorkspacePassword,
  WorkspacePasswordAccess,
  WorkspacePasswordField,
  WorkspacePasswordInsert,
  WorkspacePasswordPatch,
  WorkspacePasswordSecret,
  WorkspacePasswordSecretPatch,
} from "./types";

// One string literal, not a concatenation: postgrest-js parses this at the TYPE level, and a
// `+`-joined value degrades to GenericStringError.
const PASSWORD_COLUMNS = "id, workspace_id, title, created_by, created_at, updated_by, updated_at";
const SECRET_COLUMNS =
  "password_id, secret, fields, requires_two_factor, two_factor_owner, file_path, file_name, updated_by, updated_at";
const ACCESS_COLUMNS =
  "id, password_id, workspace_id, requester_id, status, requested_at, decided_by, decided_at";

export const PASSWORD_FILE_BUCKET = "password-files";

type PasswordRow = {
  id: string;
  workspace_id: string;
  title: string;
  created_by: string | null;
  created_at: string;
  updated_by: string | null;
  updated_at: string;
};

type SecretRow = {
  password_id: string;
  secret: string;
  fields: WorkspacePasswordField[];
  requires_two_factor: boolean;
  two_factor_owner: string | null;
  file_path: string | null;
  file_name: string | null;
  updated_by: string | null;
  updated_at: string;
};

type HolderRow = {
  password_id: string;
  user_id: string;
  github_username: string | null;
  display_name: string | null;
  avatar_url: string | null;
};

type AccessRow = {
  id: string;
  password_id: string;
  workspace_id: string;
  requester_id: string;
  status: "pending" | "approved" | "declined";
  requested_at: string;
  decided_by: string | null;
  decided_at: string | null;
};

export function toWorkspacePassword(row: PasswordRow): WorkspacePassword {
  const p: WorkspacePassword = {
    id: row.id,
    workspaceId: row.workspace_id,
    title: row.title,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
  if (row.created_by) p.createdBy = row.created_by;
  if (row.updated_by) p.updatedBy = row.updated_by;
  return p;
}

export function toWorkspacePasswordSecret(row: SecretRow): WorkspacePasswordSecret {
  const s: WorkspacePasswordSecret = {
    passwordId: row.password_id,
    secret: row.secret,
    fields: row.fields ?? [],
    requiresTwoFactor: row.requires_two_factor,
    updatedAt: row.updated_at,
  };
  if (row.two_factor_owner) s.twoFactorOwner = row.two_factor_owner;
  if (row.file_path) s.filePath = row.file_path;
  if (row.file_name) s.fileName = row.file_name;
  if (row.updated_by) s.updatedBy = row.updated_by;
  return s;
}

export function toWorkspacePasswordAccess(row: AccessRow): WorkspacePasswordAccess {
  const a: WorkspacePasswordAccess = {
    id: row.id,
    passwordId: row.password_id,
    workspaceId: row.workspace_id,
    requesterId: row.requester_id,
    status: row.status,
    requestedAt: row.requested_at,
  };
  if (row.decided_by) a.decidedBy = row.decided_by;
  if (row.decided_at) a.decidedAt = row.decided_at;
  return a;
}

export function toPasswordHolder(row: HolderRow): PasswordHolder {
  const h: PasswordHolder = { passwordId: row.password_id, userId: row.user_id };
  if (row.github_username) h.githubUsername = row.github_username;
  if (row.display_name) h.displayName = row.display_name;
  if (row.avatar_url) h.avatarUrl = row.avatar_url;
  return h;
}

// The owner column is meaningful only with the flag; Postgres refuses an owner without it,
// so it is dropped here rather than surfacing as a constraint error. A blank owner is null.
function twoFactorOwnerColumn(requiresTwoFactor: boolean, owner: string | null | undefined): string | null {
  const trimmed = owner?.trim();
  return requiresTwoFactor && trimmed ? trimmed : null;
}

// Slug a filename down to what a storage key tolerates — the extension survives, spaces and
// other characters cannot break the `{password_id}/…` path the RLS policy parses. Same rule
// as tasks.ts's safeName; a blank falls back to a neutral stem rather than an empty segment.
function safeName(name: string): string {
  const cleaned = name.replace(/[^a-zA-Z0-9._-]/g, "-").replace(/-+/g, "-");
  return cleaned.replace(/^[.-]+/, "") || "file";
}

// Titles for one workspace, every member's view. Ordered by title so the list is scannable
// and stable between reads; the id tiebreak keeps two identically-titled rows in a fixed order.
export async function listWorkspacePasswords(
  client: SupabaseClient,
  workspaceId: string,
): Promise<WorkspacePassword[]> {
  const { data, error } = await client
    .from("workspace_passwords")
    .select(PASSWORD_COLUMNS)
    .eq("workspace_id", workspaceId)
    .order("title", { ascending: true })
    .order("id", { ascending: true });
  if (error) throw new Error(error.message);
  return (data as PasswordRow[]).map(toWorkspacePassword);
}

// The secret behind one password, or `null` when the caller may not read it. The RLS policy
// on `workspace_password_secrets` returns zero rows to a developer without an approved grant,
// which `maybeSingle` reports as `{ data: null }` — NOT an error. That null IS the "no access
// yet" state the screen renders as the locked card with a Request-access button.
export async function getPasswordSecret(
  client: SupabaseClient,
  passwordId: string,
): Promise<WorkspacePasswordSecret | null> {
  const { data, error } = await client
    .from("workspace_password_secrets")
    .select(SECRET_COLUMNS)
    .eq("password_id", passwordId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data ? toWorkspacePasswordSecret(data as SecretRow) : null;
}

// Create a password: the title row first (so its id exists for the file path and the secret
// FK), then the optional file, then the secret row. Manager/owner only, by RLS — a developer's
// insert is refused on the title row and nothing else runs. On any later failure the title row
// and any uploaded object are removed, so a half-created password never lingers.
export async function createWorkspacePassword(
  client: SupabaseClient,
  input: WorkspacePasswordInsert,
  file?: File | null,
): Promise<{ password: WorkspacePassword; secret: WorkspacePasswordSecret }> {
  const titleRes = await client
    .from("workspace_passwords")
    .insert({ workspace_id: input.workspaceId, title: input.title })
    .select(PASSWORD_COLUMNS)
    .single();
  if (titleRes.error) throw new Error(titleRes.error.message);
  const password = toWorkspacePassword(titleRes.data as PasswordRow);

  let filePath: string | null = null;
  try {
    if (file) filePath = await uploadPasswordFile(client, password.id, file);
    const secretRes = await client
      .from("workspace_password_secrets")
      .insert({
        password_id: password.id,
        secret: input.secret,
        fields: input.fields,
        requires_two_factor: input.requiresTwoFactor,
        two_factor_owner: twoFactorOwnerColumn(input.requiresTwoFactor, input.twoFactorOwner),
        file_path: filePath,
        file_name: file ? file.name : null,
      })
      .select(SECRET_COLUMNS)
      .single();
    if (secretRes.error) throw new Error(secretRes.error.message);
    return { password, secret: toWorkspacePasswordSecret(secretRes.data as SecretRow) };
  } catch (e) {
    if (filePath) await client.storage.from(PASSWORD_FILE_BUCKET).remove([filePath]).catch(() => {});
    await client.from("workspace_passwords").delete().eq("id", password.id).then(() => {}, () => {});
    throw e;
  }
}

// Rename. Touches ONLY the title row; the secret is left exactly as it was. `updated_by`/
// `updated_at` are server-stamped by the trigger, so they are not sent.
export async function patchWorkspacePassword(
  client: SupabaseClient,
  id: string,
  patch: WorkspacePasswordPatch,
): Promise<WorkspacePassword> {
  const { data, error } = await client
    .from("workspace_passwords")
    .update({ title: patch.title })
    .eq("id", id)
    .select(PASSWORD_COLUMNS)
    .single();
  if (error) throw new Error(error.message);
  return toWorkspacePassword(data as PasswordRow);
}

// Change what is inside the password — the secret text, the additional fields, the 2FA
// marker. Separate from the rename because the two rows have different readers, and an
// editor that changed the title should not have to resend the secret. Only the keys present
// in `patch` are written, so two managers editing different parts do not clobber each other.
export async function patchPasswordSecret(
  client: SupabaseClient,
  passwordId: string,
  patch: WorkspacePasswordSecretPatch,
): Promise<WorkspacePasswordSecret> {
  const row: Record<string, unknown> = {};
  if (patch.secret !== undefined) row.secret = patch.secret;
  if (patch.fields !== undefined) row.fields = patch.fields;
  if (patch.requiresTwoFactor !== undefined) row.requires_two_factor = patch.requiresTwoFactor;
  if (patch.twoFactorOwner !== undefined) {
    const owner = patch.twoFactorOwner?.trim();
    row.two_factor_owner = owner ? owner : null;
  }
  // Unticking 2FA always clears the owner: Postgres refuses an owner without the flag.
  if (patch.requiresTwoFactor === false) row.two_factor_owner = null;
  const { data, error } = await client
    .from("workspace_password_secrets")
    .update(row)
    .eq("password_id", passwordId)
    .select(SECRET_COLUMNS)
    .single();
  if (error) throw new Error(error.message);
  return toWorkspacePasswordSecret(data as SecretRow);
}

// Upload one object under `{passwordId}/{uuid}-{name}` and return its path. Private bucket,
// manager/owner only by storage RLS. Not exported: file changes go through
// `setPasswordFile`/`clearPasswordFile`, which also update the secret row that names the path.
async function uploadPasswordFile(client: SupabaseClient, passwordId: string, file: File): Promise<string> {
  const path = `${passwordId}/${crypto.randomUUID()}-${safeName(file.name)}`;
  const { error } = await client.storage
    .from(PASSWORD_FILE_BUCKET)
    .upload(path, file, { contentType: file.type || "application/octet-stream", upsert: false });
  if (error) throw new Error(error.message);
  return path;
}

// Attach or replace the file on an existing password: upload the new object, point the secret
// row at it, then remove the old object. Order matters — the row names the surviving object at
// every step, so a failure never leaves a path with no object behind it.
export async function setPasswordFile(
  client: SupabaseClient,
  passwordId: string,
  file: File,
  previousPath?: string,
): Promise<WorkspacePasswordSecret> {
  const path = await uploadPasswordFile(client, passwordId, file);
  const { data, error } = await client
    .from("workspace_password_secrets")
    .update({ file_path: path, file_name: file.name })
    .eq("password_id", passwordId)
    .select(SECRET_COLUMNS)
    .single();
  if (error) {
    await client.storage.from(PASSWORD_FILE_BUCKET).remove([path]).catch(() => {});
    throw new Error(error.message);
  }
  if (previousPath && previousPath !== path) {
    await client.storage.from(PASSWORD_FILE_BUCKET).remove([previousPath]).catch(() => {});
  }
  return toWorkspacePasswordSecret(data as SecretRow);
}

// Detach the file: clear the columns first (so the row stops naming the object), then remove
// it. A remove that fails leaves an orphan object but a correct row — the safer of the two.
export async function clearPasswordFile(
  client: SupabaseClient,
  passwordId: string,
  filePath: string,
): Promise<WorkspacePasswordSecret> {
  const { data, error } = await client
    .from("workspace_password_secrets")
    .update({ file_path: null, file_name: null })
    .eq("password_id", passwordId)
    .select(SECRET_COLUMNS)
    .single();
  if (error) throw new Error(error.message);
  await client.storage.from(PASSWORD_FILE_BUCKET).remove([filePath]).catch(() => {});
  return toWorkspacePasswordSecret(data as SecretRow);
}

// A short-lived signed URL for a private file, or `null` when it cannot be signed (the object
// is gone, or the caller may not read it). The bucket is private, so this is the only way the
// screen can hand a reader the file the row merely names.
export async function signedPasswordFileUrl(
  client: SupabaseClient,
  filePath: string,
  expiresIn = 300,
): Promise<string | null> {
  const { data, error } = await client.storage
    .from(PASSWORD_FILE_BUCKET)
    .createSignedUrl(filePath, expiresIn);
  if (error) return null;
  return data?.signedUrl ?? null;
}

// Delete a password for good. The secret row and every access row cascade in Postgres; the
// Storage object does NOT (objects carry no foreign key), so it is removed first when the
// caller — who can read the secret, being a manager/owner — knows its path. Manager/owner only
// by RLS; a refused delete matches zero rows WITHOUT an error, so the caller confirms against
// the list it already holds.
export async function deleteWorkspacePassword(
  client: SupabaseClient,
  id: string,
  filePath?: string,
): Promise<void> {
  if (filePath) await client.storage.from(PASSWORD_FILE_BUCKET).remove([filePath]).catch(() => {});
  const { error } = await client.from("workspace_passwords").delete().eq("id", id);
  if (error) throw new Error(error.message);
}

// Every access row the caller may see in one workspace: a developer sees their own, a
// manager/owner sees all of them. The manager's screen groups them by password to show
// pending requests; a developer reads their own status to pick the button state.
export async function listPasswordAccess(
  client: SupabaseClient,
  workspaceId: string,
): Promise<WorkspacePasswordAccess[]> {
  const { data, error } = await client
    .from("workspace_password_access")
    .select(ACCESS_COLUMNS)
    .eq("workspace_id", workspaceId)
    .order("requested_at", { ascending: false });
  if (error) throw new Error(error.message);
  return (data as AccessRow[]).map(toWorkspacePasswordAccess);
}

// File (or re-file) the caller's request for one password. The rpc is the only INSERT path
// into the ledger; it refuses a non-member and resets a prior decline to pending. A refusal
// RAISES here (unlike a silent zero-rows write), so the caller gets a thrown message.
export async function requestPasswordAccess(
  client: SupabaseClient,
  passwordId: string,
): Promise<WorkspacePasswordAccess> {
  const res = await client.rpc("request_password_access", { p_password_id: passwordId });
  if (res.error) throw new Error(res.error.message);
  return toWorkspacePasswordAccess(res.data as AccessRow);
}

// Approve (true) or decline (false) a request. Manager/owner only, enforced inside the rpc —
// the ledger has no UPDATE grant. Returns the decided row so the screen updates in place.
export async function decidePasswordAccess(
  client: SupabaseClient,
  requestId: string,
  approve: boolean,
): Promise<WorkspacePasswordAccess> {
  const res = await client.rpc("decide_password_access", {
    p_request_id: requestId,
    p_approve: approve,
  });
  if (res.error) throw new Error(res.error.message);
  return toWorkspacePasswordAccess(res.data as AccessRow);
}

// Share one password with one workspace member: their ledger row becomes an approved grant
// with no request in between (a pending or declined ask of theirs is turned into it). The
// password's filer, the workspace owner or a manager only, enforced inside the rpc. Returns
// the approved row so the screen updates in place.
export async function sharePassword(
  client: SupabaseClient,
  passwordId: string,
  userId: string,
): Promise<WorkspacePasswordAccess> {
  const res = await client.rpc("share_password", { p_password_id: passwordId, p_user_id: userId });
  if (res.error) throw new Error(res.error.message);
  return toWorkspacePasswordAccess(res.data as AccessRow);
}

// Who may read each password in one workspace: the owner, every seated manager, every
// approved requester — the same answer `can_read_password_secret` gives, computed by a
// security-definer rpc because a developer's own RLS on the ledger shows only their rows.
// Every member may call it; the rows carry people, never secret content. Ordered per
// password owner → managers → grants, so the first faces drawn are stable between reads.
export async function listPasswordHolders(
  client: SupabaseClient,
  workspaceId: string,
): Promise<PasswordHolder[]> {
  const { data, error } = await client.rpc("list_password_holders", { p_workspace_id: workspaceId });
  if (error) throw new Error(error.message);
  return ((data ?? []) as HolderRow[]).map(toPasswordHolder);
}
