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

export async function createProject(
  client: SupabaseClient,
  input: { name: string; ownerId: string; gitRemoteUrl?: string },
): Promise<CloudProject> {
  const name = input.name.trim();
  if (!name) throw new Error("project name is required");
  // handle_new_project() inserts the owner's project_members row, so no second round trip.
  const { data, error } = await client
    .from("projects")
    .insert({ name, git_remote_url: input.gitRemoteUrl?.trim() || null, owner_id: input.ownerId })
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

// Membership is by GitHub handle, because that is what a team knows about each other. The
// handle must already have a `profiles` row, i.e. that person has signed in at least once.
export async function addMember(client: SupabaseClient, projectId: string, githubUsername: string): Promise<ProjectMember> {
  const handle = githubUsername.trim().replace(/^@/, "").trim();
  if (!handle) throw new Error("github username is required");
  const found = await client.from("profiles").select(PROFILE_COLUMNS).eq("github_username", handle).maybeSingle();
  if (found.error) throw new Error(found.error.message);
  const profile = found.data as ProfileRow | null;
  if (!profile) throw new Error(`no Kermanych profile for @${handle} — ask them to sign in with GitHub first`);
  const { data, error } = await client
    .from("project_members")
    .insert({ project_id: projectId, user_id: profile.id, role: "member" })
    .select(MEMBER_COLUMNS)
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
