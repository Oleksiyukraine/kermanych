// The Slack integration row's data access. This file owns the snake_case <-> camelCase
// boundary for workspace_slack_integrations: nothing outside @kermanych/cloud ever sees a
// Postgres column name. Every call runs under the caller's JWT — member select and the
// owner-only write policies are the authorization surface.
//
// The row carries addresses only (team, channel, bot user). The tokens that actually reach
// Slack live in each machine's registry SQLite; apps/api's SlackService reads this row to
// learn which channel to listen on for a workspace.
import type { SupabaseClient } from "@supabase/supabase-js";
import type { SlackIntegration, SlackIntegrationInsert } from "./types";

const INTEGRATION_COLUMNS =
  "id, workspace_id, team_id, team_name, channel_id, channel_name, bot_user_id, connected_by, created_at, updated_at";

type IntegrationRow = {
  id: string;
  workspace_id: string;
  team_id: string;
  team_name: string;
  channel_id: string;
  channel_name: string;
  bot_user_id: string;
  connected_by: string | null;
  created_at: string;
  updated_at: string;
};

export function toSlackIntegration(row: IntegrationRow): SlackIntegration {
  const t: SlackIntegration = {
    id: row.id,
    workspaceId: row.workspace_id,
    teamId: row.team_id,
    teamName: row.team_name,
    channelId: row.channel_id,
    channelName: row.channel_name,
    botUserId: row.bot_user_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
  if (row.connected_by !== null) t.connectedBy = row.connected_by;
  return t;
}

// `undefined` = the workspace has no integration OR the caller is not a member; both are
// «немає Slack» to a client.
export async function getSlackIntegration(
  client: SupabaseClient,
  workspaceId: string,
): Promise<SlackIntegration | undefined> {
  const { data, error } = await client
    .from("workspace_slack_integrations")
    .select(INTEGRATION_COLUMNS)
    .eq("workspace_id", workspaceId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data ? toSlackIntegration(data as IntegrationRow) : undefined;
}

// Upsert on workspace_id: connecting and re-pointing at another channel are the same write.
// The touch trigger owns connected_by/timestamps; RLS makes this owner-only. A channel
// already bound to another workspace fails on unique (team_id, channel_id) — surfaced as is.
export async function upsertSlackIntegration(
  client: SupabaseClient,
  input: SlackIntegrationInsert,
): Promise<SlackIntegration> {
  const { data, error } = await client
    .from("workspace_slack_integrations")
    .upsert(
      {
        workspace_id: input.workspaceId,
        team_id: input.teamId,
        team_name: input.teamName,
        channel_id: input.channelId,
        channel_name: input.channelName,
        bot_user_id: input.botUserId,
      },
      { onConflict: "workspace_id" },
    )
    .select(INTEGRATION_COLUMNS)
    .single();
  if (error) throw new Error(error.message);
  return toSlackIntegration(data as IntegrationRow);
}

// Only the binding goes; each member's local tokens are theirs to remove.
export async function deleteSlackIntegration(client: SupabaseClient, workspaceId: string): Promise<void> {
  const { error } = await client.from("workspace_slack_integrations").delete().eq("workspace_id", workspaceId);
  if (error) throw new Error(error.message);
}
