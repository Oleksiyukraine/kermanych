// Data access for the Project Documentation screen's links (`project_doc_links`). Owns the
// snake_case <-> camelCase boundary. Every call runs under the caller's JWT: the RLS policy
// (read and write = project member) is the authorization surface, and refusals surface as
// thrown postgrest messages.
import type { SupabaseClient } from "@supabase/supabase-js";
import type { ProjectDocLink, ProjectDocLinkInsert, ProjectDocLinkPatch } from "./types";

// One string literal, not a concatenation: postgrest-js parses this at the TYPE level.
const LINK_COLUMNS = "id, project_id, title, url, created_at, created_by, updated_at, updated_by";

type LinkRow = {
  id: string;
  project_id: string;
  title: string;
  url: string;
  created_at: string;
  created_by: string | null;
  updated_at: string;
  updated_by: string | null;
};

export function toProjectDocLink(row: LinkRow): ProjectDocLink {
  return {
    id: row.id,
    projectId: row.project_id,
    title: row.title,
    url: row.url,
    createdAt: row.created_at,
    ...(row.created_by === null ? {} : { createdBy: row.created_by }),
    updatedAt: row.updated_at,
    ...(row.updated_by === null ? {} : { updatedBy: row.updated_by }),
  };
}

// One project's links in the order they were added — the list reads like the folder tree
// beside it, which does not reshuffle when something is edited.
export async function listProjectDocLinks(client: SupabaseClient, projectId: string): Promise<ProjectDocLink[]> {
  const { data, error } = await client
    .from("project_doc_links")
    .select(LINK_COLUMNS)
    .eq("project_id", projectId)
    .order("created_at", { ascending: true });
  if (error) throw new Error(error.message);
  return (data as LinkRow[]).map(toProjectDocLink);
}

export async function createProjectDocLink(client: SupabaseClient, input: ProjectDocLinkInsert): Promise<ProjectDocLink> {
  const { data, error } = await client
    .from("project_doc_links")
    .insert({ project_id: input.projectId, title: input.title.trim(), url: input.url })
    .select(LINK_COLUMNS)
    .single();
  if (error) throw new Error(error.message);
  return toProjectDocLink(data as LinkRow);
}

export async function patchProjectDocLink(
  client: SupabaseClient,
  id: string,
  patch: ProjectDocLinkPatch,
): Promise<ProjectDocLink> {
  const { data, error } = await client
    .from("project_doc_links")
    .update({
      ...(patch.title === undefined ? {} : { title: patch.title.trim() }),
      ...(patch.url === undefined ? {} : { url: patch.url }),
    })
    .eq("id", id)
    .select(LINK_COLUMNS)
    .single();
  if (error) throw new Error(error.message);
  return toProjectDocLink(data as LinkRow);
}

// A DELETE the USING clause filters out matches zero rows and reports NO error, so a refusal
// and an already-gone link would both look like success. `.select()` returns the deleted rows,
// and an empty set is reported rather than taken as done.
export async function deleteProjectDocLink(client: SupabaseClient, id: string): Promise<void> {
  const { data, error } = await client.from("project_doc_links").delete().eq("id", id).select("id");
  if (error) throw new Error(error.message);
  if (!data || data.length === 0) {
    throw new Error("the link was not removed: the delete was refused or the link is already gone");
  }
}
