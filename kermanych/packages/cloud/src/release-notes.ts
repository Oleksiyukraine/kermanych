// Data access for workspace release notes. Owns the snake_case <-> camelCase boundary for
// `workspace_release_notes`. Every call runs under the caller's JWT; the RLS policies
// (read and write = workspace member) are the authorization surface and refusals surface
// as thrown postgrest messages.
//
// There is deliberately NO deleteWorkspaceReleaseNote: the table grants no `delete` to
// anyone — the section's promise is that everything generated stays in the workspace, and
// a note that came out wrong is edited, not destroyed.
import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  WorkspaceReleaseNote,
  WorkspaceReleaseNoteInsert,
  WorkspaceReleaseNotePatch,
} from "./types";

// One string literal, not a concatenation: postgrest-js parses this at the TYPE level to
// shape the response, and a `+`-joined value degrades to GenericStringError.
const NOTE_COLUMNS =
  "id, workspace_id, project_id, project_name, branch, range_from, range_to, title, body_md, created_at, created_by, updated_at, updated_by";

type NoteRow = {
  id: string;
  workspace_id: string;
  project_id: string | null;
  project_name: string;
  branch: string;
  range_from: string;
  range_to: string;
  title: string;
  body_md: string;
  created_at: string;
  created_by: string | null;
  updated_at: string;
  updated_by: string | null;
};

export function toWorkspaceReleaseNote(row: NoteRow): WorkspaceReleaseNote {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    ...(row.project_id === null ? {} : { projectId: row.project_id }),
    projectName: row.project_name,
    branch: row.branch,
    rangeFrom: row.range_from,
    rangeTo: row.range_to,
    title: row.title,
    bodyMd: row.body_md,
    createdAt: row.created_at,
    ...(row.created_by === null ? {} : { createdBy: row.created_by }),
    updatedAt: row.updated_at,
    ...(row.updated_by === null ? {} : { updatedBy: row.updated_by }),
  };
}

// The list screen reads one workspace at a time, newest first — the top of the history is
// «what did we ship last», which is the question the section opens on.
export async function listWorkspaceReleaseNotes(
  client: SupabaseClient,
  workspaceId: string,
): Promise<WorkspaceReleaseNote[]> {
  const { data, error } = await client
    .from("workspace_release_notes")
    .select(NOTE_COLUMNS)
    .eq("workspace_id", workspaceId)
    .order("created_at", { ascending: false });
  if (error) throw new Error(error.message);
  return (data as NoteRow[]).map(toWorkspaceReleaseNote);
}

export async function createWorkspaceReleaseNote(
  client: SupabaseClient,
  input: WorkspaceReleaseNoteInsert,
): Promise<WorkspaceReleaseNote> {
  const { data, error } = await client
    .from("workspace_release_notes")
    .insert({
      workspace_id: input.workspaceId,
      ...(input.projectId === undefined ? {} : { project_id: input.projectId }),
      project_name: input.projectName,
      branch: input.branch,
      range_from: input.rangeFrom,
      range_to: input.rangeTo,
      title: input.title,
      body_md: input.bodyMd,
    })
    .select(NOTE_COLUMNS)
    .single();
  if (error) throw new Error(error.message);
  return toWorkspaceReleaseNote(data as NoteRow);
}

// Only the title and the body are editable — the trigger freezes everything else, so a
// patch carrying more would be silently ignored rather than applied, and this type keeps
// a caller from believing otherwise.
export async function patchWorkspaceReleaseNote(
  client: SupabaseClient,
  id: string,
  patch: WorkspaceReleaseNotePatch,
): Promise<WorkspaceReleaseNote> {
  const { data, error } = await client
    .from("workspace_release_notes")
    .update({
      ...(patch.title === undefined ? {} : { title: patch.title }),
      ...(patch.bodyMd === undefined ? {} : { body_md: patch.bodyMd }),
    })
    .eq("id", id)
    .select(NOTE_COLUMNS)
    .single();
  if (error) throw new Error(error.message);
  return toWorkspaceReleaseNote(data as NoteRow);
}
