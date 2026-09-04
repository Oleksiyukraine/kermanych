# Team Capacity — design

Date: 2026-09-04
Status: draft, awaiting review

## Assumptions (unconfirmed with the requester — confirm before implementation)

The requester was unavailable to answer clarifying questions, so the design proceeds on the
recommended defaults. Each is a one-line change if wrong.

1. **«Zero board» means the Jira board.** No such identifier exists in the codebase; Jira is
   the only integration board, the only one with estimations, and is contrasted against the
   «native board» everywhere. Team Capacity is enabled only when the workspace has a Jira
   integration (`workspace_jira_integrations` row). For a workspace with only the native
   board the section shows a «connect Jira» notice.
2. **Capacity baseline = 8 h per business day (Mon–Fri) per person.** Nothing in the app
   stores working hours; 8 h is also Jira's default `1d`. A per-member hours table is a
   later increment and is designed for (§ Later) but not built.
3. **Time placement.** Future load is the issue's *remaining* estimate spread evenly over
   the business days between its start date (or today, whichever is later) and its due
   date. Past load is *logged work* (worklogs). Details in § Capacity model.
4. **Chart = stacked bars per period** (day or week on the X axis, one segment per person,
   a capacity marker per bar). Hand-rolled SVG — the repo has no chart library and the
   design system is bespoke.
5. **«For the project»** in the chat means the workspace's Jira project (one board per
   workspace). A breakdown per *Kermanych* project is out of scope: `jira_issues.
   kermanych_project_id` is set only when a ticket is launched, so it would be mostly empty.

## Goal

A real screen behind the `management-capacity` placeholder that shows, for a chosen date
range, how much work the team (or one person) has against how much time they have —
as a chart and as a table — and a Менеджмент-assistant that can answer «what is the
team's / Marina's capacity for the next two weeks» with the same numbers.

## Non-goals

- Editing anything. Load comes from Jira; the way to change it is editing tickets in Jira
  (the screen links there). The section's capability becomes `read`, not `read_write`.
- Story points, velocity, sprints, per-project splits, day-offs / vacations, per-member
  hours (designed for, not built).
- Mapping Jira accounts to Kermanych members. The unit of «person» on this screen is the
  **Jira assignee** (`assigneeAccountId`), because that is who the estimates belong to.

## Architecture

```
Jira Cloud ──sync (api, exists)──► jira_issues (+3 new *_seconds columns)
                                   jira_worklogs (exists, has `seconds`)
                                          │
                       browser, user's JWT (packages/cloud, exists + 1 new read)
                                          │
                            apps/ui/src/lib/capacity.ts  ← ONE pure function
                              ┌───────────┴────────────┐
                 ManagementCapacityPage.vue      management-chat.ts capacityDigest()
                 (chart · table · range · person)        │
                                                  POST /management/chat context.capacity
                                                         │
                                          management-prompt.ts contextBlock() prints it
```

Three rules already in force in this codebase decide the shape:

- **Cloud data is read in the browser under the user's JWT; the API grows no cloud
  credentials.** So the maths runs in `apps/ui/src/lib`, exactly like `lib/risk.ts` and
  `lib/jira-view.ts`, and the chat receives a *digest* on the ask, like risks and members.
- **Pure logic in `lib/*.ts`, view state in `.vue`.** `lib/capacity.ts` is a pure
  function of `(issues, worklogs, options)`; the page and the chat digest both call it,
  so the assistant's numbers are the screen's numbers.
- **Result lines are the app's, never the model's.** The assistant only *reads* here, so
  no new action kind and no executor branch; it answers in prose from the context block.

### Approaches considered

- **A. Browser-side pure lib over the mirror + widen the sync to carry seconds
  (chosen).** Fits every existing invariant, one implementation serves the screen and
  the chat, fully unit-testable without Jira.
- **B. An API endpoint that computes capacity.** The API does hold a cloud client for
  sync, but every screen-facing read in the app is browser-side and the chat digest
  pattern is browser-side; an API path would be a second convention and would still need
  the browser to pass a range. Rejected.
- **C. Parse Jira's `"2w 3d 4h"` strings in the browser, no schema change.** Jira's
  `1w`/`1d` conversion is per-site configurable (`/rest/api/3/configuration`), so a
  parser is either wrong on some sites or needs another sync path for the config.
  Jira's `timetracking` field already returns `originalEstimateSeconds` /
  `timeSpentSeconds` / `remainingEstimateSeconds` next to the strings. Rejected in
  favour of carrying those.

## 1. Data: numeric estimates in the mirror

**Migration** `supabase/migrations/20260904090000_jira_estimate_seconds.sql`:

```sql
alter table public.jira_issues
  add column original_estimate_seconds  integer not null default 0,
  add column time_spent_seconds         integer not null default 0,
  add column remaining_estimate_seconds integer not null default 0;
```

`0` = Jira holds none (same convention as `jira_worklogs.seconds`). No RLS change: the
table's member policy already covers the new columns.

**Types** — `packages/cloud/src/types.ts` `JiraIssue` gains
`originalEstimateSeconds`, `timeSpentSeconds`, `remainingEstimateSeconds: number`.
`packages/cloud/src/jira.ts` `toJiraIssue` / `toJiraIssueRow` map the three columns.

**Mapper** — `apps/api/src/jira/jira-map.ts` `mapIssue` reads the three `*Seconds`
siblings from the same `timetracking` object it already reads (no change to
`ISSUE_FIELDS`). `apps/api/test/jira-map.spec.ts` gets a case with all three present and a
case with the object absent (→ 0).

**Backfill** — none needed: the next full sweep (every 10 min, or «Sync now») re-upserts
every issue. The page shows the standard «syncing» state in the meantime.

**New cloud read** — `packages/cloud/src/jira.ts`:

```ts
export async function listJiraWorklogsBetween(
  client, integrationId, fromIso /* inclusive instant */, toIso /* exclusive instant */,
): Promise<JiraWorklog[]>
```

`jira_worklogs` filtered by `integration_id` and `started_at` range, ordered by
`started_at`. Index: `jira_worklogs_issue_idx` is `(integration_id, issue_id)`; add
`jira_worklogs_started_idx on (integration_id, started_at)` in the same migration.

## 2. Capacity model — `apps/ui/src/lib/capacity.ts` (pure)

```ts
export type CapacityRange = { from: string; to: string };          // YYYY-MM-DD, inclusive
export type CapacityGranularity = 'day' | 'week';

export type CapacityOptions = {
  range: CapacityRange;
  today: string;                 // YYYY-MM-DD, caller-supplied (testability, as todayIso)
  hoursPerDay?: number;          // default 8
  granularity?: CapacityGranularity; // default: 'day' when range ≤ 31 days, else 'week'
  person?: string;               // assigneeAccountId — restrict the report to one person
};

export type CapacityPerson = { id: string; name: string; avatar?: string };  // id = accountId; UNASSIGNED for none

export type CapacityPeriod = {
  key: string;                   // 'YYYY-MM-DD' (day) or ISO-week Monday 'YYYY-MM-DD' (week)
  from: string; to: string;      // inclusive
  businessDays: number;
  past: boolean;                 // whole period before today
};

export type CapacityCell = {
  capacitySeconds: number;       // businessDays × hoursPerDay × 3600
  plannedSeconds: number;        // spread remaining estimates (future days only)
  loggedSeconds: number;         // worklogs (past days and today)
  loadSeconds: number;           // planned + logged — what the bar shows
  utilization: number;           // loadSeconds / capacitySeconds, 0 when capacity is 0
};

export type CapacityIssueRow = {   // the table's per-issue breakdown
  key: string; summary: string; person: CapacityPerson; statusName: string;
  statusCategory: JiraStatusCategory;
  startDate: string; dueDate: string;
  remainingSeconds: number; originalSeconds: number; spentSeconds: number;
  inRangeSeconds: number;        // the part of the remaining estimate that lands inside the range
  flag?: 'overdue' | 'unscheduled' | 'unestimated';
};

export type CapacityReport = {
  periods: CapacityPeriod[];
  persons: CapacityPerson[];     // sorted by total load desc, UNASSIGNED last
  cells: Record<string /* person.id */, CapacityCell[]>;   // parallel to periods
  totals: CapacityCell[];        // per period, all persons
  summary: CapacityCell;         // whole range, all persons
  issues: CapacityIssueRow[];    // every open issue touching the range + flagged ones
  unscheduled: CapacityIssueRow[]; // open, estimated, no due date — not on the timeline
  overdue: CapacityIssueRow[];   // open, estimated, due < today — landed on today
};

export function capacityReport(issues: JiraIssue[], worklogs: JiraWorklog[], opts: CapacityOptions): CapacityReport;
```

Rules, in order:

1. **Business days** are Mon–Fri. Weekends have `capacitySeconds = 0` and take no planned
   load; a worklog on a weekend still counts as logged (people do log on Saturdays).
2. **Past (day < today): logged.** Each worklog is attributed to `authorAccountId` on the
   local calendar day of `startedAt`. Nothing is planned into the past — an estimate that
   was never logged is not «load that happened».
3. **Today and future: planned.** For every issue with `statusCategory !== 'done'`:
   - `remaining = remainingEstimateSeconds || max(originalEstimateSeconds − timeSpentSeconds, 0)`.
     If both are 0 → `flag: 'unestimated'`, listed in `issues`, contributes nothing.
   - no `dueDate` → `flag: 'unscheduled'`, contributes nothing to periods, listed in
     `unscheduled`. (The screen shows the count prominently: unscheduled estimated work is
     the main reason a capacity view under-reports.)
   - window = `[max(startDate ?? today, today), dueDate]` in business days.
     `dueDate < today` → `flag: 'overdue'`, window = `[today, today]` (the whole remaining
     estimate lands on today, which is what «overdue» looks like on a capacity chart).
   - `remaining` is spread evenly over the window's business days; the part falling inside
     the range is `inRangeSeconds`. A window with 0 business days (due on a weekend, start
     after due) collapses to the due date.
   - Today also receives worklogs logged today; both count.
4. **Subtasks.** Each issue's own `timetracking` is counted; parents with subtasks usually
   carry no estimate of their own in Jira. Documented, not «rolled up» — Jira's own
   «Σ» fields are aggregates the mirror does not carry.
5. **Person filter.** `opts.person` restricts `persons`, `cells`, `totals`, `summary`,
   `issues` to that assignee (worklogs by author, issues by assignee).
6. **Weekly granularity.** Days are first computed per day, then summed into ISO weeks
   (Monday-start); `capacitySeconds` sums business days actually inside the range, so a
   partial first/last week is not over-credited.

Tests (`apps/ui/test/capacity.spec.ts`): weekend handling, past = logged only, spread over
a start→due window, due-only fallback, overdue landing on today, unscheduled bucket,
remaining-fallback arithmetic, person filter, weekly roll-up with partial weeks, empty
inputs, granularity default at 31/32 days.

## 3. Store — `apps/ui/src/stores/jira.ts`

Two additions, no new store:

- `worklogs: ref<JiraWorklog[]>` + `worklogRange: ref<CapacityRange | undefined>` and
  `async loadWorklogs(workspaceId, range)` → `listJiraWorklogsBetween`. Loaded for the
  requested range with one day of padding either side (time zones). Reloaded when the
  range changes or on the existing 30-s sync tick when the page is open (same pattern
  `loadBoard` uses).
- `issues` already holds the whole project (full JQL, done included) and is realtime.

## 4. Screen — `apps/ui/src/pages/ManagementCapacityPage.vue`

Promoted in `router/routes.ts` `SECTION_PAGES`. Props `{ workspaceId, workspaceName }`
like every section.

**Gate.** `jira.probe(workspaceId)` on mount / workspace change.
- `integration === undefined` → the page's skeleton.
- `integration === null` → a dashed notice card (same look as `ManagementSectionPage`):
  «Team Capacity reads estimates from Jira. Connect a Jira board in Integrations» with a
  `KBtn` routing to `management-integrations`. This is the whole «regular board only»
  behaviour — no capacity feature for the native board, stated rather than hidden.
- integration present → `jira.open(workspaceId)` (issues, columns, realtime) +
  `loadWorklogs`.

**Toolbar** (one row, wraps on narrow widths):
- **Range**: two `KDateField`s (from, to) + a `KChipSelect` of presets: *This week · Next
  week · Next 2 weeks · This month · Next month · Last 2 weeks*. Presets set both dates;
  editing a date deselects the preset. `to < from` swaps. Default: *Next 2 weeks*.
  Persisted per workspace in `localStorage` (`capacity:<workspaceId>`), like `boardView`.
- **Person**: `KSelect` — *Whole team* + every `CapacityPerson` from the report of the
  *unfiltered* run (so the list does not shrink when you pick someone).
- **View**: `KTabs` *Chart · Table*.
- **Granularity**: `KTabs` *Days · Weeks*, defaulting from the range length; user
  override sticks until the range changes.

**Summary tiles** above the view (4 `KPanel`s, mono numbers): Capacity, Planned, Logged,
Utilization %. Utilization coloured by band: `< 80%` muted, `80–100%` success,
`100–120%` warning, `> 120%` danger. A fifth chip: «N unscheduled · M overdue» that
switches the table to those rows when clicked.

**Chart** — `apps/ui/src/components/capacity/CapacityChart.vue`, inline SVG:
- X = periods, Y = hours. One stacked bar per period; team mode = one segment per person
  (top 8 by load; the rest folded into «Others»), person mode = one segment.
- Past periods render as logged (solid), future as planned (hatched pattern) — the two
  are different facts and the chart should look different where the boundary is. A thin
  «today» rule between them.
- Capacity marker: a short horizontal tick per bar at `capacitySeconds`; a bar above its
  tick gets a danger outline.
- Legend (persons) below; clicking a legend swatch sets the person filter.
- Hover: `v-tip` on each segment «Marina · 12h of 40h · W37».
- Colours: per-person categorical palette derived from design tokens (accent, success,
  warning, and 5 additional hue-rotated `color-mix` steps), validated for contrast in
  both themes; overdue/over-capacity use `--k-danger`. The dataviz skill's palette rules
  apply at implementation time.
- Reduced motion: no bar-grow animation.

**Table** — `KTable`, two shapes by mode:
- Team: rows = persons (+ *Total*), columns = one per period (`load h / cap h`, cell
  background = utilization band), then *Total*, *Util %*, *Open issues*. Row click sets
  the person filter.
- Person / issues: rows = `issues` for the selected person (or all, when the
  unscheduled/overdue chip is active), columns: Key (link to Jira), Summary, Status
  (`KTag`), Start, Due, Remaining, In range, Flag. Sorted by due date, flagged rows first.

**Empty / error states**: no estimates at all in range → the chart area says «no
estimated work in this range» and points at the unscheduled count; `loadError` from the
store renders the same error line the board uses.

**Formatting**: hours with one decimal (`lib/format.ts` gets `hours(seconds)`), dates
through `lib/calendar.ts`, every label through i18n (en + uk — the completeness spec
enforces parity).

## 5. Chat — the assistant answers from the same numbers

**Section table** (`packages/core/src/management.ts`): `management-capacity` becomes
`capability: "read"` with limitation «розділ лише читає оцінки й ворклоги Jira —
навантаження змінюється редагуванням тікетів у Jira, не з чату». The refusal path for
write attempts keeps working unchanged.

**Context** (`packages/core/src/management-actions.ts`):

```ts
export type ManagementCapacityWeek = { week: string /* Monday YYYY-MM-DD */; capacityH: number; plannedH: number; loggedH: number };
export type ManagementCapacityPerson = { name: string; weeks: ManagementCapacityWeek[]; openIssues: number; unscheduled: number; overdue: number };
export type ManagementCapacity = {
  from: string; to: string; hoursPerDay: number;
  team: ManagementCapacityWeek[];            // totals per week
  persons: ManagementCapacityPerson[];
  unscheduled: number; overdue: number;      // team-wide counts
};
ManagementContext.capacity?: ManagementCapacity;   // present only with a Jira integration
```

**Digest** (`apps/ui/src/stores/management-chat.ts` `capacityDigest`): runs
`capacityReport` with `granularity: 'week'` over a fixed window **2 weeks back → 6 weeks
ahead** (today's ISO week −2 … +5), hours rounded to one decimal. Loads worklogs for that
window through the same store method the page uses. Sent every turn, like the register,
because estimates move between turns. Size: ~1 line per person, bounded by the roster of
Jira assignees; persons with zero load in the window are folded into one «no load» line.

**Prompt** (`apps/api/src/management/management-prompt.ts`):
- `contextBlock` prints a `capacityLines(c.capacity)` block:
  `Навантаження (Jira, 8 год/день, тижні з понеділка) — W36 2026-08-31 … :` then one line
  per person `- Марина · W36 32/40 (логовано) · W37 45/40 · W38 12/40 · відкритих 7 ·
  без дати 2 · прострочено 1`, then the team total line, then the unscheduled/overdue
  counts. Absent integration → «Навантаження: недоступне — воркспейс без дошки Jira».
- A `capacityProtocol()` paragraph in the contract: answer capacity questions **only** from
  these lines; give a breakdown by person and by week; say plainly when the asked range is
  outside the window and point at the Team Capacity screen's date picker; past weeks are
  logged work, current/future weeks are estimates; never invent a person not listed;
  «capacity of the project» means this Jira project.
- `MANAGEMENT_SECTIONS` printing already reflects the new capability.

**Controller** (`apps/api/src/http/management.controller.ts`): a `capacity(v)` sanitizer
rebuilding the digest with caps (≤ 60 persons, ≤ 12 weeks, finite non-negative numbers),
the way `riskRows` / `memberRows` / `jiraBoard` do.

Tests: `packages/core/test/management-actions.spec.ts` (capacity section now `read`,
still refuses writes), `apps/api/test/management-prompt.spec.ts` (capacity lines with and
without integration, wording), `apps/api/test/management-controller.spec.ts` (sanitizer
caps), `apps/ui/test/management-capacity-digest.spec.ts` (digest window and rounding
against a fixed today), `apps/api/test/management-chat.spec.ts` unchanged.

## 6. i18n and docs

- `apps/ui/src/i18n/{en,uk}/index.ts`: `management.capacity.*` (toolbar, tiles, table
  headers, presets, flags, empty/gate states), updated `management.section.
  management-capacity.limitation`.
- `README.md` «The Менеджмент tab and its assistant»: a paragraph on Team Capacity and the
  capacity context block; the «what the assistant refuses» sentence updated.

## 7. Files touched

| Layer | File | Change |
|---|---|---|
| db | `supabase/migrations/20260904090000_jira_estimate_seconds.sql` | new |
| cloud | `packages/cloud/src/types.ts`, `src/jira.ts`, `test/jira.spec.ts` | 3 fields, 1 read, index |
| api | `apps/api/src/jira/jira-map.ts`, `test/jira-map.spec.ts` | read `*Seconds` |
| core | `packages/core/src/management.ts`, `src/management-actions.ts`, tests | capability `read`, `ManagementCapacity` |
| api | `apps/api/src/management/management-prompt.ts`, `src/http/management.controller.ts`, tests | capacity lines, protocol, sanitizer |
| ui lib | `apps/ui/src/lib/capacity.ts`, `lib/format.ts`, `test/capacity.spec.ts` | new |
| ui store | `apps/ui/src/stores/jira.ts`, `stores/management-chat.ts`, tests | worklogs, digest |
| ui page | `apps/ui/src/pages/ManagementCapacityPage.vue`, `components/capacity/CapacityChart.vue`, `router/routes.ts` | new screen |
| ui i18n | `apps/ui/src/i18n/en/index.ts`, `uk/index.ts` | keys |
| docs | `README.md` | section |

## 8. Later (designed for, not built)

- **Per-member hours / days off**: a `workspace_capacity_settings (workspace_id,
  account_id, hours_per_day, …)` table feeding `CapacityOptions.hoursPerDay` as a
  per-person map. The lib already takes hours as an option so this is additive.
- **Native board**: if `tasks` ever gains an estimate column, `capacityReport` accepts a
  second issue source through the same shape.
- **Per Kermanych project**: group by `kermanychProjectId` once launch bindings are common.
