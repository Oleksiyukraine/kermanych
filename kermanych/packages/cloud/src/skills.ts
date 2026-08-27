// Data access for the per-project skill library. Owns the snake_case <-> camelCase boundary
// for `project_skills`. Every call runs under the caller's JWT: the RLS policies (read =
// member, write = owner) are the authorization surface, and refusals surface as thrown
// postgrest messages.
import type { SupabaseClient } from "@supabase/supabase-js";
import type { ProjectSkill, ProjectSkillInsert } from "./types";

const SKILL_COLUMNS = "project_id, name, description, body, enabled, updated_at, updated_by";

type SkillRow = {
  project_id: string;
  name: string;
  description: string;
  body: string;
  enabled: boolean;
  updated_at: string;
  // `on delete set null`: a skill outlives the account that last edited it.
  updated_by: string | null;
};

export function toProjectSkill(row: SkillRow): ProjectSkill {
  const s: ProjectSkill = {
    projectId: row.project_id,
    name: row.name,
    description: row.description,
    body: row.body,
    enabled: row.enabled,
    updatedAt: row.updated_at,
  };
  if (row.updated_by !== null) s.updatedBy = row.updated_by;
  return s;
}

export async function listProjectSkills(
  client: SupabaseClient,
  projectIds: string[],
): Promise<ProjectSkill[]> {
  // `in.()` with an empty list is not valid postgrest syntax, and a member of no project
  // has no library to read.
  if (projectIds.length === 0) return [];
  const { data, error } = await client
    .from("project_skills")
    .select(SKILL_COLUMNS)
    .in("project_id", projectIds)
    .order("name", { ascending: true });
  if (error) throw new Error(error.message);
  return (data as SkillRow[]).map(toProjectSkill);
}

// Upsert on the composite key: the editor saves a new skill and an edited one the same way.
export async function upsertProjectSkill(
  client: SupabaseClient,
  input: ProjectSkillInsert,
): Promise<ProjectSkill> {
  const { data, error } = await client
    .from("project_skills")
    .upsert(
      {
        project_id: input.projectId,
        name: input.name,
        description: input.description.trim(),
        body: input.body,
        enabled: input.enabled ?? true,
      },
      { onConflict: "project_id,name" },
    )
    .select(SKILL_COLUMNS)
    .single();
  if (error) throw new Error(error.message);
  return toProjectSkill(data as SkillRow);
}

// A DELETE the owner-only USING clause filters out matches zero rows and reports NO error,
// so a member's refusal and an already-gone skill would both look like success — while an
// unauthorized upsert raises 42501. `.select()` closes that asymmetry: the deleted rows come
// back, and an empty set is the refusal the editor must not treat as a dropped row.
export async function deleteProjectSkill(
  client: SupabaseClient,
  projectId: string,
  name: string,
): Promise<void> {
  const { data, error } = await client
    .from("project_skills")
    .delete()
    .eq("project_id", projectId)
    .eq("name", name)
    .select(SKILL_COLUMNS);
  if (error) throw new Error(error.message);
  if (!data || data.length === 0) {
    throw new Error(`skill "${name}" was not deleted: the delete was refused or the skill is already gone`);
  }
}
