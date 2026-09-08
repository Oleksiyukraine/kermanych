// Data access for the «ШІ-команда» skill library (`ai_skills`). Owns the snake_case <->
// camelCase boundary and the owner triad <-> { scope, id } boundary. Every call runs under the
// caller's JWT: the RLS policies (read = scope member, write = scope owner) are the
// authorization surface, and refusals surface as thrown postgrest messages.
import type { SupabaseClient } from "@supabase/supabase-js";
import type { AiOwner, AiSkill, AiSkillInsert } from "./types";
import { OWNER_COLUMNS, ownerColumn, ownerColumns, ownerConflict, rowOwner } from "./ai-scope";

const SKILL_COLUMNS = `id, ${OWNER_COLUMNS}, name, description, body, enabled, updated_at, updated_by`;

type SkillRow = {
  id: string;
  workspace_id: string | null;
  project_id: string | null;
  user_id: string | null;
  name: string;
  description: string;
  body: string;
  enabled: boolean;
  updated_at: string;
  // `on delete set null`: a skill outlives the account that last edited it.
  updated_by: string | null;
};

export function toAiSkill(row: SkillRow): AiSkill {
  const s: AiSkill = {
    id: row.id,
    owner: rowOwner(row),
    name: row.name,
    description: row.description,
    body: row.body,
    enabled: row.enabled,
    updatedAt: row.updated_at,
  };
  if (row.updated_by !== null) s.updatedBy = row.updated_by;
  return s;
}

// Every skill of one owner, by name. The launch resolver reads each scope an owner sees and
// merges them; the editor reads exactly one.
export async function listAiSkills(client: SupabaseClient, owner: AiOwner): Promise<AiSkill[]> {
  const { data, error } = await client
    .from("ai_skills")
    .select(SKILL_COLUMNS)
    .eq(ownerColumn(owner.scope), owner.id)
    .order("name", { ascending: true });
  if (error) throw new Error(error.message);
  return (data as SkillRow[]).map(toAiSkill);
}

// Upsert on the owner-triad key: the editor saves a new skill and an edited one the same way.
export async function upsertAiSkill(client: SupabaseClient, input: AiSkillInsert): Promise<AiSkill> {
  const { data, error } = await client
    .from("ai_skills")
    .upsert(
      {
        ...ownerColumns(input.owner),
        name: input.name,
        description: input.description.trim(),
        body: input.body,
        enabled: input.enabled ?? true,
      },
      { onConflict: ownerConflict("name") },
    )
    .select(SKILL_COLUMNS)
    .single();
  if (error) throw new Error(error.message);
  return toAiSkill(data as SkillRow);
}

// A DELETE the owner-only USING clause filters out matches zero rows and reports NO error, so
// a member's refusal and an already-gone skill would both look like success — while an
// unauthorized upsert raises 42501. `.select()` closes that asymmetry: the deleted rows come
// back, and an empty set is the refusal the editor must not treat as a dropped row.
export async function deleteAiSkill(client: SupabaseClient, owner: AiOwner, name: string): Promise<void> {
  const { data, error } = await client
    .from("ai_skills")
    .delete()
    .eq(ownerColumn(owner.scope), owner.id)
    .eq("name", name)
    .select(SKILL_COLUMNS);
  if (error) throw new Error(error.message);
  if (!data || data.length === 0) {
    throw new Error(`skill "${name}" was not deleted: the delete was refused or the skill is already gone`);
  }
}
