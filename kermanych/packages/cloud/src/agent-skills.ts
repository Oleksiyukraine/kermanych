// Data access for «ШІ команда» assignments: which skills a project hands to each of
// Kermanych's agents. Owns the snake_case <-> camelCase boundary for
// `project_agent_skills`. Every call runs under the caller's JWT: the RLS policies (read =
// project member, write = workspace owner) are the authorization surface, and refusals
// surface as thrown postgrest messages.
import type { SupabaseClient } from "@supabase/supabase-js";
import type { AgentSkill, AgentSkillInsert } from "./types";

// The audit columns are deliberately absent: they exist so a write cannot be forged, and
// nothing in the UI renders them for an assignment.
const AGENT_SKILL_COLUMNS = "project_id, agent_id, skill_name, position";

type AgentSkillRow = {
  project_id: string;
  agent_id: string;
  skill_name: string;
  position: number;
};

export function toAgentSkill(row: AgentSkillRow): AgentSkill {
  return {
    projectId: row.project_id,
    agentId: row.agent_id,
    skillName: row.skill_name,
    position: row.position,
  };
}

export async function listAgentSkills(
  client: SupabaseClient,
  projectIds: string[],
): Promise<AgentSkill[]> {
  // `in.()` with an empty list is not valid postgrest syntax, and a member of no project
  // has nothing assigned to read.
  if (projectIds.length === 0) return [];
  const { data, error } = await client
    .from("project_agent_skills")
    .select(AGENT_SKILL_COLUMNS)
    .in("project_id", projectIds)
    // `position` first within an agent: it is the order the launcher writes the skills in,
    // and `skill_name` only breaks a tie so the list never reorders between reads.
    .order("agent_id", { ascending: true })
    .order("position", { ascending: true })
    .order("skill_name", { ascending: true });
  if (error) throw new Error(error.message);
  return (data as AgentSkillRow[]).map(toAgentSkill);
}

// Upsert on the composite key: assigning a skill and reordering an already-assigned one are
// the same write.
export async function setAgentSkill(
  client: SupabaseClient,
  input: AgentSkillInsert,
): Promise<AgentSkill> {
  const { data, error } = await client
    .from("project_agent_skills")
    .upsert(
      {
        project_id: input.projectId,
        agent_id: input.agentId,
        skill_name: input.skillName,
        position: input.position ?? 0,
      },
      { onConflict: "project_id,agent_id,skill_name" },
    )
    .select(AGENT_SKILL_COLUMNS)
    .single();
  if (error) throw new Error(error.message);
  return toAgentSkill(data as AgentSkillRow);
}

// A DELETE the owner-only USING clause filters out matches zero rows and reports NO error,
// so a member's refusal and an already-gone assignment would both look like success — while
// an unauthorized upsert raises 42501. `.select()` closes that asymmetry: the deleted rows
// come back, and an empty set is the refusal the editor must not treat as an unassignment.
export async function deleteAgentSkill(
  client: SupabaseClient,
  projectId: string,
  agentId: string,
  skillName: string,
): Promise<void> {
  const { data, error } = await client
    .from("project_agent_skills")
    .delete()
    .eq("project_id", projectId)
    .eq("agent_id", agentId)
    .eq("skill_name", skillName)
    .select(AGENT_SKILL_COLUMNS);
  if (error) throw new Error(error.message);
  if (!data || data.length === 0) {
    throw new Error(
      `skill "${skillName}" was not unassigned from agent "${agentId}": the delete was refused or the assignment is already gone`,
    );
  }
}
