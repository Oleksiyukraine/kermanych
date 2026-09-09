// apps/api/src/linear/linear-map.ts
// The tolerant boundary between Linear's payloads and the mirror's rows. Pure functions,
// no I/O: everything here is unit-tested against captured payload shapes, and the sync
// engine stays a thin loop around them.
//
// Tolerance is the design: a missing assignee, an absent estimate or a state Linear
// invents later must degrade to a blank rather than crashing the mapper — a mirror that
// refuses to render is worse than a card with an empty field.
import type { LinearIssue, LinearStatusCategory } from "@kermanych/cloud";
import type { LinearRawAttachment, LinearRawComment, LinearRawIssue, LinearStateSummary } from "./linear-client";

// Mirror child rows carry their scope columns only at write time (replaceLinearIssueChildren
// adds them); the mappers produce the content half.
export type MappedComment = {
  commentId: string;
  authorName: string;
  authorAvatar: string;
  bodyMd: string;
  createdAt: string;
  updatedAt: string;
};

export type MappedAttachment = {
  attachmentId: string;
  title: string;
  subtitle: string;
  url: string;
  createdAt: string;
};

// One board column: exactly one Linear state (unlike Jira's set of statuses per column).
export type MappedColumn = { position: number; name: string; stateIds: string[] };

// The workflow-type order a board reads top-to-bottom. Columns sort by this group first,
// then by each state's own `position` within the group — the layout Linear itself renders.
const TYPE_ORDER = ["triage", "backlog", "unstarted", "started", "completed", "canceled", "duplicate"] as const;

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

// ISO-8601 normalised through Date so Postgres and the sync cursor compare timestamps in
// one spelling.
export function iso(raw: unknown): string {
  const d = typeof raw === "string" ? new Date(raw) : undefined;
  return d && !Number.isNaN(d.getTime()) ? d.toISOString() : new Date(0).toISOString();
}

// A calendar DAY, not an instant: `dueDate` is a TimelessDate and `startedAt` is a datetime
// whose day is the datum. Re-zoning either through Date would move a Kyiv-morning date to
// the previous day in UTC, so the leading YYYY-MM-DD is taken verbatim and only the calendar
// itself is validated: 2026-02-31 is ten digits Postgres would refuse, so it degrades to
// blank like every other unreadable field here.
export function dateOnly(raw: unknown): string {
  const m = typeof raw === "string" ? /^(\d{4}-\d{2}-\d{2})/.exec(raw) : null;
  if (!m) return "";
  const day = m[1]!;
  const parsed = new Date(`${day}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().startsWith(day) ? day : "";
}

// Linear's state type → the mirror's status category, the JiraStatusCategory analog. Work
// in flight is «indeterminate»; both terminal types (done and cancelled) are «done»; every
// pre-start type — triage, backlog, unstarted and the odd duplicate — is «new».
export function categoryFromStateType(type: string): LinearStatusCategory {
  if (type === "started") return "indeterminate";
  if (type === "completed" || type === "canceled") return "done";
  return "new";
}

// The launch dialog's default: the first state in the In-Progress category. `undefined`
// when the workflow offers none — the picker then simply has no preselection.
export function pickInProgressState(states: readonly LinearStateSummary[]): LinearStateSummary | undefined {
  return states.find((s) => categoryFromStateType(s.type) === "indeterminate");
}

// The board layout out of a team's states: sorted by (type-group order, position) and then
// numbered, one state per column. A state whose type Linear invents later sorts to the end
// rather than crashing the sort.
export function orderStates(states: readonly LinearStateSummary[]): MappedColumn[] {
  const rank = (type: string) => {
    const i = TYPE_ORDER.indexOf(type as (typeof TYPE_ORDER)[number]);
    return i === -1 ? TYPE_ORDER.length : i;
  };
  return [...states]
    .sort((a, b) => rank(a.type) - rank(b.type) || a.position - b.position)
    .map((s, position) => ({ position, name: s.name, stateIds: [s.id] }));
}

// The incremental cursor, inclusive-minus-one-minute: re-fetching a boundary issue is
// idempotent while missing one is a hole, the same minute of slack Jira's incrementalJql
// keeps.
export function sinceCursor(cursorIso: string): string {
  return new Date(new Date(cursorIso).getTime() - 60_000).toISOString();
}

export function mapIssue(integration: { id: string; workspaceId: string }, raw: LinearRawIssue): LinearIssue {
  const state = raw.state ?? {};
  const assignee = raw.assignee ?? undefined;
  const parent = raw.parent ?? undefined;
  const labels = raw.labels?.nodes ?? [];

  const issue: LinearIssue = {
    integrationId: integration.id,
    workspaceId: integration.workspaceId,
    issueId: raw.id,
    key: raw.identifier,
    title: str(raw.title),
    // Markdown straight from Linear — no ADF, no rendered HTML: the mirror stores what the
    // ticket dialog renders.
    descriptionMd: str(raw.description),
    priority: num(raw.priority),
    priorityName: str(raw.priorityLabel),
    estimate: num(raw.estimate),
    labels: labels.map((l) => l?.name).filter((n): n is string => typeof n === "string" && n.length > 0),
    stateId: str(state.id),
    stateName: str(state.name),
    stateCategory: categoryFromStateType(str(state.type)),
    url: str(raw.url),
    // `startedAt` is Linear's own timestamp; there is no user-editable start date, so the
    // mirror carries its day read-only.
    startDate: dateOnly(raw.startedAt),
    dueDate: str(raw.dueDate),
    linearUpdatedAt: iso(raw.updatedAt),
    updatedAt: new Date().toISOString(),
  };
  if (assignee?.id) issue.assigneeId = assignee.id;
  const assigneeName = assignee?.displayName || assignee?.name;
  if (assigneeName) issue.assigneeName = assigneeName;
  if (assignee?.avatarUrl) issue.assigneeAvatar = assignee.avatarUrl;
  if (parent?.identifier) issue.parentKey = parent.identifier;
  return issue;
}

export function mapComments(raw: readonly LinearRawComment[]): MappedComment[] {
  return raw.map((c) => ({
    commentId: c.id,
    authorName: c.user?.name ?? "",
    authorAvatar: c.user?.avatarUrl ?? "",
    bodyMd: c.body ?? "",
    createdAt: iso(c.createdAt),
    updatedAt: iso(c.updatedAt),
  }));
}

export function mapAttachments(raw: readonly LinearRawAttachment[]): MappedAttachment[] {
  return raw.map((a) => ({
    attachmentId: a.id,
    title: a.title ?? "",
    subtitle: a.subtitle ?? "",
    url: a.url ?? "",
    createdAt: iso(a.createdAt),
  }));
}
