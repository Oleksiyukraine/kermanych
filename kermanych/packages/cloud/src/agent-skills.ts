// Data access for «ШІ-команда» assignments: the ordered skill sequence a project hands to
// each of Kermanych's agents. Owns the snake_case <-> camelCase boundary for
// `project_agent_skills`. Every call runs under the caller's JWT: the RLS policies (read =
// project member, write = workspace owner) are the authorization surface, and refusals
// surface as thrown postgrest messages.
import type { SupabaseClient } from "@supabase/supabase-js";
import type { AgentSkill } from "./types";

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

/**
 * Replace an agent's whole skill sequence. `names` in order; empty clears it. The trigger
 * side of «ШІ-команда» is written the same way — see setTriggerSkills for why the two
 * statements are not a transaction and why the delete goes first.
 */
export async function setAgentSkills(
  client: SupabaseClient,
  projectId: string,
  agentId: string,
  names: readonly string[],
): Promise<void> {
  let del = client
    .from("project_agent_skills")
    .delete()
    .eq("project_id", projectId)
    .eq("agent_id", agentId);
  // The names survive the check regex, so none can contain a comma or a quote that would
  // break out of this filter list.
  if (names.length > 0) del = del.not("skill_name", "in", `(${names.join(",")})`);
  const { error: deleteError } = await del;
  if (deleteError) throw new Error(deleteError.message);

  if (names.length === 0) return;
  const { error } = await client.from("project_agent_skills").upsert(
    names.map((skillName, index) => ({
      project_id: projectId,
      agent_id: agentId,
      skill_name: skillName,
      position: index,
    })),
    { onConflict: "project_id,agent_id,skill_name" },
  );
  if (error) throw new Error(error.message);
}
