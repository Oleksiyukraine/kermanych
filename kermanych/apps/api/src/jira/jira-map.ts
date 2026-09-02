// apps/api/src/jira/jira-map.ts
// The tolerant boundary between Jira's payloads and the mirror's rows. Pure functions,
// no I/O: everything here is unit-tested against captured payload shapes, and the sync
// engine stays a thin loop around them.
//
// Tolerance is the design: a missing priority, an un-located board or a field Jira
// renames must degrade to blank strings — a mirror that refuses to render is worse than
// a card with an empty icon.
import type { JiraIssue, JiraStatusCategory } from "@kermanych/cloud";
import type { JiraRawComment, JiraRawIssue, JiraRawWorklog, JiraTransition } from "./jira-client";

// Mirror child rows carry their scope columns only at write time (replaceJiraIssueChildren
// adds them); the mappers produce the content half.
export type MappedComment = {
  commentId: string;
  authorName: string;
  authorAvatar: string;
  bodyHtml: string;
  jiraCreatedAt: string;
  jiraUpdatedAt: string;
};

export type MappedWorklog = {
  worklogId: string;
  authorName: string;
  authorAvatar: string;
  timeSpent: string;
  seconds: number;
  startedAt: string;
  commentHtml: string;
};

export type MappedAttachment = {
  attachmentId: string;
  filename: string;
  mime: string;
  size: number;
  authorName: string;
  jiraCreatedAt: string;
};

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

// Jira hands avatars as a size-keyed record; 48x48 is always present in practice, and
// any entry beats none when it is not.
function avatar(urls: Record<string, string> | undefined): string {
  if (!urls) return "";
  return urls["48x48"] ?? Object.values(urls)[0] ?? "";
}

function toCategory(raw: unknown): JiraStatusCategory {
  return raw === "indeterminate" || raw === "done" ? raw : "new";
}

// ISO-8601 with Jira's `+0000` zone suffix normalised through Date so Postgres and the
// sync cursor compare timestamps in one spelling.
function iso(raw: unknown): string {
  const d = typeof raw === "string" ? new Date(raw) : undefined;
  return d && !Number.isNaN(d.getTime()) ? d.toISOString() : new Date(0).toISOString();
}

type NamedIconField = { name?: string; iconUrl?: string };

type UserField = { accountId?: string; displayName?: string; avatarUrls?: Record<string, string> };

export function mapIssue(
  integration: { id: string; workspaceId: string },
  raw: JiraRawIssue,
): JiraIssue {
  const f = raw.fields;
  const status = (f.status ?? {}) as { id?: string; name?: string; statusCategory?: { key?: string } };
  const type = (f.issuetype ?? {}) as NamedIconField;
  const priority = (f.priority ?? {}) as NamedIconField;
  const assignee = (f.assignee ?? undefined) as UserField | undefined;
  const reporter = (f.reporter ?? undefined) as UserField | undefined;
  const parent = (f.parent ?? undefined) as { key?: string } | undefined;
  const timetracking = (f.timetracking ?? {}) as { originalEstimate?: string };

  const issue: JiraIssue = {
    integrationId: integration.id,
    workspaceId: integration.workspaceId,
    issueId: raw.id,
    key: raw.key,
    summary: str(f.summary),
    // renderedFields carries the HTML Jira rendered from the ADF description; the raw
    // field would be an ADF tree the UI cannot show.
    descriptionHtml: str(raw.renderedFields?.description),
    typeName: str(type.name),
    typeIcon: str(type.iconUrl),
    priorityName: str(priority.name),
    priorityIcon: str(priority.iconUrl),
    labels: Array.isArray(f.labels) ? f.labels.filter((l): l is string => typeof l === "string") : [],
    originalEstimate: str(timetracking.originalEstimate),
    statusId: str(status.id),
    statusName: str(status.name),
    statusCategory: toCategory(status.statusCategory?.key),
    jiraUpdatedAt: iso(f.updated),
    updatedAt: new Date().toISOString(),
  };
  if (assignee?.accountId) issue.assigneeAccountId = assignee.accountId;
  if (assignee?.displayName) issue.assigneeName = assignee.displayName;
  if (assignee) {
    const a = avatar(assignee.avatarUrls);
    if (a) issue.assigneeAvatar = a;
  }
  if (reporter?.displayName) issue.reporterName = reporter.displayName;
  if (parent?.key) issue.parentKey = parent.key;
  return issue;
}

export function mapComments(raw: readonly JiraRawComment[]): MappedComment[] {
  return raw.map((c) => ({
    commentId: c.id,
    authorName: c.author?.displayName ?? "",
    authorAvatar: avatar(c.author?.avatarUrls),
    bodyHtml: c.renderedBody ?? "",
    jiraCreatedAt: iso(c.created),
    jiraUpdatedAt: iso(c.updated),
  }));
}

// A worklog's comment is an ADF tree with no rendered form on this endpoint; the mirror
// stores the concatenated text nodes — the time entry is the datum, the note is a bonus.
export function adfText(node: unknown): string {
  if (!node || typeof node !== "object") return "";
  const parts: string[] = [];
  if ("text" in node && typeof node.text === "string") parts.push(node.text);
  if ("content" in node && Array.isArray(node.content)) {
    for (const child of node.content) parts.push(adfText(child));
  }
  return parts.join("");
}

// The other direction: plain text into the ADF `doc` a POST/PUT /issue description takes.
//
// Line structure is the whole point. ADF renders a text node's `\n` as nothing at all, so a
// multi-line body — which is what any ticket written as context + flow + acceptance criteria
// is — used to arrive in Jira as one run-on paragraph. Blank lines therefore become paragraph
// boundaries and single newlines become `hardBreak`s, which is how Jira's own editor stores
// exactly the same typing.
//
// Empty content for a blank string, because Jira reads a present-but-empty description as
// «clear it», and that is precisely what an empty description means.
export function adfDoc(text: string): Record<string, unknown> {
  const content = text
    .trim()
    .split(/\n[^\S\n]*\n+/)
    .map((para) => para.split("\n").map((l) => l.trim()))
    .filter((lines) => lines.some((l) => l !== ""))
    .map((lines) => {
      const nodes: Record<string, unknown>[] = [];
      for (const line of lines) {
        if (nodes.length) nodes.push({ type: "hardBreak" });
        if (line !== "") nodes.push({ type: "text", text: line });
      }
      return { type: "paragraph", content: nodes };
    });
  return { type: "doc", version: 1, content };
}

export function mapWorklogs(raw: readonly JiraRawWorklog[]): MappedWorklog[] {
  return raw.map((w) => ({
    worklogId: w.id,
    authorName: w.author?.displayName ?? "",
    authorAvatar: avatar(w.author?.avatarUrls),
    timeSpent: w.timeSpent ?? "",
    seconds: w.timeSpentSeconds ?? 0,
    startedAt: iso(w.started),
    commentHtml: adfText(w.comment),
  }));
}

// Attachment metadata rides on the issue's own `attachment` field — no extra request.
export function mapAttachments(raw: JiraRawIssue): MappedAttachment[] {
  const list = Array.isArray(raw.fields.attachment) ? raw.fields.attachment : [];
  return list.map((a) => {
    const att = (a ?? {}) as {
      id?: string;
      filename?: string;
      mimeType?: string;
      size?: number;
      author?: { displayName?: string };
      created?: string;
    };
    return {
      attachmentId: str(att.id),
      filename: str(att.filename),
      mime: str(att.mimeType),
      size: typeof att.size === "number" ? att.size : 0,
      authorName: att.author?.displayName ?? "",
      jiraCreatedAt: iso(att.created),
    };
  });
}

// The launch dialog's default: the first transition landing in Jira's In-Progress
// category. `undefined` when the workflow offers none from here — the picker then simply
// has no preselection.
export function pickInProgressTransition(transitions: readonly JiraTransition[]): JiraTransition | undefined {
  return transitions.find((t) => t.to.statusCategory.key === "indeterminate");
}

// The incremental JQL. The cursor is inclusive-minus-one-minute: Jira's `updated`
// granularity is the minute in JQL comparisons, and re-upserting a boundary issue is
// idempotent while missing one is a hole.
export function incrementalJql(projectKey: string, cursorIso: string): string {
  const d = new Date(new Date(cursorIso).getTime() - 60_000);
  const pad = (n: number) => String(n).padStart(2, "0");
  // JQL wants "yyyy-MM-dd HH:mm" (no seconds, no zone — site time is not ours, but the
  // minute of slack above covers the skew for a poll that runs every 30 s).
  const stamp = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
  return `project = "${projectKey}" AND updated >= "${stamp}" ORDER BY updated ASC`;
}

export function fullJql(projectKey: string): string {
  return `project = "${projectKey}" ORDER BY updated ASC`;
}
