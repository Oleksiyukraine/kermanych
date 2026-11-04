// The Plane mirror's data access. This file owns the snake_case <-> camelCase boundary for
// every plane_* table: nothing outside @kermanych/cloud ever sees a Postgres column name.
// Every call runs under the caller's JWT — member RLS on the mirror tables and the
// owner-only policies on workspace_plane_integrations are the authorization surface.
//
// The WRITERS here are apps/api's PlaneService (sync engine + action mirror-patches); the
// READERS are the UI's plane store and, for children, the ticket dialog. Plane itself is the
// source of truth: writes are wholesale upserts/replaces, never merges. Structural twin of
// jira.ts — the multi-board form included (one integration row per Plane project).
import type { RealtimeChannel, SupabaseClient } from "@supabase/supabase-js";
import type {
  PlaneAttachment,
  PlaneColumn,
  PlaneComment,
  PlaneIntegration,
  PlaneIntegrationInsert,
  PlaneIssue,
  PlaneStatusCategory,
  PlaneSyncState,
  PlaneWorklog,
} from "./types";

const INTEGRATION_COLUMNS =
  "id, workspace_id, site_url, workspace_slug, project_id, project_identifier, project_name, connected_by, created_at, updated_at";

const ISSUE_COLUMNS =
  "integration_id, workspace_id, issue_id, key, summary, description_html, type_name, priority, labels, estimate_point_id, estimate, original_estimate_seconds, time_spent, time_spent_seconds, start_date, due_date, assignee_account_id, assignee_name, assignee_avatar, reporter_name, status_id, status_name, status_category, parent_key, plane_updated_at, children_synced_at, kermanych_project_id, task_id, updated_at";

const COMMENT_COLUMNS =
  "integration_id, workspace_id, issue_id, comment_id, author_name, author_avatar, body_html, plane_created_at, plane_updated_at";

const WORKLOG_COLUMNS =
  "integration_id, workspace_id, issue_id, worklog_id, author_account_id, author_name, author_avatar, time_spent, seconds, started_at, description";

const ATTACHMENT_COLUMNS =
  "integration_id, workspace_id, issue_id, attachment_id, filename, mime, size, author_name, plane_created_at";

type IntegrationRow = {
  id: string;
  workspace_id: string;
  site_url: string;
  workspace_slug: string;
  project_id: string;
  project_identifier: string;
  project_name: string;
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
  state_group: string;
  color: string;
};

type IssueRow = {
  integration_id: string;
  workspace_id: string;
  issue_id: string;
  key: string;
  summary: string;
  description_html: string;
  type_name: string;
  priority: string;
  labels: string[];
  estimate_point_id: string | null;
  estimate: string;
  original_estimate_seconds: number;
  time_spent: string;
  time_spent_seconds: number;
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
  plane_updated_at: string;
  children_synced_at: string | null;
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
  plane_created_at: string;
  plane_updated_at: string;
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
  description: string;
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
  plane_created_at: string;
};

export function toPlaneIntegration(row: IntegrationRow): PlaneIntegration {
  const t: PlaneIntegration = {
    id: row.id,
    workspaceId: row.workspace_id,
    siteUrl: row.site_url,
    workspaceSlug: row.workspace_slug,
    projectId: row.project_id,
    projectIdentifier: row.project_identifier,
    projectName: row.project_name,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
  if (row.connected_by !== null) t.connectedBy = row.connected_by;
  return t;
}

// Tolerant on the category: a value written by a later mapper degrades to 'new' (renders in
// the board, refuses nothing) rather than crashing this one.
function toCategory(raw: string): PlaneStatusCategory {
  return raw === "indeterminate" || raw === "done" ? raw : "new";
}

export function toPlaneIssue(row: IssueRow): PlaneIssue {
  const t: PlaneIssue = {
    integrationId: row.integration_id,
    workspaceId: row.workspace_id,
    issueId: row.issue_id,
    key: row.key,
    summary: row.summary,
    descriptionHtml: row.description_html,
    typeName: row.type_name,
    priority: row.priority,
    labels: row.labels ?? [],
    estimate: row.estimate,
    originalEstimateSeconds: row.original_estimate_seconds ?? 0,
    timeSpent: row.time_spent,
    timeSpentSeconds: row.time_spent_seconds ?? 0,
    startDate: row.start_date,
    dueDate: row.due_date,
    statusId: row.status_id,
    statusName: row.status_name,
    statusCategory: toCategory(row.status_category),
    planeUpdatedAt: row.plane_updated_at,
    updatedAt: row.updated_at,
  };
  if (row.estimate_point_id !== null) t.estimatePointId = row.estimate_point_id;
  if (row.assignee_account_id !== null) t.assigneeAccountId = row.assignee_account_id;
  if (row.assignee_name !== null) t.assigneeName = row.assignee_name;
  if (row.assignee_avatar !== null) t.assigneeAvatar = row.assignee_avatar;
  if (row.reporter_name !== null) t.reporterName = row.reporter_name;
  if (row.parent_key !== null) t.parentKey = row.parent_key;
  // `?? null` too: a realtime payload from before the column existed simply lacks it.
  if ((row.children_synced_at ?? null) !== null) t.childrenSyncedAt = row.children_synced_at as string;
  if (row.kermanych_project_id !== null) t.kermanychProjectId = row.kermanych_project_id;
  if (row.task_id !== null) t.taskId = row.task_id;
  return t;
}

// The sync engine's write shape: everything the mapper read from Plane, WITHOUT the launch
// binding — an upsert from a poll must never clobber kermanych_project_id/task_id that a
// launch on another machine just wrote. The binding travels only through
// patchPlaneIssueBinding below. `children_synced_at` is left out for the same reason: it
// is the child refresher's stamp (markPlaneChildrenSynced), and a list upsert that reset it
// would make every item due again on every tick.
export function toPlaneIssueRow(issue: PlaneIssue): Record<string, unknown> {
  return {
    integration_id: issue.integrationId,
    workspace_id: issue.workspaceId,
    issue_id: issue.issueId,
    key: issue.key,
    summary: issue.summary,
    description_html: issue.descriptionHtml,
    type_name: issue.typeName,
    priority: issue.priority,
    labels: issue.labels,
    estimate_point_id: issue.estimatePointId ?? null,
    estimate: issue.estimate,
    original_estimate_seconds: issue.originalEstimateSeconds,
    time_spent: issue.timeSpent,
    time_spent_seconds: issue.timeSpentSeconds,
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
    plane_updated_at: issue.planeUpdatedAt,
    updated_at: new Date().toISOString(),
  };
}

function toPlaneColumn(row: ColumnRow): PlaneColumn {
  return {
    integrationId: row.integration_id,
    workspaceId: row.workspace_id,
    position: row.position,
    name: row.name,
    stateIds: row.state_ids ?? [],
    stateGroup: row.state_group ?? "",
    color: row.color ?? "",
  };
}

function toPlaneComment(row: CommentRow): PlaneComment {
  return {
    integrationId: row.integration_id,
    workspaceId: row.workspace_id,
    issueId: row.issue_id,
    commentId: row.comment_id,
    authorName: row.author_name,
    authorAvatar: row.author_avatar,
    bodyHtml: row.body_html,
    planeCreatedAt: row.plane_created_at,
    planeUpdatedAt: row.plane_updated_at,
  };
}

function toPlaneWorklog(row: WorklogRow): PlaneWorklog {
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
    description: row.description,
  };
}

function toPlaneAttachment(row: AttachmentRow): PlaneAttachment {
  return {
    integrationId: row.integration_id,
    workspaceId: row.workspace_id,
    issueId: row.issue_id,
    attachmentId: row.attachment_id,
    filename: row.filename,
    mime: row.mime,
    size: row.size,
    authorName: row.author_name,
    planeCreatedAt: row.plane_created_at,
  };
}

// ── integration rows ──────────────────────────────────────────────────────────

// Every Plane project a workspace has connected, oldest first — the board switcher's order.
// An empty array = the workspace has none OR the caller is not a member; both are «немає
// Plane» to a client.
export async function listPlaneIntegrations(
  client: SupabaseClient,
  workspaceId: string,
): Promise<PlaneIntegration[]> {
  const { data, error } = await client
    .from("workspace_plane_integrations")
    .select(INTEGRATION_COLUMNS)
    .eq("workspace_id", workspaceId)
    .order("created_at", { ascending: true });
  if (error) throw new Error(error.message);
  return (data as IntegrationRow[]).map(toPlaneIntegration);
}

// One connected project by its own row id — the key every board-scoped action and the sync
// engine address it by. `undefined` = no such row or non-member.
export async function getPlaneIntegrationById(
  client: SupabaseClient,
  integrationId: string,
): Promise<PlaneIntegration | undefined> {
  const { data, error } = await client
    .from("workspace_plane_integrations")
    .select(INTEGRATION_COLUMNS)
    .eq("id", integrationId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data ? toPlaneIntegration(data as IntegrationRow) : undefined;
}

// Upsert on (workspace_id, project_id): connecting a project and re-connecting the SAME
// project (a name/identifier/site refresh) are the same write, but a DIFFERENT project is a
// new row up to the workspace's ten-project cap. The touch trigger owns
// connected_by/timestamps; the limit trigger refuses the eleventh; RLS makes this owner-only.
export async function upsertPlaneIntegration(
  client: SupabaseClient,
  input: PlaneIntegrationInsert,
): Promise<PlaneIntegration> {
  const { data, error } = await client
    .from("workspace_plane_integrations")
    .upsert(
      {
        workspace_id: input.workspaceId,
        site_url: input.siteUrl.trim(),
        workspace_slug: input.workspaceSlug.trim(),
        project_id: input.projectId,
        project_identifier: input.projectIdentifier.trim(),
        project_name: input.projectName,
      },
      { onConflict: "workspace_id,project_id" },
    )
    .select(INTEGRATION_COLUMNS)
    .single();
  if (error) throw new Error(error.message);
  return toPlaneIntegration(data as IntegrationRow);
}

// Disconnect ONE project by its row id. Cascade takes the whole mirror of that project with
// it — columns, issues, children, sync state — and leaves the workspace's others alone.
export async function deletePlaneIntegration(client: SupabaseClient, integrationId: string): Promise<void> {
  const { error } = await client.from("workspace_plane_integrations").delete().eq("id", integrationId);
  if (error) throw new Error(error.message);
}

// ── sync lease ────────────────────────────────────────────────────────────────

export async function getPlaneSyncState(
  client: SupabaseClient,
  integrationId: string,
): Promise<PlaneSyncState | undefined> {
  const { data, error } = await client
    .from("plane_sync_state")
    .select("integration_id, workspace_id, last_synced_at, sync_cursor")
    .eq("integration_id", integrationId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) return undefined;
  const row = data as SyncStateRow;
  const t: PlaneSyncState = { integrationId: row.integration_id, workspaceId: row.workspace_id };
  if (row.last_synced_at !== null) t.lastSyncedAt = row.last_synced_at;
  if (row.sync_cursor !== null) t.syncCursor = row.sync_cursor;
  return t;
}

// First-sync bootstrap; a second call collides on the pk and is deliberately a no-op.
export async function ensurePlaneSyncState(
  client: SupabaseClient,
  integrationId: string,
  workspaceId: string,
): Promise<void> {
  const { error } = await client
    .from("plane_sync_state")
    .upsert(
      { integration_id: integrationId, workspace_id: workspaceId },
      { onConflict: "integration_id", ignoreDuplicates: true },
    );
  if (error) throw new Error(error.message);
}

// The polling lease. A guarded UPDATE: only the caller who finds the stamp stale (or null)
// moves it, and postgrest reports the race loser as zero returned rows, not an error —
// exactly the claimTask() idiom. N open boards therefore cost ≈1 poller, which matters more
// here than for Jira: Plane allows 60 requests a minute per key.
export async function takePlaneSyncLease(
  client: SupabaseClient,
  integrationId: string,
  staleMs: number,
): Promise<boolean> {
  const staleBefore = new Date(Date.now() - staleMs).toISOString();
  const { data, error } = await client
    .from("plane_sync_state")
    .update({ last_synced_at: new Date().toISOString() })
    .eq("integration_id", integrationId)
    .or(`last_synced_at.is.null,last_synced_at.lt.${staleBefore}`)
    .select("integration_id");
  if (error) throw new Error(error.message);
  return Array.isArray(data) && data.length > 0;
}

export async function advancePlaneSyncCursor(
  client: SupabaseClient,
  integrationId: string,
  cursor: string,
): Promise<void> {
  const { error } = await client
    .from("plane_sync_state")
    .update({ sync_cursor: cursor })
    .eq("integration_id", integrationId);
  if (error) throw new Error(error.message);
}

// ── columns ───────────────────────────────────────────────────────────────────

export async function listPlaneColumns(client: SupabaseClient, integrationId: string): Promise<PlaneColumn[]> {
  const { data, error } = await client
    .from("plane_columns")
    .select("integration_id, workspace_id, position, name, state_ids, state_group, color")
    .eq("integration_id", integrationId)
    .order("position", { ascending: true });
  if (error) throw new Error(error.message);
  return (data as ColumnRow[]).map(toPlaneColumn);
}

// Wholesale replace — the states are Plane's, so a changed project simply overwrites ours.
// Delete-then-insert rather than upsert: a project that LOST a state must lose the column.
export async function replacePlaneColumns(
  client: SupabaseClient,
  integrationId: string,
  workspaceId: string,
  columns: readonly { position: number; name: string; stateIds: string[]; stateGroup: string; color: string }[],
): Promise<void> {
  const del = await client.from("plane_columns").delete().eq("integration_id", integrationId);
  if (del.error) throw new Error(del.error.message);
  if (columns.length === 0) return;
  const { error } = await client.from("plane_columns").insert(
    columns.map((c) => ({
      integration_id: integrationId,
      workspace_id: workspaceId,
      position: c.position,
      name: c.name,
      state_ids: c.stateIds,
      state_group: c.stateGroup,
      color: c.color,
    })),
  );
  if (error) throw new Error(error.message);
}

// ── issues ────────────────────────────────────────────────────────────────────

export async function listPlaneIssues(client: SupabaseClient, integrationId: string): Promise<PlaneIssue[]> {
  const { data, error } = await client
    .from("plane_issues")
    .select(ISSUE_COLUMNS)
    .eq("integration_id", integrationId)
    .order("plane_updated_at", { ascending: false });
  if (error) throw new Error(error.message);
  return (data as IssueRow[]).map(toPlaneIssue);
}

export async function upsertPlaneIssues(client: SupabaseClient, issues: readonly PlaneIssue[]): Promise<void> {
  if (issues.length === 0) return;
  const { error } = await client
    .from("plane_issues")
    .upsert(issues.map(toPlaneIssueRow), { onConflict: "integration_id,issue_id" });
  if (error) throw new Error(error.message);
}

// Reconciliation's other half: the full sweep computes which mirrored ids Plane no longer
// returns (deleted, archived, turned into a draft) and removes exactly those.
export async function deletePlaneIssues(
  client: SupabaseClient,
  integrationId: string,
  issueIds: readonly string[],
): Promise<void> {
  if (issueIds.length === 0) return;
  const { error } = await client
    .from("plane_issues")
    .delete()
    .eq("integration_id", integrationId)
    .in("issue_id", issueIds);
  if (error) throw new Error(error.message);
}

// The launch binding travels alone (see toPlaneIssueRow). Explicit null clears a side.
export async function patchPlaneIssueBinding(
  client: SupabaseClient,
  integrationId: string,
  issueId: string,
  binding: { kermanychProjectId?: string | null; taskId?: string | null },
): Promise<void> {
  const row: Record<string, unknown> = {};
  if (binding.kermanychProjectId !== undefined) row.kermanych_project_id = binding.kermanychProjectId;
  if (binding.taskId !== undefined) row.task_id = binding.taskId;
  const { error } = await client
    .from("plane_issues")
    .update(row)
    .eq("integration_id", integrationId)
    .eq("issue_id", issueId);
  if (error) throw new Error(error.message);
}

// The child refresher's stamp, written after replacePlaneIssueChildren succeeded. The sync
// engine drains items whose stamp is absent or older than `plane_updated_at` a few per
// tick (Plane's 60-requests-a-minute budget), oldest stamp first; this is what takes an
// item off that queue.
export async function markPlaneChildrenSynced(
  client: SupabaseClient,
  integrationId: string,
  issueId: string,
  atIso: string,
): Promise<void> {
  const { error } = await client
    .from("plane_issues")
    .update({ children_synced_at: atIso })
    .eq("integration_id", integrationId)
    .eq("issue_id", issueId);
  if (error) throw new Error(error.message);
}

// ── issue children ────────────────────────────────────────────────────────────

export type PlaneIssueChildren = {
  comments: PlaneComment[];
  worklogs: PlaneWorklog[];
  attachments: PlaneAttachment[];
};

export async function listPlaneIssueChildren(
  client: SupabaseClient,
  integrationId: string,
  issueId: string,
): Promise<PlaneIssueChildren> {
  const [comments, worklogs, attachments] = await Promise.all([
    client
      .from("plane_comments")
      .select(COMMENT_COLUMNS)
      .eq("integration_id", integrationId)
      .eq("issue_id", issueId)
      .order("plane_created_at", { ascending: true }),
    client
      .from("plane_worklogs")
      .select(WORKLOG_COLUMNS)
      .eq("integration_id", integrationId)
      .eq("issue_id", issueId)
      .order("started_at", { ascending: false }),
    client
      .from("plane_attachments")
      .select(ATTACHMENT_COLUMNS)
      .eq("integration_id", integrationId)
      .eq("issue_id", issueId)
      .order("plane_created_at", { ascending: false }),
  ]);
  for (const r of [comments, worklogs, attachments]) if (r.error) throw new Error(r.error.message);
  return {
    comments: (comments.data as CommentRow[]).map(toPlaneComment),
    worklogs: (worklogs.data as WorklogRow[]).map(toPlaneWorklog),
    attachments: (attachments.data as AttachmentRow[]).map(toPlaneAttachment),
  };
}

// The capacity screen's read: every worklog of the project whose `started_at` falls in a
// half-open instant range, regardless of issue. The per-issue reader above serves the
// ticket dialog; a fortnight of the whole team is a different shape and its own index.
export async function listPlaneWorklogsBetween(
  client: SupabaseClient,
  integrationId: string,
  fromIso: string,
  toIso: string,
): Promise<PlaneWorklog[]> {
  const { data, error } = await client
    .from("plane_worklogs")
    .select(WORKLOG_COLUMNS)
    .eq("integration_id", integrationId)
    .gte("started_at", fromIso)
    .lt("started_at", toIso)
    .order("started_at", { ascending: true });
  if (error) throw new Error(error.message);
  return (data as WorklogRow[]).map(toPlaneWorklog);
}

// One issue's children replaced wholesale — same reasoning as the columns: a comment
// deleted in Plane must vanish here, and per-child diffing would buy nothing at this size.
export async function replacePlaneIssueChildren(
  client: SupabaseClient,
  integrationId: string,
  workspaceId: string,
  issueId: string,
  children: {
    comments: readonly Omit<PlaneComment, "integrationId" | "workspaceId" | "issueId">[];
    worklogs: readonly Omit<PlaneWorklog, "integrationId" | "workspaceId" | "issueId">[];
    attachments: readonly Omit<PlaneAttachment, "integrationId" | "workspaceId" | "issueId">[];
  },
): Promise<void> {
  const scope = { integration_id: integrationId, workspace_id: workspaceId, issue_id: issueId };
  const dels = await Promise.all([
    client.from("plane_comments").delete().eq("integration_id", integrationId).eq("issue_id", issueId),
    client.from("plane_worklogs").delete().eq("integration_id", integrationId).eq("issue_id", issueId),
    client.from("plane_attachments").delete().eq("integration_id", integrationId).eq("issue_id", issueId),
  ]);
  for (const d of dels) if (d.error) throw new Error(d.error.message);

  if (children.comments.length) {
    const { error } = await client.from("plane_comments").insert(
      children.comments.map((c) => ({
        ...scope,
        comment_id: c.commentId,
        author_name: c.authorName,
        author_avatar: c.authorAvatar,
        body_html: c.bodyHtml,
        plane_created_at: c.planeCreatedAt,
        plane_updated_at: c.planeUpdatedAt,
      })),
    );
    if (error) throw new Error(error.message);
  }
  if (children.worklogs.length) {
    const { error } = await client.from("plane_worklogs").insert(
      children.worklogs.map((w) => ({
        ...scope,
        worklog_id: w.worklogId,
        author_account_id: w.authorAccountId,
        author_name: w.authorName,
        author_avatar: w.authorAvatar,
        time_spent: w.timeSpent,
        seconds: w.seconds,
        started_at: w.startedAt,
        description: w.description,
      })),
    );
    if (error) throw new Error(error.message);
  }
  if (children.attachments.length) {
    const { error } = await client.from("plane_attachments").insert(
      children.attachments.map((a) => ({
        ...scope,
        attachment_id: a.attachmentId,
        filename: a.filename,
        mime: a.mime,
        size: a.size,
        author_name: a.authorName,
        plane_created_at: a.planeCreatedAt,
      })),
    );
    if (error) throw new Error(error.message);
  }
}

// ── realtime ──────────────────────────────────────────────────────────────────
// The Plane board's live feed, the subscribeTasks() shape: one channel, one binding,
// registered before subscribe(). Only plane_issues is in the publication — columns are
// refetched on open, children on dialog open. DELETE arrives with the pk only (default
// replica identity), which is exactly enough to drop the card.
export type PlaneIssueChange = { kind: "upsert"; issue: PlaneIssue } | { kind: "delete"; issueId: string };

export function subscribePlaneIssues(
  client: SupabaseClient,
  integrationId: string,
  onChange: (change: PlaneIssueChange) => void,
  onState?: (state: "SUBSCRIBED" | "TIMED_OUT" | "CLOSED" | "CHANNEL_ERROR") => void,
): () => void {
  const channel: RealtimeChannel = client.channel("kermanych-plane-issues");
  channel.on(
    "postgres_changes",
    { event: "*", schema: "public", table: "plane_issues", filter: `integration_id=eq.${integrationId}` },
    (payload) => {
      if (payload.eventType === "DELETE") {
        const id = (payload.old as { issue_id?: string }).issue_id;
        if (id) onChange({ kind: "delete", issueId: id });
        return;
      }
      onChange({ kind: "upsert", issue: toPlaneIssue(payload.new as IssueRow) });
    },
  );
  channel.subscribe((status) => onState?.(status as "SUBSCRIBED" | "TIMED_OUT" | "CLOSED" | "CHANNEL_ERROR"));
  return () => {
    void client.removeChannel(channel);
  };
}
