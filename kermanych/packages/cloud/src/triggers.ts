// Data access for «ШІ-команда» triggers (`ai_triggers` + its `ai_trigger_skills` child): the
// rules that inject an instruction with its skills, or run an agent, without the model
// choosing to. Owns the snake_case <-> camelCase and owner-triad boundaries. Every call runs
// under the caller's JWT; RLS (read = scope member, write = scope owner) plus the check
// constraints (an `agent` action needs an operator source and an agent id; a `prompt` carries
// none) are the authorization and integrity surface, surfaced as thrown postgrest messages.
import type { SupabaseClient } from "@supabase/supabase-js";
import type { AiOwner, AiTrigger, AiTriggerInsert } from "./types";
import { OWNER_COLUMNS, ownerColumn, ownerColumns, ownerConflict, rowOwner } from "./ai-scope";

const TRIGGER_COLUMNS = `id, ${OWNER_COLUMNS}, slug, label, enabled, source, pattern, path_globs, action, instruction, agent_id, mode, repeat, created_at, created_by, updated_at, updated_by`;

// The child hangs off the trigger's surrogate id, so it needs neither the owner nor the slug.
const TRIGGER_SKILL_COLUMNS = "trigger_id, skill_name, position";

type TriggerRow = {
  id: string;
  workspace_id: string | null;
  project_id: string | null;
  user_id: string | null;
  slug: string;
  label: string;
  enabled: boolean;
  source: AiTrigger["source"];
  pattern: string;
  // Nullable in Postgres: an unscoped trigger stores NULL, not an empty array. The mapper
  // normalises it so every consumer can iterate without a null check.
  path_globs: string[] | null;
  action: AiTrigger["action"];
  instruction: string;
  // NULL for a 'prompt' action — the constraint requires it. Normalised to '' so consumers
  // never branch on null.
  agent_id: string | null;
  mode: AiTrigger["mode"];
  repeat: AiTrigger["repeat"];
  created_at: string;
  // `on delete set null`: a trigger outlives the account that authored or last edited it.
  created_by: string | null;
  updated_at: string;
  updated_by: string | null;
};

type TriggerSkillRow = { trigger_id: string; skill_name: string; position: number };

/**
 * `skills` is NOT a column of `ai_triggers`: it comes from the child table, so the mapper
 * takes the already-ordered sequence and defaults to empty for a lone row.
 */
export function toAiTrigger(row: TriggerRow, skills: string[] = []): AiTrigger {
  return {
    id: row.id,
    owner: rowOwner(row),
    slug: row.slug,
    label: row.label,
    enabled: row.enabled,
    source: row.source,
    pattern: row.pattern,
    pathGlobs: row.path_globs ?? [],
    action: row.action,
    instruction: row.instruction,
    agentId: row.agent_id ?? "",
    skills,
    mode: row.mode,
    repeat: row.repeat,
    createdAt: row.created_at,
    ...(row.created_by !== null ? { createdBy: row.created_by } : {}),
    updatedAt: row.updated_at,
    ...(row.updated_by !== null ? { updatedBy: row.updated_by } : {}),
  };
}

export async function listAiTriggers(client: SupabaseClient, owner: AiOwner): Promise<AiTrigger[]> {
  const { data, error } = await client
    .from("ai_triggers")
    .select(TRIGGER_COLUMNS)
    .eq(ownerColumn(owner.scope), owner.id)
    .order("slug", { ascending: true });
  if (error) throw new Error(error.message);
  const rows = data as TriggerRow[];
  if (rows.length === 0) return [];

  // A second round trip keyed on the surrogate ids rather than a postgrest embed: the FK is
  // followable, but reading the children by id keeps this identical to the other sequences.
  const { data: skillData, error: skillError } = await client
    .from("ai_trigger_skills")
    .select(TRIGGER_SKILL_COLUMNS)
    .in(
      "trigger_id",
      rows.map((r) => r.id),
    )
    // `position` first within a trigger: the order the session delivers the skills in;
    // `skill_name` only breaks a tie so the list never reorders between reads.
    .order("trigger_id", { ascending: true })
    .order("position", { ascending: true })
    .order("skill_name", { ascending: true });
  if (skillError) throw new Error(skillError.message);

  const sequences = new Map<string, string[]>();
  for (const row of skillData as TriggerSkillRow[]) {
    const seq = sequences.get(row.trigger_id);
    if (seq) seq.push(row.skill_name);
    else sequences.set(row.trigger_id, [row.skill_name]);
  }

  return rows.map((row) => toAiTrigger(row, sequences.get(row.id) ?? []));
}

// Upsert on the owner-triad + slug key: the editor saves a new trigger and an edited one the
// same way, and a slug is stable across edits. The skill sequence is NOT written here — it
// lives in its own table; see setAiTriggerSkills.
export async function upsertAiTrigger(client: SupabaseClient, input: AiTriggerInsert): Promise<AiTrigger> {
  const { data, error } = await client
    .from("ai_triggers")
    .upsert(
      {
        ...ownerColumns(input.owner),
        slug: input.slug,
        label: input.label.trim(),
        enabled: input.enabled ?? true,
        source: input.source,
        pattern: input.pattern,
        // No globs is NULL, not `{}`: an absent scope and an explicitly empty scope must not
        // be two different states in the database.
        path_globs: input.pathGlobs && input.pathGlobs.length > 0 ? input.pathGlobs : null,
        action: input.action,
        instruction: input.instruction ?? "",
        // A 'prompt' has no agent: '' would violate the check constraint as surely as a real
        // id, so an empty id is stored as the NULL it means.
        agent_id: input.agentId ? input.agentId : null,
        mode: input.mode,
        repeat: input.repeat,
      },
      { onConflict: ownerConflict("slug") },
    )
    .select(TRIGGER_COLUMNS)
    .single();
  if (error) throw new Error(error.message);
  return toAiTrigger(data as TriggerRow, input.skills ? [...input.skills] : []);
}

/**
 * Replace a trigger's whole skill sequence, addressed by its surrogate id. `names` in order;
 * empty clears it. Delete-then-insert rather than a transaction PostgREST cannot express: a
 * reader between the two statements sees a SUBSET of the intended sequence — never a duplicate
 * and never a stale entry — and the launcher reads the sequence once, at launch.
 */
export async function setAiTriggerSkills(
  client: SupabaseClient,
  triggerId: string,
  names: readonly string[],
): Promise<void> {
  const { error: deleteError } = await client
    .from("ai_trigger_skills")
    .delete()
    .eq("trigger_id", triggerId);
  if (deleteError) throw new Error(deleteError.message);

  if (names.length === 0) return;
  const { error } = await client.from("ai_trigger_skills").insert(
    names.map((skillName, index) => ({ trigger_id: triggerId, skill_name: skillName, position: index })),
  );
  if (error) throw new Error(error.message);
}

// `.select()` for the same reason as the other deletes: a refused DELETE and an already-gone
// trigger both match zero rows, so the empty set is the refusal the editor must not treat as a
// dropped trigger. Addressed by surrogate id — unambiguous across scopes.
export async function deleteAiTrigger(client: SupabaseClient, triggerId: string): Promise<void> {
  const { data, error } = await client
    .from("ai_triggers")
    .delete()
    .eq("id", triggerId)
    .select(TRIGGER_COLUMNS);
  if (error) throw new Error(error.message);
  if (!data || data.length === 0) {
    throw new Error(`trigger was not deleted: the delete was refused or the trigger is already gone`);
  }
}
