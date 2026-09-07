// Data access for «ШІ-команда» triggers: the rules that inject an instruction with its
// skills, or run an agent, without the model choosing to. Owns the snake_case <-> camelCase
// boundary for `project_triggers` and its `project_trigger_skills` child. Every call runs
// under the caller's JWT: the RLS policies (read = project member, write = workspace owner)
// are the authorization surface, and refusals — including the check constraints that only
// let an `agent` action hang off an `operator` source with an agent id, and forbid an agent
// id on a `prompt` — surface as thrown postgrest messages.
import type { SupabaseClient } from "@supabase/supabase-js";
import type { ProjectTrigger, ProjectTriggerInsert } from "./types";

// The audit columns are deliberately absent: they exist so a write cannot be forged, and
// nothing in the UI renders them for a trigger.
const TRIGGER_COLUMNS =
  "project_id, id, label, enabled, source, pattern, path_globs, action, instruction, agent_id, mode, repeat";

const TRIGGER_SKILL_COLUMNS = "project_id, trigger_id, skill_name, position";

type TriggerRow = {
  project_id: string;
  id: string;
  label: string;
  enabled: boolean;
  source: ProjectTrigger["source"];
  pattern: string;
  // Nullable in Postgres: an unscoped trigger stores NULL, not an empty array. The mapper
  // normalises it so every consumer can iterate without a null check.
  path_globs: string[] | null;
  action: ProjectTrigger["action"];
  instruction: string;
  // NULL for a 'prompt' action — the constraint requires it. Normalised to '' so consumers
  // never branch on null.
  agent_id: string | null;
  mode: ProjectTrigger["mode"];
  repeat: ProjectTrigger["repeat"];
};

type TriggerSkillRow = {
  project_id: string;
  trigger_id: string;
  skill_name: string;
  position: number;
};

/**
 * `skills` is NOT a column of `project_triggers`: it comes from the child table, so the
 * mapper takes the already-ordered sequence and defaults to empty for a lone row.
 */
export function toTrigger(row: TriggerRow, skills: string[] = []): ProjectTrigger {
  return {
    projectId: row.project_id,
    id: row.id,
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
  };
}

// `trigger_id` is unique only WITHIN a project, so the sequences are keyed by both.
function skillKey(projectId: string, triggerId: string): string {
  return `${projectId}\u0000${triggerId}`;
}

export async function listTriggers(
  client: SupabaseClient,
  projectIds: string[],
): Promise<ProjectTrigger[]> {
  // `in.()` with an empty list is not valid postgrest syntax, and a member of no project
  // has no triggers to read.
  if (projectIds.length === 0) return [];
  const { data, error } = await client
    .from("project_triggers")
    .select(TRIGGER_COLUMNS)
    .in("project_id", projectIds)
    .order("id", { ascending: true });
  if (error) throw new Error(error.message);

  // A second round trip rather than a postgrest embed: the child table's FK is composite,
  // which PostgREST cannot follow as a relationship, and the join is cheap in JS.
  const { data: skillData, error: skillError } = await client
    .from("project_trigger_skills")
    .select(TRIGGER_SKILL_COLUMNS)
    .in("project_id", projectIds)
    // `position` first within a trigger: it is the order the session delivers the skills
    // in, and `skill_name` only breaks a tie so the list never reorders between reads.
    .order("trigger_id", { ascending: true })
    .order("position", { ascending: true })
    .order("skill_name", { ascending: true });
  if (skillError) throw new Error(skillError.message);

  const sequences = new Map<string, string[]>();
  for (const row of skillData as TriggerSkillRow[]) {
    const key = skillKey(row.project_id, row.trigger_id);
    const seq = sequences.get(key);
    if (seq) seq.push(row.skill_name);
    else sequences.set(key, [row.skill_name]);
  }

  return (data as TriggerRow[]).map((row) => toTrigger(row, sequences.get(skillKey(row.project_id, row.id)) ?? []));
}

// Upsert on the composite key: the editor saves a new trigger and an edited one the same way.
// The skill sequence is NOT written here — it lives in its own table; see setTriggerSkills.
export async function upsertTrigger(
  client: SupabaseClient,
  input: ProjectTriggerInsert,
): Promise<ProjectTrigger> {
  const { data, error } = await client
    .from("project_triggers")
    .upsert(
      {
        project_id: input.projectId,
        id: input.id,
        label: input.label.trim(),
        enabled: input.enabled ?? true,
        source: input.source,
        pattern: input.pattern,
        // No globs is NULL, not `{}`: the column's absence of a scope and an explicitly
        // empty scope must not be two different states in the database.
        path_globs: input.pathGlobs && input.pathGlobs.length > 0 ? input.pathGlobs : null,
        action: input.action,
        instruction: input.instruction ?? "",
        // A 'prompt' has no agent, and the check constraint says so: '' would violate it as
        // surely as a real id, so an empty id is stored as the NULL it means.
        agent_id: input.agentId ? input.agentId : null,
        mode: input.mode,
        repeat: input.repeat,
      },
      { onConflict: "project_id,id" },
    )
    .select(TRIGGER_COLUMNS)
    .single();
  if (error) throw new Error(error.message);
  return toTrigger(data as TriggerRow, input.skills ? [...input.skills] : []);
}

/**
 * Replace a trigger's whole skill sequence. `names` in order; empty clears it.
 *
 * Two statements, not one transaction: PostgREST has no multi-statement call, so a reader
 * between them sees the removals applied but the new order not yet written. Deleting first
 * keeps that window a SUBSET of the intended sequence — never a duplicate and never a
 * stale entry the operator just removed — which is the same worst case the per-row writes
 * this replaces already had, and the launcher reads the sequence once, at launch.
 */
export async function setTriggerSkills(
  client: SupabaseClient,
  projectId: string,
  triggerId: string,
  names: readonly string[],
): Promise<void> {
  let del = client
    .from("project_trigger_skills")
    .delete()
    .eq("project_id", projectId)
    .eq("trigger_id", triggerId);
  // The names survive the check regex, so none can contain a comma or a quote that would
  // break out of this filter list.
  if (names.length > 0) del = del.not("skill_name", "in", `(${names.join(",")})`);
  const { error: deleteError } = await del;
  if (deleteError) throw new Error(deleteError.message);

  if (names.length === 0) return;
  const { error } = await client.from("project_trigger_skills").upsert(
    names.map((skillName, index) => ({
      project_id: projectId,
      trigger_id: triggerId,
      skill_name: skillName,
      position: index,
    })),
    { onConflict: "project_id,trigger_id,skill_name" },
  );
  if (error) throw new Error(error.message);
}

// A DELETE the owner-only USING clause filters out matches zero rows and reports NO error,
// so a member's refusal and an already-gone trigger would both look like success — while an
// unauthorized upsert raises 42501. `.select()` closes that asymmetry: the deleted rows come
// back, and an empty set is the refusal the editor must not treat as a dropped trigger.
export async function deleteTrigger(
  client: SupabaseClient,
  projectId: string,
  id: string,
): Promise<void> {
  const { data, error } = await client
    .from("project_triggers")
    .delete()
    .eq("project_id", projectId)
    .eq("id", id)
    .select(TRIGGER_COLUMNS);
  if (error) throw new Error(error.message);
  if (!data || data.length === 0) {
    throw new Error(`trigger "${id}" was not deleted: the delete was refused or the trigger is already gone`);
  }
}
