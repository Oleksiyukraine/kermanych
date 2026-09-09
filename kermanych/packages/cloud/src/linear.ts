// The Linear mirror's data access. This file owns the snake_case <-> camelCase boundary for
// every linear_* table: nothing outside @kermanych/cloud ever sees a Postgres column name.
// Every call runs under the caller's JWT — member RLS on the mirror tables and the
// owner-only policies on workspace_linear_integrations are the authorization surface.
//
// The WRITERS here are apps/api's LinearService (sync engine + action mirror-patches); the
// READERS are the UI's linear store and, for children, the ticket dialog. Linear itself is
// the source of truth: writes are wholesale upserts/replaces, never merges.
import type { RealtimeChannel, SupabaseClient } from "@supabase/supabase-js";
import type {
  LinearAttachment,
  LinearColumn,
  LinearComment,
  LinearIntegration,
  LinearIntegrationInsert,
  LinearIssue,
  LinearStatusCategory,
  LinearSyncState,
} from "./types";

const INTEGRATION_COLUMNS =
  "id, workspace_id, org_url_key, team_key, team_id, team_name, connected_by, created_at, updated_at";

const ISSUE_COLUMNS =
  "integration_id, workspace_id, issue_id, key, title, description_md, priority, priority_name, estimate, labels, assignee_id, assignee_name, assignee_avatar, state_id, state_name, state_category, parent_key, url, start_date, due_date, linear_updated_at, kermanych_project_id, task_id, updated_at";

type IntegrationRow = {
  id: string;
  workspace_id: string;
  org_url_key: string;
  team_key: string;
  team_id: string;
  team_name: string;
  connected_by: string | null;
  created_at: string;
  updated_at: string;
};

type SyncStateRow = {
  integration_id: string;
  workspace_id: string;
  last_synced_at: string | null;
  sync_cursor: string | null;
};

type ColumnRow = {
  integration_id: string;
  workspace_id: string;
  position: number;
  name: string;
  state_ids: string[];
};

type IssueRow = {
  integration_id: string;
  workspace_id: string;
  issue_id: string;
  key: string;
  title: string;
  description_md: string;
  priority: number;
  priority_name: string;
  estimate: number;
  labels: string[];
  assignee_id: string | null;
  assignee_name: string | null;
  assignee_avatar: string | null;
  state_id: string;
  state_name: string;
  state_category: string;
  parent_key: string | null;
  url: string;
  start_date: string;
  due_date: string;
  linear_updated_at: string;
  kermanych_project_id: string | null;
  task_id: string | null;
  updated_at: string;
};

type CommentRow = {
  integration_id: string;
  workspace_id: string;
  issue_id: string;
  comment_id: string;
  author_name: string;
  author_avatar: string;
  body_md: string;
  created_at: string;
  updated_at: string;
};

type AttachmentRow = {
  integration_id: string;
  workspace_id: string;
  issue_id: string;
  attachment_id: string;
  title: string;
  subtitle: string;
  url: string;
  created_at: string;
};

export function toLinearIntegration(row: IntegrationRow): LinearIntegration {
  const t: LinearIntegration = {
    id: row.id,
    workspaceId: row.workspace_id,
    orgUrlKey: row.org_url_key,
    teamKey: row.team_key,
    teamId: row.team_id,
    teamName: row.team_name,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
  if (row.connected_by !== null) t.connectedBy = row.connected_by;
  return t;
}

// Tolerant on the category: a value Linear invents later degrades to 'new' (renders in the
// board, refuses nothing) rather than crashing the mapper.
function toCategory(raw: string): LinearStatusCategory {
  return raw === "indeterminate" || raw === "done" ? raw : "new";
}

export function toLinearIssue(row: IssueRow): LinearIssue {
  const t: LinearIssue = {
    integrationId: row.integration_id,
    workspaceId: row.workspace_id,
    issueId: row.issue_id,
    key: row.key,
    title: row.title,
    descriptionMd: row.description_md,
    priority: row.priority ?? 0,
    priorityName: row.priority_name,
    estimate: row.estimate ?? 0,
    labels: row.labels ?? [],
    stateId: row.state_id,
    stateName: row.state_name,
    stateCategory: toCategory(row.state_category),
    url: row.url,
    startDate: row.start_date,
    dueDate: row.due_date,
    linearUpdatedAt: row.linear_updated_at,
    updatedAt: row.updated_at,
  };
  if (row.assignee_id !== null) t.assigneeId = row.assignee_id;
  if (row.assignee_name !== null) t.assigneeName = row.assignee_name;
  if (row.assignee_avatar !== null) t.assigneeAvatar = row.assignee_avatar;
  if (row.parent_key !== null) t.parentKey = row.parent_key;
  if (row.kermanych_project_id !== null) t.kermanychProjectId = row.kermanych_project_id;
  if (row.task_id !== null) t.taskId = row.task_id;
  return t;
}

// The sync engine's write shape: everything the mapper read from Linear, WITHOUT the launch
// binding — an upsert from a poll must never clobber kermanych_project_id/task_id that a
// launch on another machine just wrote. The binding travels only through
// patchLinearIssueBinding below.
export function toLinearIssueRow(issue: LinearIssue): Record<string, unknown> {
  return {
    integration_id: issue.integrationId,
    workspace_id: issue.workspaceId,
    issue_id: issue.issueId,
    key: issue.key,
    title: issue.title,
    description_md: issue.descriptionMd,
    priority: issue.priority,
    priority_name: issue.priorityName,
    estimate: issue.estimate,
    labels: issue.labels,
    assignee_id: issue.assigneeId ?? null,
    assignee_name: issue.assigneeName ?? null,
    assignee_avatar: issue.assigneeAvatar ?? null,
    state_id: issue.stateId,
    state_name: issue.stateName,
    state_category: issue.stateCategory,
    parent_key: issue.parentKey ?? null,
    url: issue.url,
    start_date: issue.startDate,
    due_date: issue.dueDate,
    linear_updated_at: issue.linearUpdatedAt,
    updated_at: new Date().toISOString(),
  };
}

function toLinearColumn(row: ColumnRow): LinearColumn {
  return {
    integrationId: row.integration_id,
    workspaceId: row.workspace_id,
    position: row.position,
    name: row.name,
    stateIds: row.state_ids ?? [],
  };
}

function toLinearComment(row: CommentRow): LinearComment {
  return {
    integrationId: row.integration_id,
    workspaceId: row.workspace_id,
    issueId: row.issue_id,
    commentId: row.comment_id,
    authorName: row.author_name,
    authorAvatar: row.author_avatar,
    bodyMd: row.body_md,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toLinearAttachment(row: AttachmentRow): LinearAttachment {
  return {
    integrationId: row.integration_id,
    workspaceId: row.workspace_id,
    issueId: row.issue_id,
    attachmentId: row.attachment_id,
    title: row.title,
    subtitle: row.subtitle,
    url: row.url,
    createdAt: row.created_at,
  };
}

// ── integration row ───────────────────────────────────────────────────────────

// `undefined` = the workspace has no integration OR the caller is not a member; both are
// «немає Linear» to a client.
export async function getLinearIntegration(
  client: SupabaseClient,
  workspaceId: string,
): Promise<LinearIntegration | undefined> {
  const { data, error } = await client
    .from("workspace_linear_integrations")
    .select(INTEGRATION_COLUMNS)
    .eq("workspace_id", workspaceId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data ? toLinearIntegration(data as IntegrationRow) : undefined;
}

// Upsert on workspace_id: connecting and re-pointing at another team are the same write.
// The touch trigger owns connected_by/timestamps; RLS makes this owner-only.
export async function upsertLinearIntegration(
  client: SupabaseClient,
  input: LinearIntegrationInsert,
): Promise<LinearIntegration> {
  const { data, error } = await client
    .from("workspace_linear_integrations")
    .upsert(
      {
        workspace_id: input.workspaceId,
        org_url_key: input.orgUrlKey.trim(),
        team_key: input.teamKey.trim(),
        team_id: input.teamId,
        team_name: input.teamName,
      },
      { onConflict: "workspace_id" },
    )
    .select(INTEGRATION_COLUMNS)
    .single();
  if (error) throw new Error(error.message);
  return toLinearIntegration(data as IntegrationRow);
}

// Cascade takes the whole mirror with it — columns, issues, children, sync state.
export async function deleteLinearIntegration(client: SupabaseClient, workspaceId: string): Promise<void> {
  const { error } = await client.from("workspace_linear_integrations").delete().eq("workspace_id", workspaceId);
  if (error) throw new Error(error.message);
}

// ── sync lease ────────────────────────────────────────────────────────────────

export async function getLinearSyncState(
  client: SupabaseClient,
  integrationId: string,
): Promise<LinearSyncState | undefined> {
  const { data, error } = await client
    .from("linear_sync_state")
    .select("integration_id, workspace_id, last_synced_at, sync_cursor")
    .eq("integration_id", integrationId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) return undefined;
  const row = data as SyncStateRow;
  const t: LinearSyncState = { integrationId: row.integration_id, workspaceId: row.workspace_id };
  if (row.last_synced_at !== null) t.lastSyncedAt = row.last_synced_at;
  if (row.sync_cursor !== null) t.syncCursor = row.sync_cursor;
  return t;
}

// First-sync bootstrap; a second call collides on the pk and is deliberately a no-op.
export async function ensureLinearSyncState(
  client: SupabaseClient,
  integrationId: string,
  workspaceId: string,
): Promise<void> {
  const { error } = await client
    .from("linear_sync_state")
    .upsert(
      { integration_id: integrationId, workspace_id: workspaceId },
      { onConflict: "integration_id", ignoreDuplicates: true },
    );
  if (error) throw new Error(error.message);
}

// The polling lease. A guarded UPDATE: only the caller who finds the stamp stale (or null)
// moves it, and postgrest reports the race loser as zero returned rows, not an error —
// exactly the claimTask() idiom. N open boards therefore cost ≈1 poller.
export async function takeLinearSyncLease(
  client: SupabaseClient,
  integrationId: string,
  staleMs: number,
): Promise<boolean> {
  const staleBefore = new Date(Date.now() - staleMs).toISOString();
  const { data, error } = await client
    .from("linear_sync_state")
    .update({ last_synced_at: new Date().toISOString() })
    .eq("integration_id", integrationId)
    .or(`last_synced_at.is.null,last_synced_at.lt.${staleBefore}`)
    .select("integration_id");
  if (error) throw new Error(error.message);
  return Array.isArray(data) && data.length > 0;
}

export async function advanceLinearSyncCursor(
  client: SupabaseClient,
  integrationId: string,
  cursor: string,
): Promise<void> {
  const { error } = await client
    .from("linear_sync_state")
    .update({ sync_cursor: cursor })
    .eq("integration_id", integrationId);
  if (error) throw new Error(error.message);
}

// ── columns ───────────────────────────────────────────────────────────────────

export async function listLinearColumns(client: SupabaseClient, integrationId: string): Promise<LinearColumn[]> {
  const { data, error } = await client
    .from("linear_columns")
    .select("integration_id, workspace_id, position, name, state_ids")
    .eq("integration_id", integrationId)
    .order("position", { ascending: true });
  if (error) throw new Error(error.message);
  return (data as ColumnRow[]).map(toLinearColumn);
}

// Wholesale replace — the layout is Linear's, so a changed board simply overwrites ours.
// Delete-then-insert rather than upsert: a team that LOST a state must lose the row.
export async function replaceLinearColumns(
  client: SupabaseClient,
  integrationId: string,
  workspaceId: string,
  columns: readonly { position: number; name: string; stateIds: string[] }[],
): Promise<void> {
  const del = await client.from("linear_columns").delete().eq("integration_id", integrationId);
  if (del.error) throw new Error(del.error.message);
  if (columns.length === 0) return;
  const { error } = await client.from("linear_columns").insert(
    columns.map((c) => ({
      integration_id: integrationId,
      workspace_id: workspaceId,
      position: c.position,
      name: c.name,
      state_ids: c.stateIds,
    })),
  );
  if (error) throw new Error(error.message);
}

// ── issues ────────────────────────────────────────────────────────────────────

export async function listLinearIssues(client: SupabaseClient, integrationId: string): Promise<LinearIssue[]> {
  const { data, error } = await client
    .from("linear_issues")
    .select(ISSUE_COLUMNS)
    .eq("integration_id", integrationId)
    .order("linear_updated_at", { ascending: false });
  if (error) throw new Error(error.message);
  return (data as IssueRow[]).map(toLinearIssue);
}

export async function upsertLinearIssues(client: SupabaseClient, issues: readonly LinearIssue[]): Promise<void> {
  if (issues.length === 0) return;
  const { error } = await client
    .from("linear_issues")
    .upsert(issues.map(toLinearIssueRow), { onConflict: "integration_id,issue_id" });
  if (error) throw new Error(error.message);
}

// Reconciliation's other half: the full sweep computes which mirrored ids Linear no longer
// returns and removes exactly those.
export async function deleteLinearIssues(
  client: SupabaseClient,
  integrationId: string,
  issueIds: readonly string[],
): Promise<void> {
  if (issueIds.length === 0) return;
  const { error } = await client
    .from("linear_issues")
    .delete()
    .eq("integration_id", integrationId)
    .in("issue_id", issueIds);
  if (error) throw new Error(error.message);
}

// The launch binding travels alone (see toLinearIssueRow). Explicit null clears a side.
export async function patchLinearIssueBinding(
  client: SupabaseClient,
  integrationId: string,
  issueId: string,
  binding: { kermanychProjectId?: string | null; taskId?: string | null },
): Promise<void> {
  const row: Record<string, unknown> = {};
  if (binding.kermanychProjectId !== undefined) row.kermanych_project_id = binding.kermanychProjectId;
  if (binding.taskId !== undefined) row.task_id = binding.taskId;
  const { error } = await client
    .from("linear_issues")
    .update(row)
    .eq("integration_id", integrationId)
    .eq("issue_id", issueId);
  if (error) throw new Error(error.message);
}

// ── issue children ────────────────────────────────────────────────────────────

export type LinearIssueChildren = {
  comments: LinearComment[];
  attachments: LinearAttachment[];
};

export async function listLinearIssueChildren(
  client: SupabaseClient,
  integrationId: string,
  issueId: string,
): Promise<LinearIssueChildren> {
  const [comments, attachments] = await Promise.all([
    client
      .from("linear_comments")
      .select("integration_id, workspace_id, issue_id, comment_id, author_name, author_avatar, body_md, created_at, updated_at")
      .eq("integration_id", integrationId)
      .eq("issue_id", issueId)
      .order("created_at", { ascending: true }),
    client
      .from("linear_attachments")
      .select("integration_id, workspace_id, issue_id, attachment_id, title, subtitle, url, created_at")
      .eq("integration_id", integrationId)
      .eq("issue_id", issueId)
      .order("created_at", { ascending: false }),
  ]);
  for (const r of [comments, attachments]) if (r.error) throw new Error(r.error.message);
  return {
    comments: (comments.data as CommentRow[]).map(toLinearComment),
    attachments: (attachments.data as AttachmentRow[]).map(toLinearAttachment),
  };
}

// One issue's children replaced wholesale — same reasoning as the columns: a comment
// deleted in Linear must vanish here, and per-child diffing would buy nothing at this size.
export async function replaceLinearIssueChildren(
  client: SupabaseClient,
  integrationId: string,
  workspaceId: string,
  issueId: string,
  children: {
    comments: readonly Omit<LinearComment, "integrationId" | "workspaceId" | "issueId">[];
    attachments: readonly Omit<LinearAttachment, "integrationId" | "workspaceId" | "issueId">[];
  },
): Promise<void> {
  const scope = { integration_id: integrationId, workspace_id: workspaceId, issue_id: issueId };
  const dels = await Promise.all([
    client.from("linear_comments").delete().eq("integration_id", integrationId).eq("issue_id", issueId),
    client.from("linear_attachments").delete().eq("integration_id", integrationId).eq("issue_id", issueId),
  ]);
  for (const d of dels) if (d.error) throw new Error(d.error.message);

  if (children.comments.length) {
    const { error } = await client.from("linear_comments").insert(
      children.comments.map((c) => ({
        ...scope,
        comment_id: c.commentId,
        author_name: c.authorName,
        author_avatar: c.authorAvatar,
        body_md: c.bodyMd,
        created_at: c.createdAt,
        updated_at: c.updatedAt,
      })),
    );
    if (error) throw new Error(error.message);
  }
  if (children.attachments.length) {
    const { error } = await client.from("linear_attachments").insert(
      children.attachments.map((a) => ({
        ...scope,
        attachment_id: a.attachmentId,
        title: a.title,
        subtitle: a.subtitle,
        url: a.url,
        created_at: a.createdAt,
      })),
    );
    if (error) throw new Error(error.message);
  }
}

// ── realtime ──────────────────────────────────────────────────────────────────
// The Linear board's live feed, the subscribeTasks() shape: one channel, one binding,
// registered before subscribe(). Only linear_issues is in the publication — columns are
// refetched on open, children on dialog open. DELETE arrives with the pk only (default
// replica identity), which is exactly enough to drop the card.
export type LinearIssueChange = { kind: "upsert"; issue: LinearIssue } | { kind: "delete"; issueId: string };

export function subscribeLinearIssues(
  client: SupabaseClient,
  integrationId: string,
  onChange: (change: LinearIssueChange) => void,
  onState?: (state: "SUBSCRIBED" | "TIMED_OUT" | "CLOSED" | "CHANNEL_ERROR") => void,
): () => void {
  const channel: RealtimeChannel = client.channel("kermanych-linear-issues");
  channel.on(
    "postgres_changes",
    { event: "*", schema: "public", table: "linear_issues", filter: `integration_id=eq.${integrationId}` },
    (payload) => {
      if (payload.eventType === "DELETE") {
        const id = (payload.old as { issue_id?: string }).issue_id;
        if (id) onChange({ kind: "delete", issueId: id });
        return;
      }
      onChange({ kind: "upsert", issue: toLinearIssue(payload.new as IssueRow) });
    },
  );
  channel.subscribe((status) => onState?.(status as "SUBSCRIBED" | "TIMED_OUT" | "CLOSED" | "CHANNEL_ERROR"));
  return () => {
    void client.removeChannel(channel);
  };
}
