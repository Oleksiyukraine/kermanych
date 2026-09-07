// Data access for the per-project override of an agent's instruction. Owns the snake_case
// <-> camelCase boundary for `project_agents`. A MISSING row means «use the compile-time
// default from core's AGENTS registry», so there is no disable flag and no empty sentinel:
// deleteProjectAgent IS the reset. Every call runs under the caller's JWT: the RLS policies
// (read = project member, write = workspace owner) are the authorization surface, and
// refusals surface as thrown postgrest messages.
import type { SupabaseClient } from "@supabase/supabase-js";
import type { ProjectAgent, ProjectAgentInsert } from "./types";

// Unlike an assignment, the audit columns ARE part of the surface: the Агенти pane says
// «перекрито» next to an overridden instruction, and that is the row's own provenance.
const PROJECT_AGENT_COLUMNS = "project_id, agent_id, instruction, updated_at, updated_by";

type ProjectAgentRow = {
  project_id: string;
  agent_id: string;
  instruction: string;
  updated_at: string;
  // `on delete set null`: an override outlives the account that last edited it.
  updated_by: string | null;
};

export function toProjectAgent(row: ProjectAgentRow): ProjectAgent {
  const a: ProjectAgent = {
    projectId: row.project_id,
    agentId: row.agent_id,
    instruction: row.instruction,
    updatedAt: row.updated_at,
  };
  if (row.updated_by !== null) a.updatedBy = row.updated_by;
  return a;
}

export async function listProjectAgents(
  client: SupabaseClient,
  projectIds: string[],
): Promise<ProjectAgent[]> {
  // `in.()` with an empty list is not valid postgrest syntax, and a member of no project
  // has no overrides to read.
  if (projectIds.length === 0) return [];
  const { data, error } = await client
    .from("project_agents")
    .select(PROJECT_AGENT_COLUMNS)
    .in("project_id", projectIds)
    .order("agent_id", { ascending: true });
  if (error) throw new Error(error.message);
  return (data as ProjectAgentRow[]).map(toProjectAgent);
}

// Upsert on the composite key: writing the first override and editing an existing one are
// the same write.
export async function upsertProjectAgent(
  client: SupabaseClient,
  input: ProjectAgentInsert,
): Promise<ProjectAgent> {
  const { data, error } = await client
    .from("project_agents")
    .upsert(
      {
        project_id: input.projectId,
        agent_id: input.agentId,
        // Not trimmed: an instruction is a template whose leading and trailing layout is
        // the operator's, and core renders it verbatim.
        instruction: input.instruction,
      },
      { onConflict: "project_id,agent_id" },
    )
    .select(PROJECT_AGENT_COLUMNS)
    .single();
  if (error) throw new Error(error.message);
  return toProjectAgent(data as ProjectAgentRow);
}

// A DELETE the owner-only USING clause filters out matches zero rows and reports NO error,
// so a member's refusal and an already-default agent would both look like success — while an
// unauthorized upsert raises 42501. `.select()` closes that asymmetry: the deleted rows come
// back, and an empty set is the refusal the editor must not render as a completed reset.
export async function deleteProjectAgent(
  client: SupabaseClient,
  projectId: string,
  agentId: string,
): Promise<void> {
  const { data, error } = await client
    .from("project_agents")
    .delete()
    .eq("project_id", projectId)
    .eq("agent_id", agentId)
    .select(PROJECT_AGENT_COLUMNS);
  if (error) throw new Error(error.message);
  if (!data || data.length === 0) {
    throw new Error(
      `the instruction of agent "${agentId}" was not reset: the delete was refused or the override is already gone`,
    );
  }
}
