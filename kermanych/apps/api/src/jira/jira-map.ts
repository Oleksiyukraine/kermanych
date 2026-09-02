// apps/api/src/jira/jira-map.ts
// The tolerant boundary between Jira's payloads and the mirror's rows. Pure functions,
// no I/O: everything here is unit-tested against captured payload shapes, and the sync
// engine stays a thin loop around them.
//
// Tolerance is the design: a missing priority, an un-located board or a field Jira
// renames must degrade to blank strings — a mirror that refuses to render is worse than
// a card with an empty icon.
import type { JiraIssue, JiraStatusCategory } from "@kermanych/cloud";
import type { JiraFieldSummary, JiraRawComment, JiraRawIssue, JiraRawWorklog, JiraTransition } from "./jira-client";

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
  // Jira's accountId, not a name: the dialog decides own-versus-all worklog permissions
  // from it. Blank when Jira returned no author (a deleted account).
  authorAccountId: string;
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

// A Jira DAY, not an instant: `duedate` and the start-date field are calendar dates, and
// re-zoning them through Date would move a Kyiv-morning deadline to the previous day in
// UTC. So the leading YYYY-MM-DD is taken verbatim — datetime-typed start fields simply
// lose their time — and only the calendar itself is validated: 2026-02-31 is ten digits
// Postgres and Jira would both refuse, so it degrades to blank like every other
// unreadable field here.
export function dateOnly(raw: unknown): string {
  const m = typeof raw === "string" ? /^(\d{4}-\d{2}-\d{2})/.exec(raw) : null;
  if (!m) return "";
  const day = m[1]!;
  const parsed = new Date(`${day}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().startsWith(day) ? day : "";
}

// dateOnly's outbound twin, and deliberately STRICT where that one is tolerant: a blank
// draft means «clear this date» (null is how Jira spells that), while an unreadable one
// is a bug in the caller — sending it would either clear a date the user meant to set or
// earn a Jira refusal phrased in customfield ids.
export function toJiraDate(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const day = dateOnly(trimmed);
  if (!day) throw new Error(`invalid date: ${trimmed}`);
  return day;
}

// The worklog endpoint's `started`, which is NOT the same spelling as everything else Jira
// hands out: it parses `yyyy-MM-dd'T'HH:mm:ss.SSSZ` with a NUMERIC zone and refuses the
// `Z` that `Date.toISOString()` writes, so the instant is re-spelled as UTC + «+0000».
//
// Strict like toJiraDate and for the same reason: an unreadable start would either be
// silently logged at «now» or earn a refusal phrased in Java date patterns.
export function toJiraStarted(raw: string): string {
  const at = new Date(raw);
  if (Number.isNaN(at.getTime())) throw new Error(`unreadable worklog start: ${raw}`);
  return `${at.toISOString().replace(/Z$/, "")}+0000`;
}

// Jira has no system start date: every site keeps it in a custom field whose id differs
// (customfield_10015 on most Cloud sites, an Advanced Roadmaps «Target start» on others).
// Resolution is therefore by MEANING, in the order a human would read the list:
// the field actually named «Start date», then Advanced Roadmaps' baseline-start by its
// schema (its display name is site-editable), then a «Target start» by name. Date-typed
// only — a text field called «Start date» is not a date the board can render or write.
//
// `undefined` = this site has no start date. That is a legitimate answer: the board then
// shows none and the editors hide the control rather than offering a guaranteed refusal.
export function pickStartDateFieldId(fields: readonly JiraFieldSummary[]): string | undefined {
  const dated = fields.filter((f) => f.schema?.type === "date" || f.schema?.type === "datetime");
  // First occurrence wins: a site with two «Start date» fields (an app's copy beside the
  // system one) must resolve to the same id on every poll, and Jira lists the system
  // field first.
  const byName = new Map<string, string>();
  for (const f of dated) {
    const name = f.name?.trim().toLowerCase() ?? "";
    if (name && !byName.has(name)) byName.set(name, f.id);
  }
  return (
    byName.get("start date") ??
    dated.find((f) => f.schema?.custom === "com.atlassian.jpo:jpo-custom-field-baseline-start")?.id ??
    byName.get("target start")
  );
}

type NamedIconField = { name?: string; iconUrl?: string };

type UserField = { accountId?: string; displayName?: string; avatarUrls?: Record<string, string> };

export function mapIssue(
  integration: { id: string; workspaceId: string },
  raw: JiraRawIssue,
  // The site's start-date field id, resolved once per site by the caller. Absent (this
  // site has none, or the fetch did not ask for it) mirrors a blank start date rather
  // than guessing from a field the payload never carried.
  startDateFieldId?: string,
): JiraIssue {
  const f = raw.fields;
  const status = (f.status ?? {}) as { id?: string; name?: string; statusCategory?: { key?: string } };
  const type = (f.issuetype ?? {}) as NamedIconField;
  const priority = (f.priority ?? {}) as NamedIconField;
  const assignee = (f.assignee ?? undefined) as UserField | undefined;
  const reporter = (f.reporter ?? undefined) as UserField | undefined;
  const parent = (f.parent ?? undefined) as { key?: string } | undefined;
  // All three counters travel together: logging work moves timeSpent and remainingEstimate,
  // so a mirror that carried only the plan would show the ticket unchanged after the write.
  const timetracking = (f.timetracking ?? {}) as {
    originalEstimate?: string;
    timeSpent?: string;
    remainingEstimate?: string;
  };

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
    timeSpent: str(timetracking.timeSpent),
    remainingEstimate: str(timetracking.remainingEstimate),
    startDate: startDateFieldId ? dateOnly(f[startDateFieldId]) : "",
    dueDate: dateOnly(f.duedate),
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
    authorAccountId: w.author?.accountId ?? "",
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
