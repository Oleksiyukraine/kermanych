// Cloud projects. This file owns the snake_case <-> camelCase boundary: nothing outside
// @kermanych/cloud ever sees a Postgres column name. Membership is NOT here — a project
// draws its member list from its workspace, so the roster lives in workspaces.ts. Every
// call runs under the caller's JWT, so RLS — not this code — is the authorization
// surface; refusals surface as thrown postgrest messages.
import type { SupabaseClient } from "@supabase/supabase-js";
import type { CloudProject } from "./types";
import type { ThinkingLevel } from "@kermanych/core";

const PROJECT_COLUMNS =
  "id, name, workspace_id, git_remote_url, conventions, preview_command, api_command, default_branch, default_model, default_effort, carry_files, env_keys, color, created_at";

type ProjectRow = {
  id: string;
  name: string;
  workspace_id: string;
  git_remote_url: string | null;
  conventions: string | null;
  preview_command: string | null;
  api_command: string | null;
  default_branch: string | null;
  default_model: string | null;
  default_effort: string | null;
  carry_files: string[] | null;
  env_keys: string[] | null;
  color: string | null;
  created_at: string;
};

// The editable slice of a project. `id` and `createdAt` are never patched. `workspaceId`
// IS patchable — that is how a project moves between workspaces, and projects_update_member
// (USING on the old row, WITH CHECK on the new) requires membership of both.
export type CloudProjectPatch = Partial<
  Pick<
    CloudProject,
    "name" | "workspaceId" | "gitRemoteUrl" | "conventions" | "previewCommand" | "apiCommand" | "defaultBranch" | "defaultModel" | "carryFiles" | "envKeys" | "color"
  >
> & { defaultEffort?: ThinkingLevel | "" };

export function toCloudProject(row: ProjectRow): CloudProject {
  const p: CloudProject = {
    id: row.id,
    name: row.name,
    // `carry_files` defaults to array['.env'] in Postgres; be defensive so a hand-edited
    // row can never hand the launch path an empty carry list.
    carryFiles: row.carry_files ?? [".env"],
    envKeys: row.env_keys ?? [],
    workspaceId: row.workspace_id,
    createdAt: row.created_at,
  };
  // Optional keys are omitted rather than set to undefined, so a mapped project deep-equals
  // a hand-written literal in tests and JSON round-trips carry no null noise.
  if (row.git_remote_url !== null) p.gitRemoteUrl = row.git_remote_url;
  if (row.conventions !== null) p.conventions = row.conventions;
  if (row.preview_command !== null) p.previewCommand = row.preview_command;
  if (row.api_command !== null) p.apiCommand = row.api_command;
  if (row.default_branch !== null) p.defaultBranch = row.default_branch;
  if (row.default_model !== null) p.defaultModel = row.default_model;
  if (row.default_effort !== null) p.defaultEffort = row.default_effort as ThinkingLevel;
  if (row.color !== null) p.color = row.color;
  return p;
}

// Only the keys actually present in the patch are sent, so a partial edit never nulls a
// column the user did not touch. An empty string means "clear it" -> NULL.
export function toProjectRow(patch: CloudProjectPatch): Record<string, unknown> {
  const row: Record<string, unknown> = {};
  if (patch.name !== undefined) row.name = patch.name.trim();
  // The one exception to the rule above: a uuid, not user-typed text, so there is nothing
  // to trim — and `workspace_id` is `not null`, so clearing it to NULL is a write Postgres
  // must refuse rather than a way to say "no workspace".
  if (patch.workspaceId !== undefined) row.workspace_id = patch.workspaceId;
  if (patch.gitRemoteUrl !== undefined) row.git_remote_url = patch.gitRemoteUrl.trim() || null;
  if (patch.conventions !== undefined) row.conventions = patch.conventions.trim() || null;
  if (patch.previewCommand !== undefined) row.preview_command = patch.previewCommand.trim() || null;
  if (patch.apiCommand !== undefined) row.api_command = patch.apiCommand.trim() || null;
  if (patch.defaultBranch !== undefined) row.default_branch = patch.defaultBranch.trim() || null;
  if (patch.defaultModel !== undefined) row.default_model = patch.defaultModel.trim() || null;
  if (patch.defaultEffort !== undefined) row.default_effort = patch.defaultEffort.trim() || null;
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

// A new cloud project. `workspaceId` must be a workspace the caller belongs to —
// projects_insert_member checks nothing else — and every editable column may be
// seeded at birth, because PUBLISHING an existing local project has to carry that
// project's config across: syncProjects() then overwrites the local columns from the
// cloud row, so a bare-name insert would wipe the commands, carry files and branch
// the user already had.
//
// `id` is why this is not just a patch with a name. Omitted, Postgres mints a fresh
// uuid. Supplied, the insert adopts an identity that already exists on a machine: the
// schema makes `projects.id` the same value in the cloud and in every local registry,
// so publishing under the local id is what keeps that machine's binding, sessions and
// worktrees attached to the project instead of stranding them on an orphan row.
export type CloudProjectInsert = { name: string; workspaceId: string; id?: string } & CloudProjectPatch;

export async function createProject(client: SupabaseClient, input: CloudProjectInsert): Promise<CloudProject> {
  const name = input.name.trim();
  if (!name) throw new Error("project name is required");
  const { data, error } = await client
    .from("projects")
    .insert({ ...toProjectRow(input), ...(input.id ? { id: input.id } : {}) })
    .select(PROJECT_COLUMNS)
    .single();
  if (error) throw new Error(error.message);
  return toCloudProject(data as ProjectRow);
}

// Also the move: a patch carrying `workspaceId` re-parents the project, and there is no
// dedicated mutation for it. An RLS-refused move throws rather than silently doing
// nothing — 42501 when the destination fails WITH CHECK, PGRST116 when USING never
// matched the source and `.single()` finds no row.
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

// Workspace-owner-only by policy (projects_delete_owner). `tasks` cascade, so this takes
// the whole card wall with it for every member; the LOCAL row on each machine disappears
// through the next full sync's prune, unless it still owns sessions. A DELETE the policy
// refuses matches zero rows WITHOUT an error, so callers must confirm with a re-read —
// see `remove()` in apps/ui/src/stores/projects.ts.
export async function deleteProject(client: SupabaseClient, id: string): Promise<void> {
  const { error } = await client.from("projects").delete().eq("id", id);
  if (error) throw new Error(error.message);
}
