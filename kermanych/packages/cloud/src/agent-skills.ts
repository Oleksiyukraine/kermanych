// Data access for «ШІ-команда» agent skill sequences (`ai_agent_skills`): the ordered skills
// an owner hands to each of Kermanych's agents. Independent of ai_agents — a scope can give an
// agent a sequence without overriding its instruction. Every call runs under the caller's JWT;
// RLS (read = scope member, write = scope owner) is the authorization surface.
import type { SupabaseClient } from "@supabase/supabase-js";
import type { AiAgentSkill, AiOwner } from "./types";
import { OWNER_COLUMNS, ownerColumn, ownerColumns, rowOwner } from "./ai-scope";

// The audit columns are deliberately absent: they exist so a write cannot be forged, and
// nothing renders them for an assignment.
const AGENT_SKILL_COLUMNS = `${OWNER_COLUMNS}, agent_id, skill_name, position`;

type AgentSkillRow = {
  workspace_id: string | null;
  project_id: string | null;
  user_id: string | null;
  agent_id: string;
  skill_name: string;
  position: number;
};

export function toAiAgentSkill(row: AgentSkillRow): AiAgentSkill {
  return {
    owner: rowOwner(row),
    agentId: row.agent_id,
    skillName: row.skill_name,
    position: row.position,
  };
}

export async function listAiAgentSkills(client: SupabaseClient, owner: AiOwner): Promise<AiAgentSkill[]> {
  const { data, error } = await client
    .from("ai_agent_skills")
    .select(AGENT_SKILL_COLUMNS)
    .eq(ownerColumn(owner.scope), owner.id)
    // `position` first within an agent: the order the launcher writes the skills in;
    // `skill_name` only breaks a tie so the list never reorders between reads.
    .order("agent_id", { ascending: true })
    .order("position", { ascending: true })
    .order("skill_name", { ascending: true });
  if (error) throw new Error(error.message);
  return (data as AgentSkillRow[]).map(toAiAgentSkill);
}

/**
 * Replace an agent's whole skill sequence at one owner's scope. `names` in order; empty clears
 * it. Delete-then-insert rather than upsert: the sequence is a replace, and clearing the old
 * rows first means a shrunk list leaves no stragglers behind.
 */
export async function setAiAgentSkills(
  client: SupabaseClient,
  owner: AiOwner,
  agentId: string,
  names: readonly string[],
): Promise<void> {
  const { error: deleteError } = await client
    .from("ai_agent_skills")
    .delete()
    .eq(ownerColumn(owner.scope), owner.id)
    .eq("agent_id", agentId);
  if (deleteError) throw new Error(deleteError.message);

  if (names.length === 0) return;
  const cols = ownerColumns(owner);
  const { error } = await client.from("ai_agent_skills").insert(
    names.map((skillName, index) => ({
      ...cols,
      agent_id: agentId,
      skill_name: skillName,
      position: index,
    })),
  );
  if (error) throw new Error(error.message);
}
