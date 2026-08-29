// Data access for «ШІ команда» triggers: the rules that fire a skill or an agent without
// the model choosing to. Owns the snake_case <-> camelCase boundary for `project_triggers`.
// Every call runs under the caller's JWT: the RLS policies (read = project member, write =
// workspace owner) are the authorization surface, and refusals — including the check
// constraint that only lets an `agent` action hang off an `operator` source — surface as
// thrown postgrest messages.
import type { SupabaseClient } from "@supabase/supabase-js";
import type { ProjectTrigger, ProjectTriggerInsert } from "./types";

// The audit columns are deliberately absent: they exist so a write cannot be forged, and
// nothing in the UI renders them for a trigger.
const TRIGGER_COLUMNS =
  "project_id, id, label, enabled, source, pattern, path_globs, action, target, mode, repeat";

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
  target: string;
  mode: ProjectTrigger["mode"];
  repeat: ProjectTrigger["repeat"];
};

export function toTrigger(row: TriggerRow): ProjectTrigger {
  return {
    projectId: row.project_id,
    id: row.id,
    label: row.label,
    enabled: row.enabled,
    source: row.source,
    pattern: row.pattern,
    pathGlobs: row.path_globs ?? [],
    action: row.action,
    target: row.target,
    mode: row.mode,
    repeat: row.repeat,
  };
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
  return (data as TriggerRow[]).map(toTrigger);
}

// Upsert on the composite key: the editor saves a new trigger and an edited one the same way.
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
        target: input.target,
        mode: input.mode,
        repeat: input.repeat,
      },
      { onConflict: "project_id,id" },
    )
    .select(TRIGGER_COLUMNS)
    .single();
  if (error) throw new Error(error.message);
  return toTrigger(data as TriggerRow);
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
