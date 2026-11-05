// packages/cloud/src/skill-improvements.ts
// The history of skill self-improvement (docs/specs/2026-11-04-skill-self-improvement.md): one
// `skill_improvements` row per change an agent made to the operator's personal layer. Owner-only
// (RLS), the newest 100 per user kept by the table's insert trigger.
//
// Egress is the hosted project's scarce resource (docs/specs/2026-11-03-board-egress-and-lag.md),
// so the list and the Realtime binding carry the light columns only; the skill's text
// (`before_body`, `edits`) is read for one record when an entry is opened or a rollback planned.
import type { RealtimeChannel, SupabaseClient } from "@supabase/supabase-js";
import {
  SKILL_IMPROVEMENTS_KEEP,
  isSkillImprovementState,
  isSkillTeamScope,
  parseSkillEdits,
  type SkillImprovement,
  type SkillImprovementEntry,
  type SkillImprovementInsert,
  type SkillImprovementState,
} from "@kermanych/core";

const ENTRY_COLUMNS = "id, skill_name, summary, session_name, project_id, workspace_id, state, seen_at, created_at";
const RECORD_COLUMNS = `${ENTRY_COLUMNS}, user_id, session_id, reason, before_body, edits, created_copy, team_scope, team_owner_id, state_at`;
// The Realtime binding's `select` takes the same list as an array.
const ENTRY_COLUMN_NAMES = ENTRY_COLUMNS.split(", ");

type EntryRow = {
  id: string;
  skill_name: string;
  summary: string;
  session_name: string;
  project_id: string | null;
  workspace_id: string | null;
  state: string;
  seen_at: string | null;
  created_at: string;
};

type RecordRow = EntryRow & {
  user_id: string;
  session_id: string;
  reason: string;
  before_body: string;
  edits: unknown;
  created_copy: boolean;
  team_scope: string;
  team_owner_id: string | null;
  state_at: string;
};

/** A row → an entry; undefined for a state this build does not know (a newer client wrote it). */
export function toSkillImprovementEntry(row: EntryRow): SkillImprovementEntry | undefined {
  if (!isSkillImprovementState(row.state)) return undefined;
  return {
    id: row.id,
    skillName: row.skill_name,
    summary: row.summary,
    sessionName: row.session_name,
    ...(row.project_id ? { projectId: row.project_id } : {}),
    ...(row.workspace_id ? { workspaceId: row.workspace_id } : {}),
    state: row.state,
    ...(row.seen_at ? { seenAt: row.seen_at } : {}),
    createdAt: row.created_at,
  };
}

/** A full row → the record; undefined when its state, scope or edits are not ones this build reads. */
export function toSkillImprovement(row: RecordRow): SkillImprovement | undefined {
  const entry = toSkillImprovementEntry(row);
  const edits = parseSkillEdits(row.edits);
  if (!entry || !edits || !isSkillTeamScope(row.team_scope)) return undefined;
  return {
    ...entry,
    userId: row.user_id,
    sessionId: row.session_id,
    reason: row.reason,
    beforeBody: row.before_body,
    edits,
    createdCopy: row.created_copy,
    teamScope: row.team_scope,
    ...(row.team_owner_id ? { teamOwnerId: row.team_owner_id } : {}),
    stateAt: row.state_at,
  };
}

/** Record one change; answers its id. Nothing else comes back: the text was just sent. */
export async function insertSkillImprovement(client: SupabaseClient, input: SkillImprovementInsert): Promise<string> {
  const { data, error } = await client
    .from("skill_improvements")
    .insert({
      user_id: input.userId,
      skill_name: input.skillName,
      team_scope: input.teamScope,
      team_owner_id: input.teamOwnerId ?? null,
      created_copy: input.createdCopy,
      before_body: input.beforeBody,
      edits: input.edits,
      summary: input.summary,
      reason: input.reason,
      session_id: input.sessionId,
      session_name: input.sessionName,
      project_id: input.projectId ?? null,
      workspace_id: input.workspaceId ?? null,
    })
    .select("id")
    .single();
  if (error) throw new Error(error.message);
  const id: unknown = data?.id;
  if (typeof id !== "string") throw new Error("skill_improvements insert returned no id");
  return id;
}

/** How many changes one session has made — the per-session cap the tool enforces. */
export async function countSessionSkillImprovements(client: SupabaseClient, userId: string, sessionId: string): Promise<number> {
  const { count, error } = await client
    .from("skill_improvements")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId)
    .eq("session_id", sessionId);
  if (error) throw new Error(error.message);
  return count ?? 0;
}

/** The column: the caller's newest records, light columns only. RLS scopes it to the caller. */
export async function listSkillImprovementEntries(client: SupabaseClient, limit = SKILL_IMPROVEMENTS_KEEP): Promise<SkillImprovementEntry[]> {
  const { data, error } = await client
    .from("skill_improvements")
    .select(ENTRY_COLUMNS)
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(limit);
  if (error) throw new Error(error.message);
  return (data as EntryRow[]).flatMap((r) => toSkillImprovementEntry(r) ?? []);
}

/** One whole record, read when its entry is opened. */
export async function getSkillImprovement(client: SupabaseClient, id: string): Promise<SkillImprovement | undefined> {
  const { data, error } = await client.from("skill_improvements").select(RECORD_COLUMNS).eq("id", id).maybeSingle();
  if (error) throw new Error(error.message);
  return data ? toSkillImprovement(data as RecordRow) : undefined;
}

/** Every applied record of one skill, oldest first: the chain a rollback or a share acts on. */
export async function listAppliedSkillImprovements(client: SupabaseClient, skillName: string): Promise<SkillImprovement[]> {
  const { data, error } = await client
    .from("skill_improvements")
    .select(RECORD_COLUMNS)
    .eq("skill_name", skillName)
    .eq("state", "applied")
    .order("created_at", { ascending: true });
  if (error) throw new Error(error.message);
  return (data as RecordRow[]).flatMap((r) => toSkillImprovement(r) ?? []);
}

export async function setSkillImprovementState(
  client: SupabaseClient,
  ids: readonly string[],
  state: SkillImprovementState,
): Promise<void> {
  if (ids.length === 0) return;
  const { error } = await client
    .from("skill_improvements")
    .update({ state, state_at: new Date().toISOString() })
    .in("id", [...ids]);
  if (error) throw new Error(error.message);
}

/** Mark records seen. Only unseen rows are touched, so a record keeps the moment it was first opened. */
export async function markSkillImprovementsSeen(client: SupabaseClient, ids: readonly string[]): Promise<void> {
  if (ids.length === 0) return;
  const { error } = await client
    .from("skill_improvements")
    .update({ seen_at: new Date().toISOString() })
    .in("id", [...ids])
    .is("seen_at", null);
  if (error) throw new Error(error.message);
}

export type SkillImprovementChange = { kind: "insert" | "update"; entry: SkillImprovementEntry };
export type SkillImprovementChannelState = "SUBSCRIBED" | "TIMED_OUT" | "CLOSED" | "CHANNEL_ERROR";

/**
 * The caller's new and changed records, on every machine where their Kermanych is open: a change
 * an agent made on another machine raises the toast here too. Light columns only (`select`). A
 * filtered binding never carries DELETE (see subscribeTasks), so a record the insert trigger
 * prunes stays in a list until it is read again — the list is capped by the caller.
 */
export function subscribeSkillImprovements(
  client: SupabaseClient,
  userId: string,
  onChange: (change: SkillImprovementChange) => void,
  onState?: (state: SkillImprovementChannelState) => void,
): () => void {
  const channel: RealtimeChannel = client.channel("kermanych-skill-improvements");
  // One binding, registered before subscribe(), for the reasons subscribeTasks gives.
  channel.on(
    "postgres_changes",
    { event: "*", schema: "public", table: "skill_improvements", select: ENTRY_COLUMN_NAMES, filter: `user_id=eq.${userId}` },
    (payload) => {
      if (payload.eventType !== "INSERT" && payload.eventType !== "UPDATE") return;
      const entry = toSkillImprovementEntry(payload.new as EntryRow);
      if (entry) onChange({ kind: payload.eventType === "INSERT" ? "insert" : "update", entry });
    },
  );
  // A refused binding answers SUBSCRIBED and reports the refusal only as a system message.
  channel.on("system", {}, (p: { extension?: string; status?: string }) => {
    if (p.extension === "postgres_changes" && p.status === "error") onState?.("CHANNEL_ERROR");
  });
  channel.subscribe((status) => onState?.(status as SkillImprovementChannelState));
  return () => {
    void client.removeChannel(channel);
  };
}
