// Data access for workspace routines and their runs (20261016090000_workspace_routines.sql).
// Owns the snake_case <-> camelCase boundary for `workspace_routines` and
// `workspace_routine_runs`. Every call runs under the caller's JWT; RLS decides:
//   * any member reads and creates routines; the author or the workspace owner updates and
//     deletes them, and the touch trigger lets only the author change what one does;
//   * only the routine's author claims (inserts) a run, and only the runner finishes it.
import type { SupabaseClient } from "@supabase/supabase-js";
import type { RoutineAction, RoutineRunStatus, RoutineRunTrigger, RoutineSchedule, RoutineSlackTarget } from "@kermanych/core";
import type {
  WorkspaceRoutine,
  WorkspaceRoutineInsert,
  WorkspaceRoutinePatch,
  WorkspaceRoutineRun,
  WorkspaceRoutineRunClaim,
  WorkspaceRoutineRunResult,
} from "./types";

// One string literal each: postgrest-js parses these at the type level.
const ROUTINE_COLUMNS =
  "id, workspace_id, project_id, name, action, schedule, timezone, slack, enabled, armed_at, created_at, created_by, updated_at, updated_by";
const RUN_COLUMNS =
  "id, routine_id, workspace_id, trigger, scheduled_for, status, started_at, finished_at, run_by, note_id, task_id, commit_count, output_md, slack_channel_name, error_code, error_message, error_params";

type RoutineRow = {
  id: string;
  workspace_id: string;
  project_id: string | null;
  name: string;
  action: RoutineAction;
  schedule: RoutineSchedule;
  timezone: string;
  slack: RoutineSlackTarget | null;
  enabled: boolean;
  armed_at: string;
  created_at: string;
  created_by: string | null;
  updated_at: string;
  updated_by: string | null;
};

type RunRow = {
  id: string;
  routine_id: string;
  workspace_id: string;
  trigger: RoutineRunTrigger;
  scheduled_for: string | null;
  status: RoutineRunStatus;
  started_at: string;
  finished_at: string | null;
  run_by: string | null;
  note_id: string | null;
  task_id: string | null;
  commit_count: number | null;
  output_md: string | null;
  slack_channel_name: string | null;
  error_code: string | null;
  error_message: string | null;
  error_params: Record<string, string | number> | null;
};

export function toWorkspaceRoutine(row: RoutineRow): WorkspaceRoutine {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    ...(row.project_id === null ? {} : { projectId: row.project_id }),
    name: row.name,
    action: row.action,
    schedule: row.schedule,
    timezone: row.timezone,
    ...(row.slack === null ? {} : { slack: row.slack }),
    enabled: row.enabled,
    armedAt: row.armed_at,
    createdAt: row.created_at,
    ...(row.created_by === null ? {} : { createdBy: row.created_by }),
    updatedAt: row.updated_at,
    ...(row.updated_by === null ? {} : { updatedBy: row.updated_by }),
  };
}

export function toWorkspaceRoutineRun(row: RunRow): WorkspaceRoutineRun {
  return {
    id: row.id,
    routineId: row.routine_id,
    workspaceId: row.workspace_id,
    trigger: row.trigger,
    ...(row.scheduled_for === null ? {} : { scheduledFor: row.scheduled_for }),
    status: row.status,
    startedAt: row.started_at,
    ...(row.finished_at === null ? {} : { finishedAt: row.finished_at }),
    ...(row.run_by === null ? {} : { runBy: row.run_by }),
    ...(row.note_id === null ? {} : { noteId: row.note_id }),
    ...(row.task_id === null ? {} : { taskId: row.task_id }),
    ...(row.commit_count === null ? {} : { commitCount: row.commit_count }),
    ...(row.output_md === null ? {} : { outputMd: row.output_md }),
    ...(row.slack_channel_name === null ? {} : { slackChannelName: row.slack_channel_name }),
    ...(row.error_code === null ? {} : { errorCode: row.error_code }),
    ...(row.error_message === null ? {} : { errorMessage: row.error_message }),
    ...(row.error_params === null ? {} : { errorParams: row.error_params }),
  };
}

// ── routines ──────────────────────────────────────────────────────────────────

export async function listWorkspaceRoutines(client: SupabaseClient, workspaceId: string): Promise<WorkspaceRoutine[]> {
  const { data, error } = await client
    .from("workspace_routines")
    .select(ROUTINE_COLUMNS)
    .eq("workspace_id", workspaceId)
    .order("created_at", { ascending: true });
  if (error) throw new Error(error.message);
  return (data as RoutineRow[]).map(toWorkspaceRoutine);
}

// What the runner of THIS machine may fire: the signed-in member's own enabled routines, in
// every workspace they belong to.
export async function listRunnableRoutines(client: SupabaseClient, userId: string): Promise<WorkspaceRoutine[]> {
  const { data, error } = await client
    .from("workspace_routines")
    .select(ROUTINE_COLUMNS)
    .eq("created_by", userId)
    .eq("enabled", true);
  if (error) throw new Error(error.message);
  return (data as RoutineRow[]).map(toWorkspaceRoutine);
}

// `undefined` when it does not exist or the caller cannot read it.
export async function getWorkspaceRoutine(client: SupabaseClient, id: string): Promise<WorkspaceRoutine | undefined> {
  const { data, error } = await client.from("workspace_routines").select(ROUTINE_COLUMNS).eq("id", id).maybeSingle();
  if (error) throw new Error(error.message);
  return data ? toWorkspaceRoutine(data as RoutineRow) : undefined;
}

export async function createWorkspaceRoutine(client: SupabaseClient, input: WorkspaceRoutineInsert): Promise<WorkspaceRoutine> {
  const { data, error } = await client
    .from("workspace_routines")
    .insert({
      workspace_id: input.workspaceId,
      project_id: input.projectId ?? null,
      name: input.name,
      action: input.action,
      schedule: input.schedule,
      timezone: input.timezone,
      slack: input.slack ?? null,
      ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
    })
    .select(ROUTINE_COLUMNS)
    .single();
  if (error) throw new Error(error.message);
  return toWorkspaceRoutine(data as RoutineRow);
}

export async function patchWorkspaceRoutine(
  client: SupabaseClient,
  id: string,
  patch: WorkspaceRoutinePatch,
): Promise<WorkspaceRoutine> {
  const { data, error } = await client
    .from("workspace_routines")
    .update({
      ...(patch.name === undefined ? {} : { name: patch.name }),
      ...(patch.action === undefined ? {} : { action: patch.action }),
      ...(patch.schedule === undefined ? {} : { schedule: patch.schedule }),
      ...(patch.timezone === undefined ? {} : { timezone: patch.timezone }),
      ...(patch.slack === undefined ? {} : { slack: patch.slack }),
      ...(patch.enabled === undefined ? {} : { enabled: patch.enabled }),
    })
    .eq("id", id)
    .select(ROUTINE_COLUMNS)
    .single();
  if (error) throw new Error(error.message);
  return toWorkspaceRoutine(data as RoutineRow);
}

// A refused delete matches zero rows and is NOT an error to PostgREST, so the deleted ids are
// read back and an empty answer is reported as the refusal it is.
export async function deleteWorkspaceRoutine(client: SupabaseClient, id: string): Promise<void> {
  const { data, error } = await client.from("workspace_routines").delete().eq("id", id).select("id");
  if (error) throw new Error(error.message);
  if (!data || data.length === 0) throw new Error("the routine was not deleted: only its author or the workspace owner can delete it");
}

// ── runs ──────────────────────────────────────────────────────────────────────

// The workspace's history, newest first. Bounded: the screen shows recent runs, and a routine
// firing hourly would otherwise grow the read without limit.
export async function listWorkspaceRoutineRuns(
  client: SupabaseClient,
  workspaceId: string,
  limit = 200,
): Promise<WorkspaceRoutineRun[]> {
  const { data, error } = await client
    .from("workspace_routine_runs")
    .select(RUN_COLUMNS)
    .eq("workspace_id", workspaceId)
    .order("started_at", { ascending: false })
    .limit(limit);
  if (error) throw new Error(error.message);
  return (data as RunRow[]).map(toWorkspaceRoutineRun);
}

// Claim a run by inserting it. `undefined` means the occurrence is already claimed — by this
// machine before a restart, or by the author's other computer — which is the unique constraint
// doing its job, not a failure.
export async function claimRoutineRun(
  client: SupabaseClient,
  claim: WorkspaceRoutineRunClaim,
): Promise<WorkspaceRoutineRun | undefined> {
  const status = claim.status ?? "running";
  const { data, error } = await client
    .from("workspace_routine_runs")
    .insert({
      routine_id: claim.routineId,
      trigger: claim.trigger,
      scheduled_for: claim.scheduledFor ?? null,
      status,
      ...(status === "running" ? {} : { finished_at: new Date().toISOString() }),
      error_code: claim.errorCode ?? null,
      error_message: claim.errorMessage ?? null,
    })
    .select(RUN_COLUMNS)
    .single();
  if (error) {
    if (error.code === "23505") return undefined;
    throw new Error(error.message);
  }
  return toWorkspaceRoutineRun(data as RunRow);
}

export async function finishRoutineRun(
  client: SupabaseClient,
  id: string,
  result: WorkspaceRoutineRunResult,
): Promise<WorkspaceRoutineRun> {
  const { data, error } = await client
    .from("workspace_routine_runs")
    .update({
      status: result.status,
      finished_at: new Date().toISOString(),
      note_id: result.noteId ?? null,
      task_id: result.taskId ?? null,
      commit_count: result.commitCount ?? null,
      output_md: result.outputMd ?? null,
      slack_channel_name: result.slackChannelName ?? null,
      error_code: result.errorCode ?? null,
      error_message: result.errorMessage ?? null,
      error_params: result.errorParams ?? null,
    })
    .eq("id", id)
    .select(RUN_COLUMNS)
    .single();
  if (error) throw new Error(error.message);
  return toWorkspaceRoutineRun(data as RunRow);
}
