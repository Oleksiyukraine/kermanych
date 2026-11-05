// apps/api/src/plane/plane-map.ts
// The tolerant boundary between Plane's payloads and the mirror's rows. Pure functions, no
// I/O: everything here is unit-tested against captured payload shapes, and the sync engine
// stays a thin loop around them (the jira-map.ts rule).
//
// Tolerance is the design: a relation that arrives as a bare uuid instead of the expanded
// object, a missing estimate or a state group Plane invents later must degrade to blanks —
// a mirror that refuses to render is worse than a card with an empty field.
import type { PlaneIssue, PlaneStatusCategory } from "@kermanych/cloud";
import type {
  PlaneEstimatePoint,
  PlaneRawAttachment,
  PlaneRawComment,
  PlaneRawIssue,
  PlaneRawWorklog,
  PlaneState,
  PlaneUserLite,
} from "./plane-client";

// Mirror child rows carry their scope columns only at write time (replacePlaneIssueChildren
// adds them); the mappers produce the content half.
export type MappedComment = {
  commentId: string;
  authorName: string;
  authorAvatar: string;
  bodyHtml: string;
  planeCreatedAt: string;
  planeUpdatedAt: string;
};

export type MappedWorklog = {
  worklogId: string;
  authorAccountId: string;
  authorName: string;
  authorAvatar: string;
  timeSpent: string;
  seconds: number;
  startedAt: string;
  description: string;
};

export type MappedAttachment = {
  attachmentId: string;
  filename: string;
  mime: string;
  size: number;
  authorName: string;
  planeCreatedAt: string;
};

export type MappedColumn = { position: number; name: string; stateIds: string[]; stateGroup: string; color: string };

// What mapping a work item needs beyond the payload: the integration's scope, the key
// prefix, the active estimate's type (only `time` estimates become seconds), the project's
// work-item type names (Plane returns `type` as a uuid) and the host relative avatar paths
// hang off.
export type PlaneMapContext = {
  id: string;
  workspaceId: string;
  projectIdentifier: string;
  estimateType?: string;
  typeNames?: ReadonlyMap<string, string>;
  assetBase?: string;
};

// Plane's state groups in board order (spec Decision 5). Triage is not listed by the API;
// a group Plane adds later sorts after these rather than crashing the sort.
const GROUP_ORDER = ["backlog", "unstarted", "started", "completed", "cancelled"] as const;

const PRIORITIES: Record<string, true> = { urgent: true, high: true, medium: true, low: true, none: true };

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

// Timestamps come in the acting user's timezone (`+05:30` offsets), so they are re-spelled
// as UTC through Date: Postgres, the cursor and the staleness comparisons then compare one
// spelling.
function iso(raw: unknown): string {
  const d = typeof raw === "string" ? new Date(raw) : undefined;
  return d && !Number.isNaN(d.getTime()) ? d.toISOString() : new Date(0).toISOString();
}

// A Plane DAY (`start_date`, `target_date`): the leading YYYY-MM-DD verbatim, never
// re-zoned, and blank when it is not a real calendar date — jira-map's dateOnly rule.
export function dateOnly(raw: unknown): string {
  const m = typeof raw === "string" ? /^(\d{4}-\d{2}-\d{2})/.exec(raw) : null;
  if (!m) return "";
  const day = m[1]!;
  const parsed = new Date(`${day}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().startsWith(day) ? day : "";
}

// dateOnly's outbound twin, deliberately STRICT: a blank draft means «clear this date»
// (null is how Plane spells that), an unreadable one is a caller bug that must not clear a
// date the user meant to set.
export function toPlaneDate(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const day = dateOnly(trimmed);
  if (!day) throw new Error(`invalid date: ${trimmed}`);
  return day;
}

export function categoryFromGroup(group: string): PlaneStatusCategory {
  if (group === "started") return "indeterminate";
  if (group === "completed" || group === "cancelled") return "done";
  return "new";
}

// The name a person shows as: Plane's display name, else the full name, else the email.
export function personName(user: PlaneUserLite | undefined): string {
  if (!user) return "";
  const full = [user.first_name, user.last_name].filter((p) => typeof p === "string" && p.trim()).join(" ");
  return str(user.display_name) || full || str(user.email);
}

// `avatar_url` may be a path on the Plane host (`/api/assets/…`) rather than a URL.
export function personAvatar(user: PlaneUserLite | undefined, assetBase = ""): string {
  const raw = str(user?.avatar_url) || str(user?.avatar);
  return raw.startsWith("/") && assetBase ? `${assetBase}${raw}` : raw;
}

// Minutes in Jira's display spelling, hours and minutes only («1h 30m», «2h», «45m»).
// No days or weeks: a Plane day has no agreed length, and «1d» would invent one. Blank for
// none, the mirror's tolerant-blank convention.
export function formatMinutes(minutes: number): string {
  const total = Math.round(minutes);
  if (!(total > 0)) return "";
  const h = Math.floor(total / 60);
  const m = total % 60;
  return [h ? `${h}h` : "", m ? `${m}m` : ""].filter(Boolean).join(" ");
}

// The log-work duration in Jira's spelling («3h 20m», «45m», «1.5h», «3h20m»; a bare
// number is minutes) → Plane's whole minutes. STRICT: anything else is refused in words
// before it reaches Plane, which would store a garbage duration or refuse it in field-dict
// JSON.
export function parseDurationToMinutes(raw: string): number {
  const text = raw.trim().toLowerCase();
  const bare = /^\d+(?:[.,]\d+)?$/.test(text);
  const m = bare ? null : /^(?:(\d+(?:[.,]\d+)?)\s*h)?\s*(?:(\d+(?:[.,]\d+)?)\s*m)?$/.exec(text);
  if (!bare && (!m || (m[1] === undefined && m[2] === undefined)))
    throw new Error(`unreadable duration: «${raw.trim()}» (use 3h 20m, 45m or 1.5h)`);
  const num = (v: string | undefined): number => Number((v ?? "0").replace(",", "."));
  const minutes = Math.round(bare ? num(text) : num(m![1]) * 60 + num(m![2]));
  if (minutes <= 0) throw new Error(`duration must be positive: «${raw.trim()}»`);
  return minutes;
}

// The incremental cursor, inclusive-minus-one-minute: re-reading a boundary item is
// idempotent while missing one is a hole (Jira's and Linear's same minute of slack).
export function sinceCursor(cursorIso: string): string {
  return new Date(new Date(cursorIso).getTime() - 60_000).toISOString();
}

// One column per state, ordered by group (backlog → … → cancelled) then by Plane's own
// sequence within the group, then numbered.
export function buildColumns(states: readonly PlaneState[]): MappedColumn[] {
  const rank = (group: string): number => {
    const i = GROUP_ORDER.indexOf(group as (typeof GROUP_ORDER)[number]);
    return i === -1 ? GROUP_ORDER.length : i;
  };
  return [...states]
    .sort((a, b) => rank(str(a.group)) - rank(str(b.group)) || (a.sequence ?? 0) - (b.sequence ?? 0))
    .map((s, position) => ({ position, name: s.name, stateIds: [s.id], stateGroup: str(s.group), color: str(s.color) }));
}

// An estimate point's minutes, for a `time` estimate only (spec Decision 10: its values are
// read as minutes — a bare number — or, tolerantly, in the duration spelling).
function estimateMinutes(value: string): number {
  if (!value.trim()) return 0;
  try {
    return parseDurationToMinutes(value);
  } catch {
    return 0;
  }
}

// `spentMinutes` is the item's worklog total. The list endpoint does not carry it; the
// caller passes what it knows (the per-project totals, the item's worklogs, or the mirror's
// previous value).
export function mapIssue(ctx: PlaneMapContext, raw: PlaneRawIssue, spentMinutes = 0): PlaneIssue {
  const state = raw.state && typeof raw.state === "object" ? raw.state : undefined;
  const firstAssignee = raw.assignees?.[0];
  const assignee = firstAssignee && typeof firstAssignee === "object" ? firstAssignee : undefined;
  const reporter = raw.created_by && typeof raw.created_by === "object" ? raw.created_by : undefined;
  const point: PlaneEstimatePoint | undefined =
    raw.estimate_point && typeof raw.estimate_point === "object"
      ? raw.estimate_point
      : typeof raw.estimate_point === "string"
        ? { id: raw.estimate_point }
        : undefined;
  const pointValue = str(point?.value);
  const isTime = ctx.estimateType === "time";
  const estimateMins = isTime ? estimateMinutes(pointValue) : 0;
  const typeId = typeof raw.type === "string" ? raw.type : (raw.type?.id ?? raw.type_id ?? undefined);
  const typeName = (raw.type && typeof raw.type === "object" ? str(raw.type.name) : "") || (typeId ? (ctx.typeNames?.get(typeId) ?? "") : "");
  const spent = Math.max(0, Math.round(spentMinutes));
  const parent = raw.parent && typeof raw.parent === "object" ? raw.parent : undefined;

  const issue: PlaneIssue = {
    integrationId: ctx.id,
    workspaceId: ctx.workspaceId,
    issueId: raw.id,
    key: `${ctx.projectIdentifier}-${raw.sequence_id ?? ""}`,
    summary: str(raw.name),
    descriptionHtml: str(raw.description_html),
    typeName,
    priority: PRIORITIES[str(raw.priority)] ? str(raw.priority) : "none",
    labels: (raw.labels ?? []).flatMap((l) => (l && typeof l === "object" && l.name ? [l.name] : [])),
    // A time estimate reads as a duration; points and categories read as Plane shows them.
    estimate: isTime && estimateMins ? formatMinutes(estimateMins) : pointValue,
    originalEstimateSeconds: estimateMins * 60,
    timeSpent: formatMinutes(spent),
    timeSpentSeconds: spent * 60,
    startDate: dateOnly(raw.start_date),
    dueDate: dateOnly(raw.target_date),
    statusId: typeof raw.state === "string" ? raw.state : str(state?.id),
    statusName: str(state?.name),
    statusCategory: categoryFromGroup(str(state?.group)),
    planeUpdatedAt: iso(raw.updated_at),
    updatedAt: new Date().toISOString(),
  };
  if (point?.id) issue.estimatePointId = point.id;
  if (typeof firstAssignee === "string") issue.assigneeAccountId = firstAssignee;
  if (assignee?.id) issue.assigneeAccountId = assignee.id;
  const assigneeName = personName(assignee);
  if (assigneeName) issue.assigneeName = assigneeName;
  const avatar = personAvatar(assignee, ctx.assetBase);
  if (avatar) issue.assigneeAvatar = avatar;
  const reporterName = personName(reporter);
  if (reporterName) issue.reporterName = reporterName;
  // A parent must live in the same project (Plane's rule), so its key shares the prefix.
  if (parent && typeof parent.sequence_id === "number") issue.parentKey = `${ctx.projectIdentifier}-${parent.sequence_id}`;
  return issue;
}

// Who a uuid is, from the project's member list — worklogs and attachments name their
// author by id only.
function person(ref: string | PlaneUserLite | null | undefined, people: ReadonlyMap<string, PlaneUserLite>): PlaneUserLite | undefined {
  if (!ref) return undefined;
  return typeof ref === "string" ? people.get(ref) : ref;
}

export function mapComments(raw: readonly PlaneRawComment[], assetBase = ""): MappedComment[] {
  return raw.map((c) => {
    const actor = c.actor && typeof c.actor === "object" ? c.actor : undefined;
    return {
      commentId: c.id,
      authorName: personName(actor),
      authorAvatar: personAvatar(actor, assetBase),
      bodyHtml: str(c.comment_html),
      planeCreatedAt: iso(c.created_at),
      planeUpdatedAt: iso(c.updated_at ?? c.created_at),
    };
  });
}

// Plane's minutes become the mirror's seconds and Jira's display spelling; `created_at` is
// the only date an entry has, so it is the «started» instant.
export function mapWorklogs(
  raw: readonly PlaneRawWorklog[],
  people: ReadonlyMap<string, PlaneUserLite> = new Map(),
  assetBase = "",
): MappedWorklog[] {
  return raw.map((w) => {
    const ref = w.logged_by ?? w.created_by;
    const author = person(ref, people);
    const minutes = typeof w.duration === "number" && w.duration > 0 ? Math.round(w.duration) : 0;
    return {
      worklogId: w.id,
      authorAccountId: (typeof ref === "string" ? ref : ref?.id) ?? "",
      authorName: personName(author),
      authorAvatar: personAvatar(author, assetBase),
      timeSpent: formatMinutes(minutes),
      seconds: minutes * 60,
      startedAt: iso(w.created_at),
      description: str(w.description),
    };
  });
}

// Half-finished uploads (is_uploaded false) are not files yet; Plane does not list them,
// and a payload that does is filtered the same way.
export function mapAttachments(
  raw: readonly PlaneRawAttachment[],
  people: ReadonlyMap<string, PlaneUserLite> = new Map(),
): MappedAttachment[] {
  return raw
    .filter((a) => a.is_uploaded !== false)
    .map((a) => {
      const size = a.attributes?.size ?? a.size;
      return {
        attachmentId: a.id,
        filename: str(a.attributes?.name),
        mime: str(a.attributes?.type),
        size: typeof size === "number" && Number.isFinite(size) ? Math.round(size) : 0,
        authorName: personName(person(a.created_by, people)),
        planeCreatedAt: iso(a.created_at),
      };
    });
}

// Which mirrored items get their comments/attachments/worklogs refetched this tick (spec
// Decision 8): never mirrored, changed since the last child refresh, or — when the
// project's worklog totals are known — logged time that no longer matches the mirror.
// Oldest refresh first, so a long queue drains fairly; at most `limit`.
export function pickChildrenDue(
  issues: readonly Pick<PlaneIssue, "issueId" | "planeUpdatedAt" | "childrenSyncedAt" | "timeSpentSeconds">[],
  totalsMinutes: ReadonlyMap<string, number> | undefined,
  limit: number,
): string[] {
  const stamp = (s: string | undefined): number => (s ? new Date(s).getTime() : 0);
  return issues
    .filter(
      (i) =>
        !i.childrenSyncedAt ||
        stamp(i.childrenSyncedAt) < stamp(i.planeUpdatedAt) ||
        (totalsMinutes !== undefined && Math.round(totalsMinutes.get(i.issueId) ?? 0) * 60 !== i.timeSpentSeconds),
    )
    .sort((a, b) => stamp(a.childrenSyncedAt) - stamp(b.childrenSyncedAt) || stamp(a.planeUpdatedAt) - stamp(b.planeUpdatedAt))
    .slice(0, limit)
    .map((i) => i.issueId);
}

// The later of two instants as ISO — the child-refresh stamp must not land before the
// item's own `updated_at` when Plane's clock runs ahead of ours, or the item would stay due
// forever.
export function laterIso(a: string, b: string): string {
  return new Date(Math.max(new Date(a).getTime() || 0, new Date(b).getTime() || 0)).toISOString();
}
