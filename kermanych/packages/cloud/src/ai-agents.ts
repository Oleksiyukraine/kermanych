// Data access for the «ШІ-команда» agent instruction override (`ai_agents`). A MISSING row at
// every scope means «use the compile-time default from core's AGENTS registry», so there is no
// disable flag and no empty sentinel: deleteAiAgent IS the reset. Every call runs under the
// caller's JWT; RLS (read = scope member, write = scope owner) is the authorization surface.
import type { SupabaseClient } from "@supabase/supabase-js";
import type { AiAgent, AiAgentInsert, AiOwner } from "./types";
import { OWNER_COLUMNS, ownerColumn, ownerColumns, ownerConflict, rowOwner } from "./ai-scope";

// The audit columns ARE part of the surface: the Агенти pane says «перекрито» next to an
// overridden instruction, and that is the row's own provenance.
const AGENT_COLUMNS = `id, ${OWNER_COLUMNS}, agent_id, instruction, created_at, created_by, updated_at, updated_by`;

type AgentRow = {
  id: string;
  workspace_id: string | null;
  project_id: string | null;
  user_id: string | null;
  agent_id: string;
  instruction: string;
  created_at: string;
  // `on delete set null`: an override outlives the account that authored or last edited it.
  created_by: string | null;
  updated_at: string;
  updated_by: string | null;
};

export function toAiAgent(row: AgentRow): AiAgent {
  const a: AiAgent = {
    id: row.id,
    owner: rowOwner(row),
    agentId: row.agent_id,
    instruction: row.instruction,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
  if (row.created_by !== null) a.createdBy = row.created_by;
  if (row.updated_by !== null) a.updatedBy = row.updated_by;
  return a;
}

export async function listAiAgents(client: SupabaseClient, owner: AiOwner): Promise<AiAgent[]> {
  const { data, error } = await client
    .from("ai_agents")
    .select(AGENT_COLUMNS)
    .eq(ownerColumn(owner.scope), owner.id)
    .order("agent_id", { ascending: true });
  if (error) throw new Error(error.message);
  return (data as AgentRow[]).map(toAiAgent);
}

// Upsert on the owner-triad key: writing the first override and editing an existing one are
// the same write.
export async function upsertAiAgent(client: SupabaseClient, input: AiAgentInsert): Promise<AiAgent> {
  const { data, error } = await client
    .from("ai_agents")
    .upsert(
      {
        ...ownerColumns(input.owner),
        agent_id: input.agentId,
        // Not trimmed: an instruction is a template whose leading and trailing layout is the
        // operator's, and core renders it verbatim.
        instruction: input.instruction,
      },
      { onConflict: ownerConflict("agent_id") },
    )
    .select(AGENT_COLUMNS)
    .single();
  if (error) throw new Error(error.message);
  return toAiAgent(data as AgentRow);
}

// `.select()` for the same reason as deleteAiSkill: a refused DELETE and an already-default
// agent both match zero rows, so the empty set is the refusal the editor must not render as a
// completed reset.
export async function deleteAiAgent(client: SupabaseClient, owner: AiOwner, agentId: string): Promise<void> {
  const { data, error } = await client
    .from("ai_agents")
    .delete()
    .eq(ownerColumn(owner.scope), owner.id)
    .eq("agent_id", agentId)
    .select(AGENT_COLUMNS);
  if (error) throw new Error(error.message);
  if (!data || data.length === 0) {
    throw new Error(
      `the instruction of agent "${agentId}" was not reset: the delete was refused or the override is already gone`,
    );
  }
}
