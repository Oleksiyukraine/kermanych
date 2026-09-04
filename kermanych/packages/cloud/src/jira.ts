// The Jira mirror's data access. This file owns the snake_case <-> camelCase boundary for
// every jira_* table: nothing outside @kermanych/cloud ever sees a Postgres column name.
// Every call runs under the caller's JWT — member RLS on the mirror tables and the
// owner-only policies on workspace_jira_integrations are the authorization surface.
//
// The WRITERS here are apps/api's JiraService (sync engine + action mirror-patches); the
// READERS are the UI's jira store and, for children, the ticket dialog. Jira itself is the
// source of truth: writes are wholesale upserts/replaces, never merges.
import type { RealtimeChannel, SupabaseClient } from "@supabase/supabase-js";
import type {
  JiraAttachment,
  JiraColumn,
  JiraComment,
  JiraIntegration,
  JiraIntegrationInsert,
  JiraIssue,
  JiraStatusCategory,
  JiraSyncState,
  JiraWorklog,
} from "./types";

const INTEGRATION_COLUMNS =
  "id, workspace_id, site_url, jira_project_key, board_id, board_name, connected_by, created_at, updated_at";

const ISSUE_COLUMNS =
  "integration_id, workspace_id, issue_id, key, summary, description_html, type_name, type_icon, priority_name, priority_icon, labels, original_estimate, time_spent, remaining_estimate, original_estimate_seconds, time_spent_seconds, remaining_estimate_seconds, start_date, due_date, assignee_account_id, assignee_name, assignee_avatar, reporter_name, status_id, status_name, status_category, parent_key, jira_updated_at, kermanych_project_id, task_id, updated_at";

type IntegrationRow = {
  id: string;
  workspace_id: string;
  site_url: string;
  jira_project_key: string;
  board_id: number;
  board_name: string;
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
  status_ids: string[];
};

type IssueRow = {
  integration_id: string;
  workspace_id: string;
  issue_id: string;
  key: string;
  summary: string;
  description_html: string;
  type_name: string;
  type_icon: string;
  priority_name: string;
  priority_icon: string;
  labels: string[];
  original_estimate: string;
  time_spent: string;
  remaining_estimate: string;
  original_estimate_seconds: number;
  time_spent_seconds: number;
  remaining_estimate_seconds: number;
  start_date: string;
  due_date: string;
  assignee_account_id: string | null;
  assignee_name: string | null;
  assignee_avatar: string | null;
  reporter_name: string | null;
  status_id: string;
  status_name: string;
  status_category: string;
  parent_key: string | null;
  jira_updated_at: string;
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
  body_html: string;
  jira_created_at: string;
  jira_updated_at: string;
};

type WorklogRow = {
  integration_id: string;
  workspace_id: string;
  issue_id: string;
  worklog_id: string;
  author_account_id: string;
  author_name: string;
  author_avatar: string;
  time_spent: string;
  seconds: number;
  started_at: string;
  comment_html: string;
};

type AttachmentRow = {
  integration_id: string;
  workspace_id: string;
  issue_id: string;
  attachment_id: string;
  filename: string;
  mime: string;
  size: number;
  author_name: string;
  jira_created_at: string;
};

export function toJiraIntegration(row: IntegrationRow): JiraIntegration {
  const t: JiraIntegration = {
    id: row.id,
    workspaceId: row.workspace_id,
    siteUrl: row.site_url,
    projectKey: row.jira_project_key,
    boardId: row.board_id,
    boardName: row.board_name,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
  if (row.connected_by !== null) t.connectedBy = row.connected_by;
  return t;
}

// Tolerant on the category: a value Jira invents later degrades to 'new' (renders in the
// board, refuses nothing) rather than crashing the mapper.
function toCategory(raw: string): JiraStatusCategory {
  return raw === "indeterminate" || raw === "done" ? raw : "new";
}

export function toJiraIssue(row: IssueRow): JiraIssue {
  const t: JiraIssue = {
    integrationId: row.integration_id,
    workspaceId: row.workspace_id,
    issueId: row.issue_id,
    key: row.key,
    summary: row.summary,
    descriptionHtml: row.description_html,
    typeName: row.type_name,
    typeIcon: row.type_icon,
    priorityName: row.priority_name,
    priorityIcon: row.priority_icon,
    labels: row.labels ?? [],
    originalEstimate: row.original_estimate,
    timeSpent: row.time_spent,
    remainingEstimate: row.remaining_estimate,
    originalEstimateSeconds: row.original_estimate_seconds ?? 0,
    timeSpentSeconds: row.time_spent_seconds ?? 0,
    remainingEstimateSeconds: row.remaining_estimate_seconds ?? 0,
    startDate: row.start_date,
    dueDate: row.due_date,
    statusId: row.status_id,
    statusName: row.status_name,
    statusCategory: toCategory(row.status_category),
    jiraUpdatedAt: row.jira_updated_at,
    updatedAt: row.updated_at,
  };
  if (row.assignee_account_id !== null) t.assigneeAccountId = row.assignee_account_id;
  if (row.assignee_name !== null) t.assigneeName = row.assignee_name;
  if (row.assignee_avatar !== null) t.assigneeAvatar = row.assignee_avatar;
  if (row.reporter_name !== null) t.reporterName = row.reporter_name;
  if (row.parent_key !== null) t.parentKey = row.parent_key;
  if (row.kermanych_project_id !== null) t.kermanychProjectId = row.kermanych_project_id;
  if (row.task_id !== null) t.taskId = row.task_id;
  return t;
}

// The sync engine's write shape: everything the mapper read from Jira, WITHOUT the launch
// binding — an upsert from a poll must never clobber kermanych_project_id/task_id that a
// launch on another machine just wrote. The binding travels only through
// patchJiraIssueBinding below.
export function toJiraIssueRow(issue: JiraIssue): Record<string, unknown> {
  return {
    integration_id: issue.integrationId,
    workspace_id: issue.workspaceId,
    issue_id: issue.issueId,
    key: issue.key,
    summary: issue.summary,
    description_html: issue.descriptionHtml,
    type_name: issue.typeName,
    type_icon: issue.typeIcon,
    priority_name: issue.priorityName,
    priority_icon: issue.priorityIcon,
    labels: issue.labels,
    original_estimate: issue.originalEstimate,
    time_spent: issue.timeSpent,
    remaining_estimate: issue.remainingEstimate,
    original_estimate_seconds: issue.originalEstimateSeconds,
    time_spent_seconds: issue.timeSpentSeconds,
    remaining_estimate_seconds: issue.remainingEstimateSeconds,
    start_date: issue.startDate,
    due_date: issue.dueDate,
    assignee_account_id: issue.assigneeAccountId ?? null,
    assignee_name: issue.assigneeName ?? null,
    assignee_avatar: issue.assigneeAvatar ?? null,
    reporter_name: issue.reporterName ?? null,
    status_id: issue.statusId,
    status_name: issue.statusName,
    status_category: issue.statusCategory,
    parent_key: issue.parentKey ?? null,
    jira_updated_at: issue.jiraUpdatedAt,
    updated_at: new Date().toISOString(),
  };
}

function toJiraColumn(row: ColumnRow): JiraColumn {
  return {
    integrationId: row.integration_id,
    workspaceId: row.workspace_id,
    position: row.position,
    name: row.name,
    statusIds: row.status_ids ?? [],
  };
}

function toJiraComment(row: CommentRow): JiraComment {
  return {
    integrationId: row.integration_id,
    workspaceId: row.workspace_id,
    issueId: row.issue_id,
    commentId: row.comment_id,
    authorName: row.author_name,
    authorAvatar: row.author_avatar,
    bodyHtml: row.body_html,
    jiraCreatedAt: row.jira_created_at,
    jiraUpdatedAt: row.jira_updated_at,
  };
}

function toJiraWorklog(row: WorklogRow): JiraWorklog {
  return {
    integrationId: row.integration_id,
    workspaceId: row.workspace_id,
    issueId: row.issue_id,
    worklogId: row.worklog_id,
    authorAccountId: row.author_account_id,
    authorName: row.author_name,
    authorAvatar: row.author_avatar,
    timeSpent: row.time_spent,
    seconds: row.seconds,
    startedAt: row.started_at,
    commentHtml: row.comment_html,
  };
}

function toJiraAttachment(row: AttachmentRow): JiraAttachment {
  return {
    integrationId: row.integration_id,
    workspaceId: row.workspace_id,
    issueId: row.issue_id,
    attachmentId: row.attachment_id,
    filename: row.filename,
    mime: row.mime,
    size: row.size,
    authorName: row.author_name,
    jiraCreatedAt: row.jira_created_at,
  };
}

// ── integration row ───────────────────────────────────────────────────────────

// `undefined` = the workspace has no integration OR the caller is not a member; both are
// «немає Jira» to a client.
export async function getJiraIntegration(
  client: SupabaseClient,
  workspaceId: string,
): Promise<JiraIntegration | undefined> {
  const { data, error } = await client
    .from("workspace_jira_integrations")
    .select(INTEGRATION_COLUMNS)
    .eq("workspace_id", workspaceId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data ? toJiraIntegration(data as IntegrationRow) : undefined;
}

// Upsert on workspace_id: connecting and re-pointing at another board are the same write.
// The touch trigger owns connected_by/timestamps; RLS makes this owner-only.
export async function upsertJiraIntegration(
  client: SupabaseClient,
  input: JiraIntegrationInsert,
): Promise<JiraIntegration> {
  const { data, error } = await client
    .from("workspace_jira_integrations")
    .upsert(
      {
        workspace_id: input.workspaceId,
        site_url: input.siteUrl.trim(),
        jira_project_key: input.projectKey.trim(),
        board_id: input.boardId,
        board_name: input.boardName,
      },
      { onConflict: "workspace_id" },
    )
    .select(INTEGRATION_COLUMNS)
    .single();
  if (error) throw new Error(error.message);
  return toJiraIntegration(data as IntegrationRow);
}

// Cascade takes the whole mirror with it — columns, issues, children, sync state.
export async function deleteJiraIntegration(client: SupabaseClient, workspaceId: string): Promise<void> {
  const { error } = await client.from("workspace_jira_integrations").delete().eq("workspace_id", workspaceId);
  if (error) throw new Error(error.message);
}

// ── sync lease ────────────────────────────────────────────────────────────────

export async function getJiraSyncState(
  client: SupabaseClient,
  integrationId: string,
): Promise<JiraSyncState | undefined> {
  const { data, error } = await client
    .from("jira_sync_state")
    .select("integration_id, workspace_id, last_synced_at, sync_cursor")
    .eq("integration_id", integrationId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) return undefined;
  const row = data as SyncStateRow;
  const t: JiraSyncState = { integrationId: row.integration_id, workspaceId: row.workspace_id };
  if (row.last_synced_at !== null) t.lastSyncedAt = row.last_synced_at;
  if (row.sync_cursor !== null) t.syncCursor = row.sync_cursor;
  return t;
}

// First-sync bootstrap; a second call collides on the pk and is deliberately a no-op.
export async function ensureJiraSyncState(
  client: SupabaseClient,
  integrationId: string,
  workspaceId: string,
): Promise<void> {
  const { error } = await client
    .from("jira_sync_state")
    .upsert(
      { integration_id: integrationId, workspace_id: workspaceId },
      { onConflict: "integration_id", ignoreDuplicates: true },
    );
  if (error) throw new Error(error.message);
}

// The polling lease. A guarded UPDATE: only the caller who finds the stamp stale (or null)
// moves it, and postgrest reports the race loser as zero returned rows, not an error —
// exactly the claimTask() idiom. N open boards therefore cost ≈1 poller.
export async function takeJiraSyncLease(
  client: SupabaseClient,
  integrationId: string,
  staleMs: number,
): Promise<boolean> {
  const staleBefore = new Date(Date.now() - staleMs).toISOString();
  const { data, error } = await client
    .from("jira_sync_state")
    .update({ last_synced_at: new Date().toISOString() })
    .eq("integration_id", integrationId)
    .or(`last_synced_at.is.null,last_synced_at.lt.${staleBefore}`)
    .select("integration_id");
  if (error) throw new Error(error.message);
  return Array.isArray(data) && data.length > 0;
}

export async function advanceJiraSyncCursor(
  client: SupabaseClient,
  integrationId: string,
  cursor: string,
): Promise<void> {
  const { error } = await client
    .from("jira_sync_state")
    .update({ sync_cursor: cursor })
    .eq("integration_id", integrationId);
  if (error) throw new Error(error.message);
}

// ── columns ───────────────────────────────────────────────────────────────────

export async function listJiraColumns(client: SupabaseClient, integrationId: string): Promise<JiraColumn[]> {
  const { data, error } = await client
    .from("jira_columns")
    .select("integration_id, workspace_id, position, name, status_ids")
    .eq("integration_id", integrationId)
    .order("position", { ascending: true });
  if (error) throw new Error(error.message);
  return (data as ColumnRow[]).map(toJiraColumn);
}

// Wholesale replace — the layout is Jira's, so a changed board simply overwrites ours.
// Delete-then-insert rather than upsert: a board that LOST a column must lose the row.
export async function replaceJiraColumns(
  client: SupabaseClient,
  integrationId: string,
  workspaceId: string,
  columns: readonly { position: number; name: string; statusIds: string[] }[],
): Promise<void> {
  const del = await client.from("jira_columns").delete().eq("integration_id", integrationId);
  if (del.error) throw new Error(del.error.message);
  if (columns.length === 0) return;
  const { error } = await client.from("jira_columns").insert(
    columns.map((c) => ({
      integration_id: integrationId,
      workspace_id: workspaceId,
      position: c.position,
      name: c.name,
      status_ids: c.statusIds,
    })),
  );
  if (error) throw new Error(error.message);
}

// ── issues ────────────────────────────────────────────────────────────────────

export async function listJiraIssues(client: SupabaseClient, integrationId: string): Promise<JiraIssue[]> {
  const { data, error } = await client
    .from("jira_issues")
    .select(ISSUE_COLUMNS)
    .eq("integration_id", integrationId)
    .order("jira_updated_at", { ascending: false });
  if (error) throw new Error(error.message);
  return (data as IssueRow[]).map(toJiraIssue);
}

export async function upsertJiraIssues(client: SupabaseClient, issues: readonly JiraIssue[]): Promise<void> {
  if (issues.length === 0) return;
  const { error } = await client
    .from("jira_issues")
    .upsert(issues.map(toJiraIssueRow), { onConflict: "integration_id,issue_id" });
  if (error) throw new Error(error.message);
}

// Reconciliation's other half: the full sweep computes which mirrored ids Jira no longer
// returns and removes exactly those.
export async function deleteJiraIssues(
  client: SupabaseClient,
  integrationId: string,
  issueIds: readonly string[],
): Promise<void> {
  if (issueIds.length === 0) return;
  const { error } = await client
    .from("jira_issues")
    .delete()
    .eq("integration_id", integrationId)
    .in("issue_id", issueIds);
  if (error) throw new Error(error.message);
}

// The launch binding travels alone (see toJiraIssueRow). Explicit null clears a side.
export async function patchJiraIssueBinding(
  client: SupabaseClient,
  integrationId: string,
  issueId: string,
  binding: { kermanychProjectId?: string | null; taskId?: string | null },
): Promise<void> {
  const row: Record<string, unknown> = {};
  if (binding.kermanychProjectId !== undefined) row.kermanych_project_id = binding.kermanychProjectId;
  if (binding.taskId !== undefined) row.task_id = binding.taskId;
  const { error } = await client
    .from("jira_issues")
    .update(row)
    .eq("integration_id", integrationId)
    .eq("issue_id", issueId);
  if (error) throw new Error(error.message);
}

// ── issue children ────────────────────────────────────────────────────────────

export type JiraIssueChildren = {
  comments: JiraComment[];
  worklogs: JiraWorklog[];
  attachments: JiraAttachment[];
};

export async function listJiraIssueChildren(
  client: SupabaseClient,
  integrationId: string,
  issueId: string,
): Promise<JiraIssueChildren> {
  const [comments, worklogs, attachments] = await Promise.all([
    client
      .from("jira_comments")
      .select("integration_id, workspace_id, issue_id, comment_id, author_name, author_avatar, body_html, jira_created_at, jira_updated_at")
      .eq("integration_id", integrationId)
      .eq("issue_id", issueId)
      .order("jira_created_at", { ascending: true }),
    client
      .from("jira_worklogs")
      .select("integration_id, workspace_id, issue_id, worklog_id, author_account_id, author_name, author_avatar, time_spent, seconds, started_at, comment_html")
      .eq("integration_id", integrationId)
      .eq("issue_id", issueId)
      .order("started_at", { ascending: false }),
    client
      .from("jira_attachments")
      .select("integration_id, workspace_id, issue_id, attachment_id, filename, mime, size, author_name, jira_created_at")
      .eq("integration_id", integrationId)
      .eq("issue_id", issueId)
      .order("jira_created_at", { ascending: false }),
  ]);
  for (const r of [comments, worklogs, attachments]) if (r.error) throw new Error(r.error.message);
  return {
    comments: (comments.data as CommentRow[]).map(toJiraComment),
    worklogs: (worklogs.data as WorklogRow[]).map(toJiraWorklog),
    attachments: (attachments.data as AttachmentRow[]).map(toJiraAttachment),
  };
}

// One issue's children replaced wholesale — same reasoning as the columns: a comment
// deleted in Jira must vanish here, and per-child diffing would buy nothing at this size.
export async function replaceJiraIssueChildren(
  client: SupabaseClient,
  integrationId: string,
  workspaceId: string,
  issueId: string,
  children: {
    comments: readonly Omit<JiraComment, "integrationId" | "workspaceId" | "issueId">[];
    worklogs: readonly Omit<JiraWorklog, "integrationId" | "workspaceId" | "issueId">[];
    attachments: readonly Omit<JiraAttachment, "integrationId" | "workspaceId" | "issueId">[];
  },
): Promise<void> {
  const scope = { integration_id: integrationId, workspace_id: workspaceId, issue_id: issueId };
  const dels = await Promise.all([
    client.from("jira_comments").delete().eq("integration_id", integrationId).eq("issue_id", issueId),
    client.from("jira_worklogs").delete().eq("integration_id", integrationId).eq("issue_id", issueId),
    client.from("jira_attachments").delete().eq("integration_id", integrationId).eq("issue_id", issueId),
  ]);
  for (const d of dels) if (d.error) throw new Error(d.error.message);

  if (children.comments.length) {
    const { error } = await client.from("jira_comments").insert(
      children.comments.map((c) => ({
        ...scope,
        comment_id: c.commentId,
        author_name: c.authorName,
        author_avatar: c.authorAvatar,
        body_html: c.bodyHtml,
        jira_created_at: c.jiraCreatedAt,
        jira_updated_at: c.jiraUpdatedAt,
      })),
    );
    if (error) throw new Error(error.message);
  }
  if (children.worklogs.length) {
    const { error } = await client.from("jira_worklogs").insert(
      children.worklogs.map((w) => ({
        ...scope,
        worklog_id: w.worklogId,
        author_account_id: w.authorAccountId,
        author_name: w.authorName,
        author_avatar: w.authorAvatar,
        time_spent: w.timeSpent,
        seconds: w.seconds,
        started_at: w.startedAt,
        comment_html: w.commentHtml,
      })),
    );
    if (error) throw new Error(error.message);
  }
  if (children.attachments.length) {
    const { error } = await client.from("jira_attachments").insert(
      children.attachments.map((a) => ({
        ...scope,
        attachment_id: a.attachmentId,
        filename: a.filename,
        mime: a.mime,
        size: a.size,
        author_name: a.authorName,
        jira_created_at: a.jiraCreatedAt,
      })),
    );
    if (error) throw new Error(error.message);
  }
}

// ── realtime ──────────────────────────────────────────────────────────────────
// The Jira board's live feed, the subscribeTasks() shape: one channel, one binding,
// registered before subscribe(). Only jira_issues is in the publication — columns are
// refetched on open, children on dialog open. DELETE arrives with the pk only (default
// replica identity), which is exactly enough to drop the card.
export type JiraIssueChange = { kind: "upsert"; issue: JiraIssue } | { kind: "delete"; issueId: string };

export function subscribeJiraIssues(
  client: SupabaseClient,
  integrationId: string,
  onChange: (change: JiraIssueChange) => void,
  onState?: (state: "SUBSCRIBED" | "TIMED_OUT" | "CLOSED" | "CHANNEL_ERROR") => void,
): () => void {
  const channel: RealtimeChannel = client.channel("kermanych-jira-issues");
  channel.on(
    "postgres_changes",
    { event: "*", schema: "public", table: "jira_issues", filter: `integration_id=eq.${integrationId}` },
    (payload) => {
      if (payload.eventType === "DELETE") {
        const id = (payload.old as { issue_id?: string }).issue_id;
        if (id) onChange({ kind: "delete", issueId: id });
        return;
      }
      onChange({ kind: "upsert", issue: toJiraIssue(payload.new as IssueRow) });
    },
  );
  channel.subscribe((status) => onState?.(status as "SUBSCRIBED" | "TIMED_OUT" | "CLOSED" | "CHANNEL_ERROR"));
  return () => {
    void client.removeChannel(channel);
  };
}
