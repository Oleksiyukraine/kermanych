// Cloud workspaces + membership. A workspace is the group that owns projects AND
// carries the team: `workspace_members` is the single membership surface, so one
// invitation opens every project in the group. Same shape as projects.ts — this file
// owns the snake_case <-> camelCase boundary and every call runs under the caller's
// JWT, so RLS is the authorization surface and refusals arrive as thrown messages.
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Profile, Workspace, WorkspaceMember } from "./types";

const WORKSPACE_COLUMNS = "id, name, color, owner_id, created_at";
const PROFILE_COLUMNS = "id, github_username, display_name, avatar_url";
const MEMBER_COLUMNS = `workspace_id, user_id, role, added_at, profiles(${PROFILE_COLUMNS})`;

type WorkspaceRow = {
  id: string;
  name: string;
  color: string | null;
  owner_id: string;
  created_at: string;
};

type ProfileRow = {
  id: string;
  github_username: string | null;
  display_name: string | null;
  avatar_url: string | null;
};

type MemberRow = {
  workspace_id: string;
  user_id: string;
  role: "owner" | "member";
  added_at: string;
  profiles: ProfileRow | null;
};

// `id`, `ownerId` and `createdAt` are never patched: the first two are immutable and
// ownership transfer is out of scope.
export type CloudWorkspacePatch = Partial<Pick<Workspace, "name" | "color">>;

export type CloudWorkspaceInsert = { name: string; ownerId: string; id?: string } & CloudWorkspacePatch;

export function toWorkspace(row: WorkspaceRow): Workspace {
  const w: Workspace = {
    id: row.id,
    name: row.name,
    ownerId: row.owner_id,
    createdAt: row.created_at,
  };
  // Optional keys are omitted rather than set to undefined, so a mapped workspace
  // deep-equals a hand-written literal in tests and carries no null noise.
  if (row.color !== null) w.color = row.color;
  return w;
}

function toProfile(row: ProfileRow): Profile {
  const p: Profile = { id: row.id };
  if (row.github_username !== null) p.githubUsername = row.github_username;
  if (row.display_name !== null) p.displayName = row.display_name;
  if (row.avatar_url !== null) p.avatarUrl = row.avatar_url;
  return p;
}

function toWorkspaceMember(row: MemberRow): WorkspaceMember {
  const m: WorkspaceMember = {
    workspaceId: row.workspace_id,
    userId: row.user_id,
    role: row.role,
    addedAt: row.added_at,
  };
  if (row.profiles) m.profile = toProfile(row.profiles);
  return m;
}

// Only the keys actually present are sent, so a partial edit never nulls a column the
// user did not touch. An empty string means "clear it" -> NULL.
export function toWorkspaceRow(patch: CloudWorkspacePatch): Record<string, unknown> {
  const row: Record<string, unknown> = {};
  if (patch.name !== undefined) row.name = patch.name.trim();
  if (patch.color !== undefined) row.color = patch.color.trim() || null;
  return row;
}

export async function listWorkspaces(client: SupabaseClient): Promise<Workspace[]> {
  const { data, error } = await client
    .from("workspaces")
    .select(WORKSPACE_COLUMNS)
    .order("created_at", { ascending: true });
  if (error) throw new Error(error.message);
  return (data as WorkspaceRow[]).map(toWorkspace);
}

export async function createWorkspace(client: SupabaseClient, input: CloudWorkspaceInsert): Promise<Workspace> {
  const name = input.name.trim();
  if (!name) throw new Error("workspace name is required");
  // handle_new_workspace() inserts the owner's membership row, so no second round trip.
  const { data, error } = await client
    .from("workspaces")
    .insert({ ...toWorkspaceRow(input), ...(input.id ? { id: input.id } : {}), owner_id: input.ownerId })
    .select(WORKSPACE_COLUMNS)
    .single();
  if (error) throw new Error(error.message);
  return toWorkspace(data as WorkspaceRow);
}

export async function patchWorkspace(
  client: SupabaseClient,
  id: string,
  patch: CloudWorkspacePatch,
): Promise<Workspace> {
  const { data, error } = await client
    .from("workspaces")
    .update(toWorkspaceRow(patch))
    .eq("id", id)
    .select(WORKSPACE_COLUMNS)
    .single();
  if (error) throw new Error(error.message);
  return toWorkspace(data as WorkspaceRow);
}

export async function listMembers(client: SupabaseClient, workspaceId: string): Promise<WorkspaceMember[]> {
  const { data, error } = await client
    .from("workspace_members")
    .select(MEMBER_COLUMNS)
    .eq("workspace_id", workspaceId)
    .order("added_at", { ascending: true });
  if (error) throw new Error(error.message);
  // postgrest-js has no generated Database type here, so it widens every embed to an
  // array. `workspace_members.user_id references profiles` is to-one, so the wire
  // shape is a single object; go through `unknown` rather than weaken MemberRow.
  return (data as unknown as MemberRow[]).map(toWorkspaceMember);
}

// Membership is by EMAIL, and OWNER-only: unlike the project-level rule this
// replaces, one invitation now opens every project in the workspace, so it belongs to
// the role that already administers the group. Resolution happens entirely inside
// `invite_workspace_member` (a `security definer` rpc) because auth.users.email is
// unreachable for `authenticated`, and because workspace_members has no INSERT policy
// — the rpc and the creation trigger are the only writers.
export async function inviteMember(
  client: SupabaseClient,
  workspaceId: string,
  email: string,
): Promise<WorkspaceMember> {
  const address = email.trim().toLowerCase();
  if (!address) throw new Error("email is required");
  // Deliberately loose: the authority on whether an address exists is the rpc's
  // lookup, so this only catches the obvious typo — a github handle in the field.
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(address)) throw new Error(`"${address}" is not a valid email address`);
  const invited = await client.rpc("invite_workspace_member", {
    p_workspace_id: workspaceId,
    p_email: address,
  });
  if (invited.error) throw new Error(invited.error.message);
  const row = invited.data as { user_id: string } | null;
  if (!row) throw new Error(`invite for ${address} returned no membership row`);
  // Re-read for the joined profile: the rpc returns a bare row, and every consumer
  // expects the shape listMembers() hands out.
  const { data, error } = await client
    .from("workspace_members")
    .select(MEMBER_COLUMNS)
    .eq("workspace_id", workspaceId)
    .eq("user_id", row.user_id)
    .single();
  if (error) throw new Error(error.message);
  return toWorkspaceMember(data as unknown as MemberRow);
}

export async function removeMember(client: SupabaseClient, workspaceId: string, userId: string): Promise<void> {
  const { error } = await client
    .from("workspace_members")
    .delete()
    .eq("workspace_id", workspaceId)
    .eq("user_id", userId);
  if (error) throw new Error(error.message);
}

// Owner-only by policy (workspaces_delete_owner), AND refused by the FK from
// projects.workspace_id while the workspace still holds any. Callers must confirm
// with a re-read: a DELETE the policy refuses matches zero rows WITHOUT an error.
export async function deleteWorkspace(client: SupabaseClient, id: string): Promise<void> {
  const { error } = await client.from("workspaces").delete().eq("id", id);
  if (error) throw new Error(error.message);
}
