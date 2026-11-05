// apps/ui/src/lib/plane-view.ts
// The Plane board's decisions that are worth a test, kept out of the .vue files (the
// tasks-view.ts rule): column grouping, the drag→transition decision, the launch dialog's
// preselection, and the few facts Plane spells differently from Jira — the web link, the
// fixed priority enum, worklog minutes, and the address an owner pastes when connecting.
// Pure functions over cloud types — no store, no I/O. The Jira board's twin
// (lib/jira-view.ts) with Plane's shape: one state per column, no workflow.
import type { PlaneColumn, PlaneIntegration, PlaneIssue } from '@kermanych/cloud';
import type { Project } from '@kermanych/core';

// The transition shape GET /plane/issues/.../transitions returns: the project's states
// shaped like a Jira transition (id === stateId). Plane has no workflow, so every state but
// the current one is on offer.
export type PlaneTransitionView = {
  id: string;
  name: string;
  to: { id: string; name: string; statusCategory: { key: string } };
};

// The board's search box, matching the way every other list in the app filters
// (menu.ts's filterByQuery): tokens split on whitespace, EVERY token must appear
// somewhere in the card — so «sandbox андрій» finds the ticket about the sandbox that is
// also Andrii's, with the two words landing in different fields.
//
// The haystack is what a card actually shows: key, summary, assignee, labels, type,
// priority, estimate. `descriptionHtml` is deliberately NOT searched — it is Plane's editor
// markup, so «div» or «href» would match every ticket that carries any formatting.
//
// An empty query returns the input array itself, not a copy: this runs on every keystroke
// and the common case is «nothing typed yet».
export function filterIssues(issues: readonly PlaneIssue[], query: string): readonly PlaneIssue[] {
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!tokens.length) return issues;
  return issues.filter((i) => {
    const hay =
      `${i.key} ${i.summary} ${i.assigneeName ?? ''} ${i.labels.join(' ')} ${i.typeName} ${i.priority} ${i.estimate}`.toLowerCase();
    return tokens.every((t) => hay.includes(t));
  });
}

// The board's assignee filter, the search box's companion in the same bar.
//
// A person's identity here is their Plane user id, falling back to the name: a mirror row
// that carries a name without an id still names a real, filterable person. `UNASSIGNED`
// cannot collide with either — Plane ids are uuids and no display name starts with «@».
export const UNASSIGNED = '@unassigned';

export type PlaneAssigneeOption = { id: string; name: string };

function assigneeIdOf(issue: PlaneIssue): string | undefined {
  return issue.assigneeAccountId ?? issue.assigneeName ?? undefined;
}

// The people the chip offers: everyone who actually holds a card on this board, deduped and
// sorted by name. Derived from the mirror rather than from Plane's member list, so every row
// matches at least one ticket, it costs no Plane call (the budget is 60 a minute), and it
// works offline. Tickets with nobody on them contribute no option — the chip's own
// «Unassigned» row reaches those.
export function assigneeOptions(issues: readonly PlaneIssue[]): PlaneAssigneeOption[] {
  const byId = new Map<string, PlaneAssigneeOption>();
  for (const issue of issues) {
    const id = assigneeIdOf(issue);
    if (id && !byId.has(id)) byId.set(id, { id, name: issue.assigneeName ?? id });
  }
  // localeCompare, not the default sort: «Олексій» must land after «Андрій» by the alphabet
  // the names are written in, not by code point.
  return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name));
}

// `selected` is '' (anyone), UNASSIGNED, or a person's id from `assigneeOptions`. Like
// `filterIssues`, the «nothing picked» case returns the input array itself.
export function filterByAssignee(issues: readonly PlaneIssue[], selected: string): readonly PlaneIssue[] {
  if (!selected) return issues;
  if (selected === UNASSIGNED) return issues.filter((i) => !assigneeIdOf(i));
  return issues.filter((i) => assigneeIdOf(i) === selected);
}

// Cards grouped by state: an issue belongs to the column whose state set holds its state.
// Every Plane column maps exactly one state (the set shape is kept for parity with the Jira
// mirror). An issue in a state with no column — triage, which Plane's states list omits — is
// not on the board, as it is not on Plane's own.
export function issuesByColumn(
  columns: readonly PlaneColumn[],
  issues: readonly PlaneIssue[],
): Record<number, PlaneIssue[]> {
  const out: Record<number, PlaneIssue[]> = {};
  for (const col of columns) out[col.position] = [];
  for (const issue of issues) {
    const col = columns.find((c) => c.stateIds.includes(issue.statusId));
    if (col) out[col.position]!.push(issue);
  }
  // Plane orders a column by its own sort order; the mirror carries none, so newest activity
  // first — the same «що рухається — вгорі» the native board implies.
  for (const col of columns) out[col.position]!.sort((a, b) => b.planeUpdatedAt.localeCompare(a.planeUpdatedAt));
  return out;
}

// What dropping a card on `column` should do, given the states the api offers right now:
//   none — the column's state is not on offer (it vanished since the last sweep); the card
//          snaps back with that sentence.
//   auto — exactly one way in: move immediately, no dialog.
//   pick — kept for parity with the Jira mirror; a single-state column never reaches it.
export type DropDecision =
  | { kind: 'none' }
  | { kind: 'auto'; transition: PlaneTransitionView }
  | { kind: 'pick'; options: PlaneTransitionView[] };

export function transitionChoiceForDrop(
  column: PlaneColumn,
  transitions: readonly PlaneTransitionView[],
): DropDecision {
  const into = transitions.filter((t) => column.stateIds.includes(t.to.id));
  const byState = new Map<string, PlaneTransitionView>();
  for (const t of into) if (!byState.has(t.to.id)) byState.set(t.to.id, t);
  const options = [...byState.values()];
  if (options.length === 0) return { kind: 'none' };
  if (options.length === 1) return { kind: 'auto', transition: options[0]! };
  return { kind: 'pick', options };
}

// The launch dialog's two preselections, Jira's rule unchanged.
//
// Project: the ticket's remembered binding wins (a relaunch must not re-ask), then the
// sidebar's currently selected project, then the only project there is. `undefined` means
// the picker starts empty and the user must choose.
//
// Status: a ticket already in a `started` state ("indeterminate") is NOT moved, so
// `askStatus` is false and no transition travels with the launch. Otherwise the picker is
// shown, preselected to the first state in the started group.
export type LaunchDefaults = {
  projectId?: string;
  askStatus: boolean;
  transitionId?: string;
};

export function launchDefaults(
  issue: PlaneIssue,
  sidebarProjectId: string | null,
  projects: readonly Pick<Project, 'id'>[],
  transitions: readonly PlaneTransitionView[],
): LaunchDefaults {
  const out: LaunchDefaults = { askStatus: issue.statusCategory !== 'indeterminate' };

  const known = (id: string | undefined | null) => (id && projects.some((p) => p.id === id) ? id : undefined);
  const projectId =
    known(issue.kermanychProjectId) ?? known(sidebarProjectId) ?? (projects.length === 1 ? projects[0]!.id : undefined);
  if (projectId) out.projectId = projectId;

  if (out.askStatus) {
    const started = transitions.find((t) => t.to.statusCategory.key === 'indeterminate');
    if (started) out.transitionId = started.id;
  }
  return out;
}

// The dialog's sub-work-item list: direct children, board-mapped or not — a child hidden
// from the columns must still be reachable from its parent.
export function subtasksOf(issues: readonly PlaneIssue[], parentKey: string): PlaneIssue[] {
  return issues.filter((i) => i.parentKey === parentKey);
}

// ── which connected project a key belongs to ──────────────────────────────────

// A work item's key is `${projectIdentifier}-${sequence}`. The identifier is matched up to
// the LAST dash, so the sequence is always what follows it. No match = the mirror no longer
// carries that project, so there is nothing to act on.
export function integrationForKey(
  integrations: readonly PlaneIntegration[],
  key: string,
): PlaneIntegration | undefined {
  const dash = key.lastIndexOf('-');
  if (dash <= 0) return undefined;
  const prefix = key.slice(0, dash).toUpperCase();
  return integrations.find((i) => i.projectIdentifier.toUpperCase() === prefix);
}

// ── the web app ───────────────────────────────────────────────────────────────

// Plane Cloud's three hostnames all mean one web app; a self-hosted instance serves the web
// app from its own origin.
const CLOUD_HOSTS: Record<string, true> = { 'plane.so': true, 'app.plane.so': true, 'api.plane.so': true };
const CLOUD_WEB = 'https://app.plane.so';

export function planeWebBase(siteUrl: string): string {
  try {
    const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(siteUrl) ? siteUrl : `https://${siteUrl}`);
    return CLOUD_HOSTS[url.hostname.toLowerCase()] === true ? CLOUD_WEB : url.origin;
  } catch {
    return siteUrl.replace(/\/+$/, '');
  }
}

// The work item in Plane's own UI: `{web}/{slug}/browse/{KEY}/` — the link Plane itself
// copies («Copy link»), which needs neither the project id nor the item's uuid.
export function planeIssueUrl(
  integration: Pick<PlaneIntegration, 'siteUrl' | 'workspaceSlug'>,
  key: string,
): string {
  return `${planeWebBase(integration.siteUrl)}/${encodeURIComponent(integration.workspaceSlug)}/browse/${encodeURIComponent(key)}/`;
}

// What the owner types or pastes as «Plane address». A pasted workspace URL
// (`https://app.plane.so/my-team/projects/`) carries the workspace slug as its first path
// segment, so it fills both fields at once; a bare origin leaves the slug to the explicit
// field. `slug` is '' when the path does not name a workspace (Plane's own top-level pages
// are not workspaces). Null = not an address at all.
const NOT_A_WORKSPACE: Record<string, true> = {
  api: true,
  accounts: true,
  'create-workspace': true,
  'god-mode': true,
  installations: true,
  invitations: true,
  onboarding: true,
  profile: true,
  'sign-in': true,
  'sign-up': true,
  spaces: true,
  'workspace-invitations': true,
};

export function parsePlaneAddress(raw: string): { site: string; slug: string } | null {
  const input = raw.trim();
  if (!input) return null;
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(input) ? input : `https://${input}`);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  if (!url.hostname.includes('.') && url.hostname !== 'localhost') return null;
  const site = CLOUD_HOSTS[url.hostname.toLowerCase()] === true ? CLOUD_WEB : url.origin;
  const first = url.pathname.split('/').find(Boolean) ?? '';
  // `=== true`, not truthiness: a slug spelled like an Object.prototype member
  // («constructor») must not read as one of Plane's own pages.
  const slug = first && NOT_A_WORKSPACE[first.toLowerCase()] !== true ? first : '';
  return { site, slug };
}

// ── priority ──────────────────────────────────────────────────────────────────

// Plane's fixed enum, urgent first — Plane's own picker order. The labels live in i18n
// (`plane.priority.<value>`); a value the mirror does not know reads as «none».
export const PLANE_PRIORITIES = ['urgent', 'high', 'medium', 'low', 'none'] as const;
export type PlanePriorityValue = (typeof PLANE_PRIORITIES)[number];

export function priorityValue(raw: string): PlanePriorityValue {
  return (PLANE_PRIORITIES as readonly string[]).includes(raw) ? (raw as PlanePriorityValue) : 'none';
}

// The card's priority mark. Plane draws signal bars; the mirror's honest stand-in is the
// coloured dot the Linear card uses, so the two non-Jira boards read alike: urgent is the
// loud one, then high/medium/low taper off, and «none» carries no mark at all.
export type PriorityTone = 'danger' | 'warning' | 'accent' | 'faint';

export function priorityTone(raw: string): PriorityTone | undefined {
  switch (priorityValue(raw)) {
    case 'urgent':
      return 'danger';
    case 'high':
      return 'warning';
    case 'medium':
      return 'accent';
    case 'low':
      return 'faint';
    default:
      return undefined;
  }
}

// ── planning dates ────────────────────────────────────────────────────────────

// Today as Plane spells a day, in the user's OWN calendar: «прострочено» is a statement
// about the day on their wall, so a UTC midnight must not make a card late an evening
// early.
export function todayIso(now = new Date()): string {
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${now.getFullYear()}-${month}-${day}`;
}

// The card's date chip: what to show for a ticket's start/target pair, and whether it is
// late. A completed or cancelled ticket is never overdue — the work it was late for is over.
export type PlaneDateChip = { start: string; due: string; tone: 'plain' | 'soon' | 'overdue' };

export function dateChip(
  issue: Pick<PlaneIssue, 'startDate' | 'dueDate' | 'statusCategory'>,
  today: string,
): PlaneDateChip | undefined {
  // DD.MM: a card chip has room for a day and a month, and on a board the year is noise.
  const start = issue.startDate ? `${issue.startDate.slice(8, 10)}.${issue.startDate.slice(5, 7)}` : '';
  const due = issue.dueDate ? `${issue.dueDate.slice(8, 10)}.${issue.dueDate.slice(5, 7)}` : '';
  if (!start && !due) return undefined;

  let tone: PlaneDateChip['tone'] = 'plain';
  // Lexicographic on YYYY-MM-DD is chronological — no Date, no zone, no drift.
  if (issue.dueDate && issue.statusCategory !== 'done') {
    if (issue.dueDate < today) tone = 'overdue';
    else if (issue.dueDate === today) tone = 'soon';
  }
  return { start, due, tone };
}

// ── worklogs ──────────────────────────────────────────────────────────────────

// A duration in the spelling the worklog field accepts back (`3h 20m`, `45m`), from the
// seconds the mirror keeps. Plane counts whole minutes, so seconds are rounded to them;
// hours are not folded into days — Plane has no working-day length to fold by. Zero (or
// less) is blank: «nothing logged» is not «0m».
export function formatDuration(seconds: number): string {
  const minutes = Math.round(seconds / 60);
  if (minutes <= 0) return '';
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (!h) return `${m}m`;
  return m ? `${h}h ${m}m` : `${h}h`;
}
