// Cloud projects + membership. This file owns the snake_case <-> camelCase boundary:
// nothing outside @kermanych/cloud ever sees a Postgres column name. Every call runs
// under the caller's JWT, so RLS — not this code — is the authorization surface; refusals
// surface as thrown postgrest messages.
import type { SupabaseClient } from "@supabase/supabase-js";
import type { CloudProject, Profile, ProjectMember } from "./types";

const PROJECT_COLUMNS =
  "id, name, git_remote_url, conventions, preview_command, api_command, default_branch, carry_files, env_keys, color, owner_id, created_at";
const PROFILE_COLUMNS = "id, github_username, display_name, avatar_url";
const MEMBER_COLUMNS = `project_id, user_id, role, added_at, profiles(${PROFILE_COLUMNS})`;

type ProjectRow = {
  id: string;
  name: string;
  git_remote_url: string | null;
  conventions: string | null;
  preview_command: string | null;
  api_command: string | null;
  default_branch: string | null;
  carry_files: string[] | null;
  env_keys: string[] | null;
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
  project_id: string;
  user_id: string;
  role: "owner" | "member";
  added_at: string;
  profiles: ProfileRow | null;
};

// The editable slice of a project. `id`, `ownerId` and `createdAt` are never patched:
// the first two are immutable and ownership transfer is out of scope.
export type CloudProjectPatch = Partial<
  Pick<
    CloudProject,
    "name" | "gitRemoteUrl" | "conventions" | "previewCommand" | "apiCommand" | "defaultBranch" | "carryFiles" | "envKeys" | "color"
  >
>;

export function toCloudProject(row: ProjectRow): CloudProject {
  const p: CloudProject = {
    id: row.id,
    name: row.name,
    // `carry_files` defaults to array['.env'] in Postgres; be defensive so a hand-edited
    // row can never hand the launch path an empty carry list.
    carryFiles: row.carry_files ?? [".env"],
    envKeys: row.env_keys ?? [],
    ownerId: row.owner_id,
    createdAt: row.created_at,
  };
  // Optional keys are omitted rather than set to undefined, so a mapped project deep-equals
  // a hand-written literal in tests and JSON round-trips carry no null noise.
  if (row.git_remote_url !== null) p.gitRemoteUrl = row.git_remote_url;
  if (row.conventions !== null) p.conventions = row.conventions;
  if (row.preview_command !== null) p.previewCommand = row.preview_command;
  if (row.api_command !== null) p.apiCommand = row.api_command;
  if (row.default_branch !== null) p.defaultBranch = row.default_branch;
  if (row.color !== null) p.color = row.color;
  return p;
}

function toProfile(row: ProfileRow): Profile {
  const p: Profile = { id: row.id };
  if (row.github_username !== null) p.githubUsername = row.github_username;
  if (row.display_name !== null) p.displayName = row.display_name;
  if (row.avatar_url !== null) p.avatarUrl = row.avatar_url;
  return p;
}

function toProjectMember(row: MemberRow): ProjectMember {
  const m: ProjectMember = { projectId: row.project_id, userId: row.user_id, role: row.role, addedAt: row.added_at };
  if (row.profiles) m.profile = toProfile(row.profiles);
  return m;
}

// Only the keys actually present in the patch are sent, so a partial edit never nulls a
// column the user did not touch. An empty string means "clear it" -> NULL.
export function toProjectRow(patch: CloudProjectPatch): Record<string, unknown> {
  const row: Record<string, unknown> = {};
  if (patch.name !== undefined) row.name = patch.name.trim();
  if (patch.gitRemoteUrl !== undefined) row.git_remote_url = patch.gitRemoteUrl.trim() || null;
  if (patch.conventions !== undefined) row.conventions = patch.conventions.trim() || null;
  if (patch.previewCommand !== undefined) row.preview_command = patch.previewCommand.trim() || null;
  if (patch.apiCommand !== undefined) row.api_command = patch.apiCommand.trim() || null;
  if (patch.defaultBranch !== undefined) row.default_branch = patch.defaultBranch.trim() || null;
  if (patch.carryFiles !== undefined) row.carry_files = patch.carryFiles;
  if (patch.envKeys !== undefined) row.env_keys = patch.envKeys;
  if (patch.color !== undefined) row.color = patch.color.trim() || null;
  return row;
}

export async function listProjects(client: SupabaseClient): Promise<CloudProject[]> {
  const { data, error } = await client.from("projects").select(PROJECT_COLUMNS).order("created_at", { ascending: true });
  if (error) throw new Error(error.message);
  return (data as ProjectRow[]).map(toCloudProject);
}

// A new cloud project. `ownerId` must be the caller — projects_insert_own checks nothing
// else — and every editable column may be seeded at birth, because PUBLISHING an existing
// local project has to carry that project's config across: syncProjects() then overwrites
// the local columns from the cloud row, so a bare-name insert would wipe the commands,
// carry files and branch the user already had.
//
// `id` is why this is not just a patch with a name. Omitted, Postgres mints a fresh uuid.
// Supplied, the insert adopts an identity that already exists on a machine: the schema
// makes `projects.id` the same value in the cloud and in every local registry, so
// publishing under the local id is what keeps that machine's binding, sessions and
// worktrees attached to the project instead of stranding them on an orphan row.
export type CloudProjectInsert = { name: string; ownerId: string; id?: string } & CloudProjectPatch;

export async function createProject(client: SupabaseClient, input: CloudProjectInsert): Promise<CloudProject> {
  const name = input.name.trim();
  if (!name) throw new Error("project name is required");
  // handle_new_project() inserts the owner's project_members row, so no second round trip.
  const { data, error } = await client
    .from("projects")
    .insert({ ...toProjectRow(input), ...(input.id ? { id: input.id } : {}), owner_id: input.ownerId })
    .select(PROJECT_COLUMNS)
    .single();
  if (error) throw new Error(error.message);
  return toCloudProject(data as ProjectRow);
}

export async function patchProject(client: SupabaseClient, id: string, patch: CloudProjectPatch): Promise<CloudProject> {
  const { data, error } = await client
    .from("projects")
    .update(toProjectRow(patch))
    .eq("id", id)
    .select(PROJECT_COLUMNS)
    .single();
  if (error) throw new Error(error.message);
  return toCloudProject(data as ProjectRow);
}

export async function listMembers(client: SupabaseClient, projectId: string): Promise<ProjectMember[]> {
  const { data, error } = await client
    .from("project_members")
    .select(MEMBER_COLUMNS)
    .eq("project_id", projectId)
    .order("added_at", { ascending: true });
  if (error) throw new Error(error.message);
  // postgrest-js has no generated Database type here, so it widens every embed to an
  // array. `project_members.user_id references profiles` is to-one, so the wire shape is
  // a single object; go through `unknown` rather than weaken MemberRow to a union.
  return (data as unknown as MemberRow[]).map(toProjectMember);
}

// Membership is by EMAIL: the address the person signed in with. Resolving it happens
// entirely inside `invite_project_member` (a `security definer` rpc), for two reasons that
// are both load-bearing:
//   1. `auth.users.email` is unreachable for the `authenticated` role, and mirroring it
//      into `profiles` would publish every teammate's address — `profiles_select` is
//      `using (true)` and sign-in is open.
//   2. `project_members` has no INSERT policy at all, so the rpc is the ONLY way a member
//      row appears (besides handle_new_project's owner row). A client cannot forge a row
//      with an arbitrary `user_id` or `role`.
// The rpc refuses a caller who is not already a member of the project, and refuses an
// email with no Kermanych account; both surface here as thrown postgres messages.
export async function inviteMember(client: SupabaseClient, projectId: string, email: string): Promise<ProjectMember> {
  const address = email.trim().toLowerCase();
  if (!address) throw new Error("email is required");
  // Deliberately loose: the authority on whether an address exists is the rpc's lookup, so
  // this only catches the obvious typo — a github handle in the email field.
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(address)) throw new Error(`"${address}" is not a valid email address`);
  const invited = await client.rpc("invite_project_member", { p_project_id: projectId, p_email: address });
  if (invited.error) throw new Error(invited.error.message);
  const row = invited.data as { user_id: string } | null;
  if (!row) throw new Error(`invite for ${address} returned no membership row`);
  // Re-read for the joined profile: the rpc returns a bare project_members row, and every
  // consumer expects the same shape listMembers() hands out.
  const { data, error } = await client
    .from("project_members")
    .select(MEMBER_COLUMNS)
    .eq("project_id", projectId)
    .eq("user_id", row.user_id)
    .single();
  if (error) throw new Error(error.message);
  return toProjectMember(data as unknown as MemberRow);
}

export async function removeMember(client: SupabaseClient, projectId: string, userId: string): Promise<void> {
  const { error } = await client.from("project_members").delete().eq("project_id", projectId).eq("user_id", userId);
  if (error) throw new Error(error.message);
}

// Owner-only by policy (projects_delete_owner). `tasks` and `project_members` cascade, so this
// takes the whole card wall with it for every member; the LOCAL row on each machine disappears
// through the next full sync's prune, unless it still owns sessions. A DELETE the policy refuses
// matches zero rows WITHOUT an error, so callers must confirm with a re-read — see
// `remove()` in apps/ui/src/stores/projects.ts.
export async function deleteProject(client: SupabaseClient, id: string): Promise<void> {
  const { error } = await client.from("projects").delete().eq("id", id);
  if (error) throw new Error(error.message);
}
