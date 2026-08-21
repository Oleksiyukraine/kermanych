// The shared task board's data access. This file owns the snake_case <-> camelCase boundary
// for `tasks`: nothing outside @kermanych/cloud ever sees a Postgres column name. Every
// call runs under the caller's JWT, so the RLS policies and tasks_guard() — not this code —
// are the authorization surface; refusals surface as thrown postgrest messages.
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Task, TaskInsert, TaskPatch, TaskStatus } from "./types";

const TASK_COLUMNS =
  "id, project_id, title, description, status, assignee_id, created_by, model, prefix, platform, kind, branch, created_at, updated_at";

type TaskRow = {
  id: string;
  project_id: string;
  title: string;
  description: string | null;
  status: TaskStatus;
  assignee_id: string | null;
  // `on delete set null`: a task outlives the account that filed it.
  created_by: string | null;
  model: string | null;
  prefix: string | null;
  platform: string | null;
  kind: string | null;
  branch: string | null;
  created_at: string;
  updated_at: string;
};

export function toTask(row: TaskRow): Task {
  const t: Task = {
    id: row.id,
    projectId: row.project_id,
    title: row.title,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
  // Optional keys are omitted rather than set to undefined, so a mapped task deep-equals a
  // hand-written literal in tests and carries no null noise into Vue's reactivity.
  if (row.description !== null) t.description = row.description;
  if (row.assignee_id !== null) t.assigneeId = row.assignee_id;
  if (row.created_by !== null) t.createdBy = row.created_by;
  if (row.model !== null) t.model = row.model;
  if (row.prefix !== null) t.prefix = row.prefix;
  if (row.platform !== null) t.platform = row.platform;
  if (row.kind !== null) t.kind = row.kind;
  if (row.branch !== null) t.branch = row.branch;
  return t;
}

// Only the keys actually present in the patch are sent, so a partial edit never nulls a
// column the user did not touch. An empty text value means "clear it" -> NULL; an explicit
// `assigneeId: null` is the "unassign" signal and must survive as a real null.
export function toTaskRow(patch: TaskPatch): Record<string, unknown> {
  const row: Record<string, unknown> = {};
  if (patch.title !== undefined) row.title = patch.title.trim();
  if (patch.description !== undefined) row.description = patch.description.trim() || null;
  if (patch.assigneeId !== undefined) row.assignee_id = patch.assigneeId;
  if (patch.model !== undefined) row.model = patch.model.trim() || null;
  if (patch.prefix !== undefined) row.prefix = patch.prefix.trim() || null;
  if (patch.platform !== undefined) row.platform = patch.platform.trim() || null;
  if (patch.kind !== undefined) row.kind = patch.kind.trim() || null;
  if (patch.branch !== undefined) row.branch = patch.branch.trim() || null;
  return row;
}

export async function listTasks(client: SupabaseClient, projectIds: string[]): Promise<Task[]> {
  // `in.()` with an empty list is not valid postgrest syntax, and there is nothing to ask
  // for anyway: a member of no project sees no tasks.
  if (projectIds.length === 0) return [];
  const { data, error } = await client
    .from("tasks")
    .select(TASK_COLUMNS)
    .in("project_id", projectIds)
    .order("created_at", { ascending: true });
  if (error) throw new Error(error.message);
  return (data as TaskRow[]).map(toTask);
}

// `undefined` means "no row this caller may see" — either the id does not exist or the
// tasks SELECT policy filtered it out. Both are the same thing to a client.
export async function getTask(client: SupabaseClient, id: string): Promise<Task | undefined> {
  const { data, error } = await client.from("tasks").select(TASK_COLUMNS).eq("id", id).maybeSingle();
  if (error) throw new Error(error.message);
  return data ? toTask(data as TaskRow) : undefined;
}

export async function createTask(
  client: SupabaseClient,
  input: TaskInsert & { createdBy: string },
): Promise<Task> {
  const title = input.title.trim();
  if (!title) throw new Error("task title is required");
  // `created_by` must equal auth.uid() or the tasks INSERT policy refuses the row. The
  // caller passes the signed-in user's id instead of this file reading a session, because
  // apps/api builds a per-request client with `persistSession: false` and has no session.
  // `status` is deliberately absent: the column defaults to 'backlog'.
  const row: Record<string, unknown> = {
    project_id: input.projectId,
    created_by: input.createdBy,
    title,
    ...toTaskRow({
      description: input.description,
      assigneeId: input.assigneeId,
      model: input.model,
      prefix: input.prefix,
      platform: input.platform,
      kind: input.kind,
      branch: input.branch,
    }),
  };
  const { data, error } = await client.from("tasks").insert(row).select(TASK_COLUMNS).single();
  if (error) throw new Error(error.message);
  return toTask(data as TaskRow);
}

export async function patchTask(client: SupabaseClient, id: string, patch: TaskPatch): Promise<Task> {
  const { data, error } = await client
    .from("tasks")
    .update(toTaskRow(patch))
    .eq("id", id)
    .select(TASK_COLUMNS)
    .single();
  if (error) throw new Error(error.message);
  return toTask(data as TaskRow);
}

// Assignment has its own name because it is the one edit tasks_guard refuses on an active
// task (message `task is active`); a dedicated call keeps that refusal legible at the call
// site. `null` clears the assignment.
export function assignTask(client: SupabaseClient, id: string, assigneeId: string | null): Promise<Task> {
  return patchTask(client, id, { assigneeId });
}

// Atomic self-assign: one `UPDATE tasks SET assignee_id = $1 WHERE id = $2 AND assignee_id
// IS NULL`. Zero matched rows come back as `{ data: null, error: null }` — that is what
// maybeSingle means — and it is the "someone else claimed it first" signal, NOT an error.
export async function claimTask(
  client: SupabaseClient,
  id: string,
  userId: string,
): Promise<Task | undefined> {
  const { data, error } = await client
    .from("tasks")
    .update({ assignee_id: userId })
    .eq("id", id)
    .is("assignee_id", null)
    .select(TASK_COLUMNS)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data ? toTask(data as TaskRow) : undefined;
}

// Local -> cloud status mirror, called by apps/api's CloudSyncService under the user's JWT
// (Plan D). `updated_at` travels with the push even though tasks_guard overwrites it with
// now() on every UPDATE: the outbox row carries the moment the LOCAL session actually
// changed, so the payload stays self-describing and the retry is idempotent.
export async function pushTaskStatus(
  client: SupabaseClient,
  id: string,
  status: TaskStatus,
  updatedAt: string,
): Promise<void> {
  const { error } = await client.from("tasks").update({ status, updated_at: updatedAt }).eq("id", id);
  if (error) throw new Error(error.message);
}

// tasks_guard refuses a delete while old.status is active (`task is active`), which is the
// other half of Requirement 8.
export async function deleteTask(client: SupabaseClient, id: string): Promise<void> {
  const { error } = await client.from("tasks").delete().eq("id", id);
  if (error) throw new Error(error.message);
}
