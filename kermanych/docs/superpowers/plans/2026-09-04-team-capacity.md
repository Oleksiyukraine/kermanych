# Team Capacity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A real Team Capacity screen (chart + table + date range + per-person view) fed by Jira estimates and worklogs, and a Менеджмент assistant that answers capacity questions from the same numbers.

**Architecture:** The Jira mirror gains numeric estimate columns (synced from Jira's `timetracking.*Seconds`). One pure function `capacityReport()` in `apps/ui/src/lib/capacity.ts` turns issues + worklogs + a range into per-person, per-period cells; `ManagementCapacityPage.vue` renders it, and `stores/management-chat.ts` compresses it into a weekly digest sent as `context.capacity` that `management-prompt.ts` prints into the assistant's context block. No new action kinds: capacity is read-only.

**Tech Stack:** pnpm monorepo, TypeScript strict. `apps/ui` Vue 3 + Quasar + Pinia + vue-i18n + hand-rolled `K*` kit (no chart lib, no Tailwind). `apps/api` NestJS. `packages/core` domain, `packages/cloud` Supabase access. Tests: vitest everywhere. Typecheck: `pnpm --filter @kermanych/ui typecheck` (vue-tsc) and `pnpm --filter @kermanych/api typecheck`.

**Spec:** `docs/superpowers/specs/2026-09-04-team-capacity-design.md`

## Global Constraints

- Repo root for every command: `/Users/andriichesnokov/.kermanych/worktrees/16c31275-00f1-4e6e-96e9-0868bea6b8ed/kermanych`.
- Cloud tables are read/written **in the browser under the user's JWT**; the API grows **no** cloud credentials or write paths (README «Giving another section something it can write»).
- Pure logic lives in `apps/ui/src/lib/*.ts` and is unit-tested; `.vue` files hold view state only.
- Every user-facing string goes through i18n, and **both** `apps/ui/src/i18n/en/index.ts` and `apps/ui/src/i18n/uk/index.ts` must carry the same keys (`apps/ui/test/i18n-completeness.spec.ts` fails otherwise).
- Prompt bodies in `apps/api/src/management/management-prompt.ts` are Ukrainian; only the «answer in X» directive is localized.
- «Zero board» = the Jira board. Capacity baseline = **8 h per business day (Mon–Fri)**. Future load = remaining estimate spread evenly over business days from `max(startDate, today)` to `dueDate`; past load = worklogs. Undated open issues go to an «unscheduled» bucket; overdue issues land on today.
- Dates are `YYYY-MM-DD` strings compared lexicographically; day arithmetic goes through `apps/ui/src/lib/calendar.ts` (`shiftDays`, `isoParts`, `isoOf`, `todayIso`) — never `new Date('YYYY-MM-DD')`.
- Comment register: the codebase justifies design decisions inline; new code should say *why*, briefly, in the same voice.
- Commit after every task with a `feat(capacity): …` / `test(capacity): …` message ending in `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.

---

### Task 1: Mirror carries numeric estimates

**Files:**
- Create: `supabase/migrations/20260904090000_jira_estimate_seconds.sql`
- Modify: `packages/cloud/src/types.ts:400-405` (`JiraIssue`)
- Modify: `packages/cloud/src/jira.ts:25-26` (`ISSUE_COLUMNS`), `:55-84` (`IssueRow`), `:145-177` (`toJiraIssue`), `:183-212` (`toJiraIssueRow`)
- Modify: `packages/cloud/test/jira.spec.ts:41-73` (fixture) and add a case
- Modify: `packages/cloud/test/rls.spec.ts:1085-1100` (fixture), `apps/ui/test/jira-view.spec.ts:28-50` (fixture)

**Interfaces:**
- Produces: `JiraIssue.originalEstimateSeconds: number`, `JiraIssue.timeSpentSeconds: number`, `JiraIssue.remainingEstimateSeconds: number` (0 = Jira holds none). Columns `original_estimate_seconds`, `time_spent_seconds`, `remaining_estimate_seconds` on `public.jira_issues`.

- [ ] **Step 1: Write the migration**

```sql
-- supabase/migrations/20260904090000_jira_estimate_seconds.sql
-- Team Capacity needs arithmetic on estimates, and the three display strings beside these
-- («2w 3d 4h») cannot be added up without knowing the site's own 1w/1d conversion. Jira's
-- `timetracking` field carries the same three counters in seconds, so the mirror keeps
-- both: the string is what the ticket dialog shows, the number is what capacity sums.
-- 0 = Jira holds none — the tolerant-blank convention of `jira_worklogs.seconds`.
alter table public.jira_issues
  add column original_estimate_seconds  integer not null default 0,
  add column time_spent_seconds         integer not null default 0,
  add column remaining_estimate_seconds integer not null default 0;

-- The capacity screen reads worklogs by calendar range across the whole board, which the
-- per-issue index cannot serve.
create index jira_worklogs_started_idx on public.jira_worklogs (integration_id, started_at);
```

- [ ] **Step 2: Add the three fields to the type**

In `packages/cloud/src/types.ts`, directly after `remainingEstimate: string;` (line 405):

```ts
  // The same three counters in SECONDS, straight from Jira's `timetracking.*Seconds` —
  // the only form Team Capacity can add up. 0 = Jira holds none.
  originalEstimateSeconds: number;
  timeSpentSeconds: number;
  remainingEstimateSeconds: number;
```

- [ ] **Step 3: Write the failing cloud test**

In `packages/cloud/test/jira.spec.ts`, add to the `issueRow` fixture after `remaining_estimate: "1d 6h",`:

```ts
  original_estimate_seconds: 86400,
  time_spent_seconds: 36000,
  remaining_estimate_seconds: 50400,
```

Add inside `describe("toJiraIssue", …)`:

```ts
  it("carries the numeric counters beside the display strings", () => {
    const issue = toJiraIssue(issueRow);
    expect(issue.originalEstimateSeconds).toBe(86400);
    expect(issue.timeSpentSeconds).toBe(36000);
    expect(issue.remainingEstimateSeconds).toBe(50400);
    expect(toJiraIssueRow(issue)).toMatchObject({
      original_estimate_seconds: 86400,
      time_spent_seconds: 36000,
      remaining_estimate_seconds: 50400,
    });
  });
```

- [ ] **Step 4: Run it to verify it fails**

Run: `pnpm --filter @kermanych/cloud test -- jira.spec`
Expected: FAIL — `originalEstimateSeconds` is `undefined`.

- [ ] **Step 5: Implement the mapping**

In `packages/cloud/src/jira.ts`:

`ISSUE_COLUMNS` — insert `original_estimate_seconds, time_spent_seconds, remaining_estimate_seconds, ` right after `remaining_estimate, `.

`IssueRow` — after `remaining_estimate: string;` add:

```ts
  original_estimate_seconds: number;
  time_spent_seconds: number;
  remaining_estimate_seconds: number;
```

`toJiraIssue` — after `remainingEstimate: row.remaining_estimate,` add:

```ts
    originalEstimateSeconds: row.original_estimate_seconds ?? 0,
    timeSpentSeconds: row.time_spent_seconds ?? 0,
    remainingEstimateSeconds: row.remaining_estimate_seconds ?? 0,
```

`toJiraIssueRow` — after `remaining_estimate: issue.remainingEstimate,` add:

```ts
    original_estimate_seconds: issue.originalEstimateSeconds,
    time_spent_seconds: issue.timeSpentSeconds,
    remaining_estimate_seconds: issue.remainingEstimateSeconds,
```

- [ ] **Step 6: Fix the other fixtures the widened type breaks**

`packages/cloud/test/rls.spec.ts` (~line 1098) — after `remainingEstimate: "",` add:

```ts
          originalEstimateSeconds: 0,
          timeSpentSeconds: 0,
          remainingEstimateSeconds: 0,
```

`apps/ui/test/jira-view.spec.ts` `issue()` fixture — after `remainingEstimate: '',` add:

```ts
    originalEstimateSeconds: 0,
    timeSpentSeconds: 0,
    remainingEstimateSeconds: 0,
```

- [ ] **Step 7: Run tests and typecheck**

Run: `pnpm --filter @kermanych/cloud test && pnpm --filter @kermanych/cloud build`
Expected: PASS, no type errors. (The `rls.spec` needs a live stack and is skipped without one — that's existing behaviour.)

- [ ] **Step 8: Commit**

```bash
git add supabase/migrations/20260904090000_jira_estimate_seconds.sql packages/cloud/src/types.ts packages/cloud/src/jira.ts packages/cloud/test/jira.spec.ts packages/cloud/test/rls.spec.ts apps/ui/test/jira-view.spec.ts
git commit -m "feat(capacity): mirror Jira estimates in seconds

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: Cloud read `listJiraWorklogsBetween`

**Files:**
- Modify: `packages/cloud/src/jira.ts` (after `listJiraIssueChildren`, ~line 511)
- Modify: `packages/cloud/src/index.ts:133-153` (export)
- Test: `packages/cloud/test/jira.spec.ts`

**Interfaces:**
- Produces: `listJiraWorklogsBetween(client: SupabaseClient, integrationId: string, fromIso: string, toIso: string): Promise<JiraWorklog[]>` — `started_at >= fromIso` and `< toIso` (instants), ordered by `started_at` ascending.

- [ ] **Step 1: Write the failing test**

Add to `packages/cloud/test/jira.spec.ts` (import `listJiraWorklogsBetween` from `../src/jira`; the `fakeClient` needs `gte` and `lt` in its op list — add them to the array of builder verbs):

```ts
describe("listJiraWorklogsBetween", () => {
  it("reads one integration's worklogs by started_at half-open range, oldest first", async () => {
    const row = {
      integration_id: "i1", workspace_id: "w1", issue_id: "10001", worklog_id: "wl1",
      author_account_id: "acc1", author_name: "Andrii", author_avatar: "", time_spent: "2h",
      seconds: 7200, started_at: "2026-09-02T08:00:00.000Z", comment_html: "",
    };
    const { client, queries } = fakeClient({ data: [row], error: null });
    const out = await listJiraWorklogsBetween(client, "i1", "2026-09-01T00:00:00.000Z", "2026-09-08T00:00:00.000Z");
    expect(queries[0]!.table).toBe("jira_worklogs");
    expect(queries[0]!.ops).toEqual(
      expect.arrayContaining([
        ["eq", "integration_id", "i1"],
        ["gte", "started_at", "2026-09-01T00:00:00.000Z"],
        ["lt", "started_at", "2026-09-08T00:00:00.000Z"],
        ["order", "started_at", { ascending: true }],
      ]),
    );
    expect(out[0]).toMatchObject({ worklogId: "wl1", authorAccountId: "acc1", seconds: 7200 });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @kermanych/cloud test -- jira.spec`
Expected: FAIL — `listJiraWorklogsBetween` is not exported.

- [ ] **Step 3: Implement**

In `packages/cloud/src/jira.ts` after `listJiraIssueChildren`:

```ts
// The capacity screen's read: every worklog of the board whose `started_at` falls in a
// half-open instant range, regardless of issue. The per-issue reader above serves the
// ticket dialog; a fortnight of the whole team is a different shape and its own index.
export async function listJiraWorklogsBetween(
  client: SupabaseClient,
  integrationId: string,
  fromIso: string,
  toIso: string,
): Promise<JiraWorklog[]> {
  const { data, error } = await client
    .from("jira_worklogs")
    .select("integration_id, workspace_id, issue_id, worklog_id, author_account_id, author_name, author_avatar, time_spent, seconds, started_at, comment_html")
    .eq("integration_id", integrationId)
    .gte("started_at", fromIso)
    .lt("started_at", toIso)
    .order("started_at", { ascending: true });
  if (error) throw new Error(error.message);
  return (data as WorklogRow[]).map(toJiraWorklog);
}
```

In `packages/cloud/src/index.ts`, add `listJiraWorklogsBetween,` after `listJiraIssueChildren,` in the `./jira` export block.

- [ ] **Step 4: Run tests**

Run: `pnpm --filter @kermanych/cloud test && pnpm --filter @kermanych/cloud build`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/cloud/src/jira.ts packages/cloud/src/index.ts packages/cloud/test/jira.spec.ts
git commit -m "feat(capacity): read Jira worklogs by date range

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: API mapper reads `timetracking.*Seconds`

**Files:**
- Modify: `apps/api/src/jira/jira-map.ts:150-175`
- Test: `apps/api/test/jira-map.spec.ts:33,92-100`

- [ ] **Step 1: Write the failing test**

In `apps/api/test/jira-map.spec.ts`, change the fixture line 33 to:

```ts
    timetracking: { originalEstimate: "2d 4h", remainingEstimate: "1d", originalEstimateSeconds: 72000, remainingEstimateSeconds: 28800 },
```

Extend the existing «mirrors all three time-tracking counters» test with:

```ts
    expect(issue.originalEstimateSeconds).toBe(72000);
    expect(issue.remainingEstimateSeconds).toBe(28800);
    // Nothing logged → Jira sends no timeSpentSeconds; the mirror says 0, not NaN.
    expect(issue.timeSpentSeconds).toBe(0);
```

Add a case:

```ts
  it("reads 0 for every numeric counter when Jira sends no timetracking at all", () => {
    const issue = mapIssue(integration, { ...rawIssue, fields: { ...rawIssue.fields, timetracking: undefined } });
    expect(issue.originalEstimateSeconds).toBe(0);
    expect(issue.timeSpentSeconds).toBe(0);
    expect(issue.remainingEstimateSeconds).toBe(0);
  });
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @kermanych/api test -- jira-map`
Expected: FAIL — `originalEstimateSeconds` undefined.

- [ ] **Step 3: Implement**

In `apps/api/src/jira/jira-map.ts`, extend the `timetracking` cast (lines 152-156):

```ts
  const timetracking = (f.timetracking ?? {}) as {
    originalEstimate?: string;
    timeSpent?: string;
    remainingEstimate?: string;
    // The same counters in seconds — Team Capacity's arithmetic. Jira sends them beside
    // the strings on the same field, so no extra request and no per-site 1d=8h guess.
    originalEstimateSeconds?: number;
    timeSpentSeconds?: number;
    remainingEstimateSeconds?: number;
  };
```

Add a helper above `mapIssue`:

```ts
function secs(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.round(v) : 0;
}
```

After `remainingEstimate: str(timetracking.remainingEstimate),` add:

```ts
    originalEstimateSeconds: secs(timetracking.originalEstimateSeconds),
    timeSpentSeconds: secs(timetracking.timeSpentSeconds),
    remainingEstimateSeconds: secs(timetracking.remainingEstimateSeconds),
```

- [ ] **Step 4: Run tests and typecheck**

Run: `pnpm --filter @kermanych/api test -- jira-map && pnpm --filter @kermanych/api typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/jira/jira-map.ts apps/api/test/jira-map.spec.ts
git commit -m "feat(capacity): sync Jira estimate seconds into the mirror

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: `lib/capacity.ts` — calendar primitives, presets, periods

**Files:**
- Create: `apps/ui/src/lib/capacity.ts`
- Test: `apps/ui/test/capacity.spec.ts`

**Interfaces:**
- Produces (all exported from `apps/ui/src/lib/capacity.ts`):
  - `type CapacityRange = { from: string; to: string }`, `type CapacityGranularity = 'day' | 'week'`
  - `DEFAULT_HOURS_PER_DAY = 8`, `DAY_GRANULARITY_MAX_DAYS = 31`
  - `isBusinessDay(iso): boolean`, `eachDay(from, to): string[]`, `businessDays(from, to): string[]`, `weekMonday(iso): string`
  - `normalizeRange(r): CapacityRange`, `defaultGranularity(r): CapacityGranularity`
  - `CAPACITY_PRESETS`, `type CapacityPreset`, `presetRange(preset, today): CapacityRange`
  - `type CapacityPeriod = { key; from; to; businessDays; past }`, `capacityPeriods(range, granularity, today): CapacityPeriod[]`

- [ ] **Step 1: Write the failing tests**

```ts
// apps/ui/test/capacity.spec.ts
import { describe, expect, it } from 'vitest';
import {
  businessDays,
  capacityPeriods,
  defaultGranularity,
  eachDay,
  isBusinessDay,
  normalizeRange,
  presetRange,
  weekMonday,
} from '../src/lib/capacity';

// 2026-09-04 is a Friday; 2026-09-05/06 the weekend; 2026-08-31 the Monday of that week.
const TODAY = '2026-09-04';

describe('calendar primitives', () => {
  it('knows the working week', () => {
    expect(isBusinessDay('2026-09-04')).toBe(true);
    expect(isBusinessDay('2026-09-05')).toBe(false);
    expect(isBusinessDay('2026-09-06')).toBe(false);
    expect(isBusinessDay('2026-09-07')).toBe(true);
  });

  it('lists days inclusively and refuses a malformed bound instead of looping', () => {
    expect(eachDay('2026-09-03', '2026-09-05')).toEqual(['2026-09-03', '2026-09-04', '2026-09-05']);
    expect(eachDay('2026-09-05', '2026-09-03')).toEqual([]);
    expect(eachDay('nope', '2026-09-03')).toEqual([]);
  });

  it('counts business days across a weekend', () => {
    expect(businessDays('2026-09-04', '2026-09-08')).toEqual(['2026-09-04', '2026-09-07', '2026-09-08']);
  });

  it('finds the Monday of a week', () => {
    expect(weekMonday('2026-09-04')).toBe('2026-08-31');
    expect(weekMonday('2026-08-31')).toBe('2026-08-31');
    expect(weekMonday('2026-09-06')).toBe('2026-08-31');
  });

  it('swaps a reversed range and picks day buckets up to a month', () => {
    expect(normalizeRange({ from: '2026-09-10', to: '2026-09-01' })).toEqual({ from: '2026-09-01', to: '2026-09-10' });
    expect(defaultGranularity({ from: '2026-09-01', to: '2026-10-01' })).toBe('day'); // 31 days
    expect(defaultGranularity({ from: '2026-09-01', to: '2026-10-02' })).toBe('week'); // 32 days
  });
});

describe('presetRange', () => {
  it('resolves every preset against today', () => {
    expect(presetRange('thisWeek', TODAY)).toEqual({ from: '2026-08-31', to: '2026-09-06' });
    expect(presetRange('nextWeek', TODAY)).toEqual({ from: '2026-09-07', to: '2026-09-13' });
    expect(presetRange('next2Weeks', TODAY)).toEqual({ from: '2026-09-04', to: '2026-09-17' });
    expect(presetRange('thisMonth', TODAY)).toEqual({ from: '2026-09-01', to: '2026-09-30' });
    expect(presetRange('nextMonth', TODAY)).toEqual({ from: '2026-10-01', to: '2026-10-31' });
    expect(presetRange('last2Weeks', TODAY)).toEqual({ from: '2026-08-21', to: '2026-09-03' });
  });
});

describe('capacityPeriods', () => {
  it('makes one period per day with weekend capacity 0 and marks the past', () => {
    const p = capacityPeriods({ from: '2026-09-03', to: '2026-09-06' }, 'day', TODAY);
    expect(p.map((x) => x.key)).toEqual(['2026-09-03', '2026-09-04', '2026-09-05', '2026-09-06']);
    expect(p.map((x) => x.businessDays)).toEqual([1, 1, 0, 0]);
    expect(p.map((x) => x.past)).toEqual([true, false, false, false]);
  });

  it('rolls days into Monday-keyed weeks and credits only the business days inside the range', () => {
    const p = capacityPeriods({ from: '2026-09-03', to: '2026-09-15' }, 'week', TODAY);
    expect(p.map((x) => x.key)).toEqual(['2026-08-31', '2026-09-07', '2026-09-14']);
    expect(p[0]).toEqual({ key: '2026-08-31', from: '2026-09-03', to: '2026-09-06', businessDays: 2, past: false });
    expect(p[1]!.businessDays).toBe(5);
    expect(p[2]).toEqual({ key: '2026-09-14', from: '2026-09-14', to: '2026-09-15', businessDays: 2, past: false });
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @kermanych/ui test -- capacity`
Expected: FAIL — module `../src/lib/capacity` not found.

- [ ] **Step 3: Implement**

```ts
// apps/ui/src/lib/capacity.ts
// Team Capacity's arithmetic, pure. Two consumers read it and must agree number for number:
// pages/ManagementCapacityPage.vue (chart + table) and stores/management-chat.ts (the digest
// the assistant answers from). Everything a screen or a prompt line shows is derived here.
//
// The units are Jira's: `*Seconds` on issues, `seconds` on worklogs. The baseline is the
// one thing Jira does not have — DEFAULT_HOURS_PER_DAY per person per business day — and
// it is an option so a later per-member table can feed it without touching the maths.
//
// Dates are YYYY-MM-DD strings and go through lib/calendar.ts for arithmetic: a parsed
// `Date` of such a string is UTC midnight, which is yesterday for half of Europe.
import { isoOf, isoParts, shiftDays, shiftMonths, todayIso } from './calendar';

export const DEFAULT_HOURS_PER_DAY = 8;
// Up to a month reads day by day; longer than that a bar per day is noise, so weeks.
export const DAY_GRANULARITY_MAX_DAYS = 31;
// A guard on `eachDay`, not a product limit: a range that long would be a bug upstream.
const MAX_RANGE_DAYS = 366 * 3;

export type CapacityRange = { from: string; to: string };
export type CapacityGranularity = 'day' | 'week';

// 0 = Monday … 6 = Sunday, the Ukrainian week (WEEKDAY_KEYS in lib/calendar.ts).
function weekday(iso: string): number {
  const p = isoParts(iso);
  if (!p) return 0;
  return (new Date(Date.UTC(p.year, p.month - 1, p.day)).getUTCDay() + 6) % 7;
}

export function isBusinessDay(iso: string): boolean {
  return weekday(iso) < 5;
}

/** Every day from `from` to `to`, inclusive. Empty for a reversed or malformed pair —
 *  `shiftDays` returns a malformed input unchanged, which would loop forever. */
export function eachDay(from: string, to: string): string[] {
  if (!isoParts(from) || !isoParts(to)) return [];
  const out: string[] = [];
  for (let d = from; d <= to && out.length < MAX_RANGE_DAYS; d = shiftDays(d, 1)) out.push(d);
  return out;
}

export function businessDays(from: string, to: string): string[] {
  return eachDay(from, to).filter(isBusinessDay);
}

export function weekMonday(iso: string): string {
  return shiftDays(iso, -weekday(iso));
}

export function normalizeRange(r: CapacityRange): CapacityRange {
  return r.from <= r.to ? r : { from: r.to, to: r.from };
}

export function defaultGranularity(r: CapacityRange): CapacityGranularity {
  return eachDay(r.from, r.to).length <= DAY_GRANULARITY_MAX_DAYS ? 'day' : 'week';
}

export const CAPACITY_PRESETS = ['thisWeek', 'nextWeek', 'next2Weeks', 'thisMonth', 'nextMonth', 'last2Weeks'] as const;
export type CapacityPreset = (typeof CAPACITY_PRESETS)[number];

/** The toolbar's presets, resolved against the operator's own today. */
export function presetRange(preset: CapacityPreset, today: string): CapacityRange {
  const monday = weekMonday(today);
  // `today` comes from todayIso() and is always well-formed; the fallback only keeps the
  // function total.
  const p = isoParts(today) ?? { year: 1970, month: 1, day: 1 };
  const monthStart = isoOf({ year: p.year, month: p.month, day: 1 });
  const lastOfMonth = (first: string) => shiftDays(shiftMonths(first, 1), -1);
  switch (preset) {
    case 'thisWeek':
      return { from: monday, to: shiftDays(monday, 6) };
    case 'nextWeek':
      return { from: shiftDays(monday, 7), to: shiftDays(monday, 13) };
    case 'next2Weeks':
      return { from: today, to: shiftDays(today, 13) };
    case 'thisMonth':
      return { from: monthStart, to: lastOfMonth(monthStart) };
    case 'nextMonth': {
      const next = shiftMonths(monthStart, 1);
      return { from: next, to: lastOfMonth(next) };
    }
    case 'last2Weeks':
      return { from: shiftDays(today, -14), to: shiftDays(today, -1) };
  }
}

export type CapacityPeriod = {
  // The day itself, or the week's Monday — what the digest and the chart key on.
  key: string;
  from: string;
  to: string;
  // Business days of this period INSIDE the range: a range starting on Thursday credits
  // its first week two days, not five.
  businessDays: number;
  // Wholly before today — the chart draws these as logged time, the rest as plan.
  past: boolean;
};

export function capacityPeriods(range: CapacityRange, granularity: CapacityGranularity, today: string): CapacityPeriod[] {
  const days = eachDay(range.from, range.to);
  if (granularity === 'day')
    return days.map((d) => ({ key: d, from: d, to: d, businessDays: isBusinessDay(d) ? 1 : 0, past: d < today }));
  const weeks = new Map<string, string[]>();
  for (const d of days) {
    const k = weekMonday(d);
    const list = weeks.get(k);
    if (list) list.push(d);
    else weeks.set(k, [d]);
  }
  return [...weeks].map(([key, ds]) => ({
    key,
    from: ds[0]!,
    to: ds[ds.length - 1]!,
    businessDays: ds.filter(isBusinessDay).length,
    past: ds[ds.length - 1]! < today,
  }));
}

// Re-exported so the page and the store import one module for "capacity today".
export { todayIso };
```

- [ ] **Step 4: Run tests**

Run: `pnpm --filter @kermanych/ui test -- capacity`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/ui/src/lib/capacity.ts apps/ui/test/capacity.spec.ts
git commit -m "feat(capacity): calendar primitives, presets and periods

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: `lib/capacity.ts` — `planIssue` and `capacityReport`

**Files:**
- Modify: `apps/ui/src/lib/capacity.ts`
- Test: `apps/ui/test/capacity.spec.ts`

**Interfaces:**
- Consumes: Task 1's `JiraIssue.*Seconds`; Task 4's primitives; `UNASSIGNED` from `lib/jira-view.ts` (`'@unassigned'`).
- Produces:
  - `type CapacityFlag = 'overdue' | 'unscheduled' | 'unestimated'`
  - `remainingSeconds(issue): number`, `planIssue(issue, today): { remaining: number; days: string[]; flag?: CapacityFlag }`
  - `type CapacityPerson = { id: string; name: string; avatar?: string }`
  - `type CapacityCell = { capacitySeconds; plannedSeconds; loggedSeconds; loadSeconds; utilization }`
  - `type CapacityIssueRow = { key; summary; person; statusName; statusCategory; startDate; dueDate; remainingSeconds; originalSeconds; spentSeconds; inRangeSeconds; flag? }`
  - `type CapacityReport = { range; granularity; hoursPerDay; periods; persons; cells: Record<string, CapacityCell[]>; totals: CapacityCell[]; summary: CapacityCell; issues; unscheduled; overdue }`
  - `type CapacityOptions = { range; today; hoursPerDay?; granularity?; person? }`
  - `capacityReport(issues, worklogs, opts): CapacityReport`, `sumCells(cells): CapacityCell`

- [ ] **Step 1: Write the failing tests**

Append to `apps/ui/test/capacity.spec.ts` (extend the import to include `capacityReport, planIssue, remainingSeconds`, and add `import type { JiraIssue, JiraWorklog } from '@kermanych/cloud';` plus `import { UNASSIGNED } from '../src/lib/jira-view';`):

```ts
function issue(over: Partial<JiraIssue>): JiraIssue {
  return {
    integrationId: 'i1', workspaceId: 'w1', issueId: over.key ?? '1', key: 'KAN-1', summary: 's',
    descriptionHtml: '', typeName: '', typeIcon: '', priorityName: '', priorityIcon: '', labels: [],
    originalEstimate: '', timeSpent: '', remainingEstimate: '',
    originalEstimateSeconds: 0, timeSpentSeconds: 0, remainingEstimateSeconds: 0,
    startDate: '', dueDate: '', statusId: '1', statusName: 'To Do', statusCategory: 'new',
    jiraUpdatedAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z',
    ...over,
  };
}

function worklog(over: Partial<JiraWorklog>): JiraWorklog {
  return {
    integrationId: 'i1', workspaceId: 'w1', issueId: '1', worklogId: 'wl', authorAccountId: 'acc1',
    authorName: 'Andrii', authorAvatar: '', timeSpent: '1h', seconds: 3600,
    startedAt: '2026-09-03T09:00:00.000Z', commentHtml: '', ...over,
  };
}

const H = 3600;

describe('remainingSeconds / planIssue', () => {
  it('prefers Jira\'s remaining, falls back to original minus spent, never below zero', () => {
    expect(remainingSeconds(issue({ remainingEstimateSeconds: 5 * H, originalEstimateSeconds: 8 * H }))).toBe(5 * H);
    expect(remainingSeconds(issue({ originalEstimateSeconds: 8 * H, timeSpentSeconds: 3 * H }))).toBe(5 * H);
    expect(remainingSeconds(issue({ originalEstimateSeconds: 2 * H, timeSpentSeconds: 3 * H }))).toBe(0);
  });

  it('spreads over business days from max(start, today) to due', () => {
    // Fri 04 → Tue 08 = Fri, Mon, Tue.
    const plan = planIssue(issue({ remainingEstimateSeconds: 6 * H, startDate: '2026-09-01', dueDate: '2026-09-08' }), TODAY);
    expect(plan).toEqual({ remaining: 6 * H, days: ['2026-09-04', '2026-09-07', '2026-09-08'] });
    // A start in the future is honoured.
    expect(planIssue(issue({ remainingEstimateSeconds: H, startDate: '2026-09-08', dueDate: '2026-09-09' }), TODAY).days)
      .toEqual(['2026-09-08', '2026-09-09']);
  });

  it('collapses onto the due date when the window has no business day', () => {
    expect(planIssue(issue({ remainingEstimateSeconds: H, dueDate: '2026-09-05' }), '2026-09-05').days).toEqual(['2026-09-05']);
    expect(planIssue(issue({ remainingEstimateSeconds: H, startDate: '2026-09-10', dueDate: '2026-09-08' }), TODAY).days).toEqual(['2026-09-08']);
  });

  it('flags overdue (lands on today), unscheduled and unestimated', () => {
    expect(planIssue(issue({ remainingEstimateSeconds: H, dueDate: '2026-09-01' }), TODAY)).toEqual({ remaining: H, days: [TODAY], flag: 'overdue' });
    expect(planIssue(issue({ remainingEstimateSeconds: H }), TODAY)).toEqual({ remaining: H, days: [], flag: 'unscheduled' });
    expect(planIssue(issue({ dueDate: '2026-09-08' }), TODAY)).toEqual({ remaining: 0, days: [], flag: 'unestimated' });
  });
});

describe('capacityReport', () => {
  const range = { from: '2026-09-02', to: '2026-09-08' }; // Wed…Tue: 5 business days
  const issues = [
    issue({ key: 'KAN-1', assigneeAccountId: 'acc1', assigneeName: 'Andrii', remainingEstimateSeconds: 6 * H, dueDate: '2026-09-08' }),
    issue({ key: 'KAN-2', assigneeAccountId: 'acc2', assigneeName: 'Olha', remainingEstimateSeconds: 40 * H, dueDate: '2026-09-04' }),
    issue({ key: 'KAN-3', assigneeAccountId: 'acc2', assigneeName: 'Olha', remainingEstimateSeconds: 2 * H }), // unscheduled
    issue({ key: 'KAN-4', assigneeAccountId: 'acc1', assigneeName: 'Andrii', remainingEstimateSeconds: 9 * H, dueDate: '2026-09-08', statusCategory: 'done' }),
    issue({ key: 'KAN-5', assigneeAccountId: 'acc3', assigneeName: 'Quiet', statusCategory: 'done' }),
    issue({ key: 'KAN-6', remainingEstimateSeconds: 4 * H, dueDate: '2026-09-07' }), // nobody's
  ];
  const worklogs = [
    worklog({ worklogId: 'a', authorAccountId: 'acc1', seconds: 2 * H, startedAt: '2026-09-02T10:00:00.000Z' }),
    worklog({ worklogId: 'b', authorAccountId: 'acc1', seconds: 3 * H, startedAt: '2026-09-03T10:00:00.000Z' }),
    worklog({ worklogId: 'c', authorAccountId: 'acc2', seconds: 1 * H, startedAt: '2026-08-01T10:00:00.000Z' }), // outside
  ];

  it('plans the future, logs the past, and keeps every assignee on the roster', () => {
    const r = capacityReport(issues, worklogs, { range, today: TODAY });
    expect(r.granularity).toBe('day');
    expect(r.periods.map((p) => p.key)).toEqual(['2026-09-02', '2026-09-03', '2026-09-04', '2026-09-05', '2026-09-06', '2026-09-07', '2026-09-08']);
    // Andrii: logged 2h + 3h on Wed/Thu; KAN-1's 6h spread Fri/Mon/Tue = 2h each; KAN-4 is done.
    const a = r.cells.acc1!;
    expect(a.map((c) => c.loggedSeconds)).toEqual([2 * H, 3 * H, 0, 0, 0, 0, 0]);
    expect(a.map((c) => c.plannedSeconds)).toEqual([0, 0, 2 * H, 0, 0, 2 * H, 2 * H]);
    expect(a[2]!.capacitySeconds).toBe(8 * H);
    expect(a[3]!.capacitySeconds).toBe(0);
    expect(a[2]!.utilization).toBeCloseTo(0.25);
    // Olha: KAN-2 40h due today → all on Friday (5× capacity); KAN-3 has no date → nothing planned.
    expect(r.cells.acc2!.map((c) => c.plannedSeconds)).toEqual([0, 0, 40 * H, 0, 0, 0, 0]);
    expect(r.cells.acc2![2]!.utilization).toBeCloseTo(5);
    // Quiet only has a done issue but is still a person with capacity.
    expect(r.cells.acc3!.map((c) => c.loadSeconds)).toEqual([0, 0, 0, 0, 0, 0, 0]);
    expect(r.cells.acc3![0]!.capacitySeconds).toBe(8 * H);
    // Unassigned work is load without capacity. KAN-6 is due Monday with today = Friday, so its 4h
    // spreads over the two business days Fri 04 + Mon 07.
    expect(r.cells[UNASSIGNED]!.map((c) => c.plannedSeconds)).toEqual([0, 0, 2 * H, 0, 0, 2 * H, 0]);
    expect(r.cells[UNASSIGNED]![5]!.capacitySeconds).toBe(0);
  });

  it('sorts persons by load with unassigned last, and totals across the team', () => {
    const r = capacityReport(issues, worklogs, { range, today: TODAY });
    expect(r.persons.map((p) => p.id)).toEqual(['acc2', 'acc1', 'acc3', UNASSIGNED]);
    // Three people with capacity × 5 business days × 8h.
    expect(r.summary.capacitySeconds).toBe(3 * 5 * 8 * H);
    expect(r.summary.loggedSeconds).toBe(5 * H);
    expect(r.summary.plannedSeconds).toBe(6 * H + 40 * H + 4 * H);
    expect(r.totals[2]!.capacitySeconds).toBe(3 * 8 * H);
  });

  it('lists in-range and flagged issues, flagged first', () => {
    const r = capacityReport(issues, worklogs, { range, today: TODAY });
    expect(r.issues.map((i) => i.key)).toEqual(['KAN-3', 'KAN-2', 'KAN-6', 'KAN-1']);
    expect(r.issues[0]).toMatchObject({ key: 'KAN-3', flag: 'unscheduled', inRangeSeconds: 0 });
    expect(r.issues.find((i) => i.key === 'KAN-1')).toMatchObject({ inRangeSeconds: 6 * H, remainingSeconds: 6 * H });
    expect(r.unscheduled.map((i) => i.key)).toEqual(['KAN-3']);
    expect(r.overdue).toEqual([]);
  });

  it('drops an issue scheduled wholly outside the range unless flagged', () => {
    const r = capacityReport(
      [issue({ key: 'KAN-9', assigneeAccountId: 'acc1', remainingEstimateSeconds: H, startDate: '2026-10-01', dueDate: '2026-10-02' })],
      [],
      { range, today: TODAY },
    );
    expect(r.issues).toEqual([]);
    expect(r.persons.map((p) => p.id)).toEqual(['acc1']);
  });

  it('restricts everything to one person when asked', () => {
    const r = capacityReport(issues, worklogs, { range, today: TODAY, person: 'acc1' });
    expect(r.persons.map((p) => p.id)).toEqual(['acc1']);
    expect(Object.keys(r.cells)).toEqual(['acc1']);
    expect(r.issues.map((i) => i.key)).toEqual(['KAN-1']);
    expect(r.summary.capacitySeconds).toBe(5 * 8 * H);
    expect(r.summary.loggedSeconds).toBe(5 * H);
  });

  it('rolls into weeks with partial-week capacity', () => {
    const r = capacityReport(issues, worklogs, { range: { from: '2026-09-02', to: '2026-09-15' }, today: TODAY, granularity: 'week' });
    expect(r.periods.map((p) => p.key)).toEqual(['2026-08-31', '2026-09-07', '2026-09-14']);
    expect(r.cells.acc1!.map((c) => c.capacitySeconds)).toEqual([3 * 8 * H, 5 * 8 * H, 2 * 8 * H]);
    expect(r.cells.acc1![0]).toMatchObject({ loggedSeconds: 5 * H, plannedSeconds: 2 * H });
    expect(r.cells.acc1![1]!.plannedSeconds).toBe(4 * H);
  });

  it('is empty but well-formed with no input', () => {
    const r = capacityReport([], [], { range, today: TODAY });
    expect(r.persons).toEqual([]);
    expect(r.totals).toHaveLength(7);
    expect(r.summary).toEqual({ capacitySeconds: 0, plannedSeconds: 0, loggedSeconds: 0, loadSeconds: 0, utilization: 0 });
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @kermanych/ui test -- capacity`
Expected: FAIL — `planIssue` / `capacityReport` not exported.

- [ ] **Step 3: Implement**

Add these imports at the top of `apps/ui/src/lib/capacity.ts` (after the `./calendar` import):

```ts
import type { JiraIssue, JiraStatusCategory, JiraWorklog } from '@kermanych/cloud';
import { UNASSIGNED } from './jira-view';
```

Then append after `export { todayIso };`:

```ts
export type CapacityFlag = 'overdue' | 'unscheduled' | 'unestimated';

/** What is left to do on an issue. Jira keeps `remaining` itself once anything is logged;
 *  before that it may be blank, so original − spent is the fallback, floored at zero. */
export function remainingSeconds(issue: JiraIssue): number {
  if (issue.remainingEstimateSeconds > 0) return issue.remainingEstimateSeconds;
  return Math.max(issue.originalEstimateSeconds - issue.timeSpentSeconds, 0);
}

export type IssuePlan = { remaining: number; days: string[]; flag?: CapacityFlag };

/**
 * Where an open issue's remaining estimate lands on the calendar:
 *   - evenly over the business days from max(startDate, today) to dueDate;
 *   - a window with no business day (due on a weekend, start after due) collapses to the
 *     due date rather than vanishing;
 *   - overdue → all of it on today, which is what «overdue» looks like on a capacity chart;
 *   - no due date → nowhere (flag `unscheduled`): the screen counts these loudly, because
 *     undated estimated work is the main reason a capacity view under-reports;
 *   - nothing left → flag `unestimated`.
 */
export function planIssue(issue: JiraIssue, today: string): IssuePlan {
  const remaining = remainingSeconds(issue);
  if (remaining <= 0) return { remaining: 0, days: [], flag: 'unestimated' };
  if (!isoParts(issue.dueDate)) return { remaining, days: [], flag: 'unscheduled' };
  if (issue.dueDate < today) return { remaining, days: [today], flag: 'overdue' };
  const start = isoParts(issue.startDate) && issue.startDate > today ? issue.startDate : today;
  const days = businessDays(start, issue.dueDate);
  return { remaining, days: days.length ? days : [issue.dueDate] };
}

export type CapacityPerson = { id: string; name: string; avatar?: string };

export type CapacityCell = {
  capacitySeconds: number;
  plannedSeconds: number;
  loggedSeconds: number;
  // planned + logged — the bar.
  loadSeconds: number;
  // load / capacity; 0 when there is no capacity (weekend, unassigned bucket).
  utilization: number;
};

export type CapacityIssueRow = {
  key: string;
  summary: string;
  person: CapacityPerson;
  statusName: string;
  statusCategory: JiraStatusCategory;
  startDate: string;
  dueDate: string;
  remainingSeconds: number;
  originalSeconds: number;
  spentSeconds: number;
  // The part of the remaining estimate that lands inside the range.
  inRangeSeconds: number;
  flag?: CapacityFlag;
};

export type CapacityOptions = {
  range: CapacityRange;
  // Caller-supplied, as todayIso() everywhere else: the maths must be testable on a fixed day.
  today: string;
  hoursPerDay?: number;
  granularity?: CapacityGranularity;
  // An assignee's accountId (or UNASSIGNED): restrict the whole report to one person.
  person?: string;
};

export type CapacityReport = {
  range: CapacityRange;
  granularity: CapacityGranularity;
  hoursPerDay: number;
  periods: CapacityPeriod[];
  // Load descending, UNASSIGNED last.
  persons: CapacityPerson[];
  // person.id → one cell per period.
  cells: Record<string, CapacityCell[]>;
  // Per period, everybody.
  totals: CapacityCell[];
  // Whole range, everybody.
  summary: CapacityCell;
  // Open issues that land inside the range, plus every flagged one; flagged first, then by due.
  issues: CapacityIssueRow[];
  unscheduled: CapacityIssueRow[];
  overdue: CapacityIssueRow[];
};

function cellOf(capacity: number, planned: number, logged: number): CapacityCell {
  const load = Math.round(planned + logged);
  return {
    capacitySeconds: capacity,
    plannedSeconds: Math.round(planned),
    loggedSeconds: Math.round(logged),
    loadSeconds: load,
    utilization: capacity > 0 ? load / capacity : 0,
  };
}

export function sumCells(cells: readonly CapacityCell[]): CapacityCell {
  let cap = 0;
  let planned = 0;
  let logged = 0;
  for (const c of cells) {
    cap += c.capacitySeconds;
    planned += c.plannedSeconds;
    logged += c.loggedSeconds;
  }
  return cellOf(cap, planned, logged);
}

// A worklog's calendar day in the OPERATOR's zone: `startedAt` is an instant, and the day
// a person logged against is the day on their own wall calendar.
function localDay(instant: string): string {
  const ms = Date.parse(instant);
  return Number.isNaN(ms) ? '' : todayIso(ms);
}

export function capacityReport(
  issues: readonly JiraIssue[],
  worklogs: readonly JiraWorklog[],
  opts: CapacityOptions,
): CapacityReport {
  const range = normalizeRange(opts.range);
  const hoursPerDay = opts.hoursPerDay ?? DEFAULT_HOURS_PER_DAY;
  const granularity = opts.granularity ?? defaultGranularity(range);
  const periods = capacityPeriods(range, granularity, opts.today);
  const dayIndex = new Map<string, number>();
  periods.forEach((p, i) => {
    for (const d of eachDay(p.from, p.to)) dayIndex.set(d, i);
  });

  const persons = new Map<string, CapacityPerson>();
  const planned = new Map<string, number[]>();
  const logged = new Map<string, number[]>();
  const include = (id: string) => !opts.person || id === opts.person;
  const register = (id: string, name: string, avatar?: string) => {
    const known = persons.get(id);
    if (!known) persons.set(id, { id, name, ...(avatar ? { avatar } : {}) });
    else if (!known.name && name) known.name = name;
  };
  const add = (map: Map<string, number[]>, id: string, i: number, seconds: number) => {
    const arr = map.get(id) ?? periods.map(() => 0);
    arr[i] = (arr[i] ?? 0) + seconds;
    map.set(id, arr);
  };

  // Everyone assigned anything on the board is on the team: an assignee with nothing due
  // this fortnight still has the fortnight's capacity, and a team total that forgot them
  // would read as fuller than it is.
  for (const issue of issues) {
    if (issue.assigneeAccountId && include(issue.assigneeAccountId))
      register(issue.assigneeAccountId, issue.assigneeName ?? '', issue.assigneeAvatar);
  }

  const rows: CapacityIssueRow[] = [];
  for (const issue of issues) {
    if (issue.statusCategory === 'done') continue;
    const id = issue.assigneeAccountId || UNASSIGNED;
    if (!include(id)) continue;
    const plan = planIssue(issue, opts.today);
    let inRange = 0;
    if (plan.days.length) {
      const perDay = plan.remaining / plan.days.length;
      for (const d of plan.days) {
        const i = dayIndex.get(d);
        if (i === undefined) continue;
        add(planned, id, i, perDay);
        inRange += perDay;
      }
    }
    if (inRange === 0 && !plan.flag) continue;
    register(id, issue.assigneeName ?? '', issue.assigneeAvatar);
    rows.push({
      key: issue.key,
      summary: issue.summary,
      person: persons.get(id)!,
      statusName: issue.statusName,
      statusCategory: issue.statusCategory,
      startDate: issue.startDate,
      dueDate: issue.dueDate,
      remainingSeconds: plan.remaining,
      originalSeconds: issue.originalEstimateSeconds,
      spentSeconds: issue.timeSpentSeconds,
      inRangeSeconds: Math.round(inRange),
      ...(plan.flag ? { flag: plan.flag } : {}),
    });
  }

  for (const w of worklogs) {
    const id = w.authorAccountId || UNASSIGNED;
    if (!include(id)) continue;
    const i = dayIndex.get(localDay(w.startedAt));
    if (i === undefined) continue;
    register(id, w.authorName, w.authorAvatar);
    add(logged, id, i, w.seconds);
  }

  const capacityOf = (p: CapacityPeriod) => p.businessDays * hoursPerDay * 3600;
  const ids = [...persons.keys()];
  const withCapacity = ids.filter((id) => id !== UNASSIGNED).length;
  const cells: Record<string, CapacityCell[]> = {};
  for (const id of ids)
    cells[id] = periods.map((p, i) =>
      // The unassigned bucket is load with nobody's hours behind it.
      cellOf(id === UNASSIGNED ? 0 : capacityOf(p), planned.get(id)?.[i] ?? 0, logged.get(id)?.[i] ?? 0),
    );
  const totals = periods.map((p, i) =>
    cellOf(
      withCapacity * capacityOf(p),
      ids.reduce((s, id) => s + (planned.get(id)?.[i] ?? 0), 0),
      ids.reduce((s, id) => s + (logged.get(id)?.[i] ?? 0), 0),
    ),
  );

  const loadOf = (id: string) => sumCells(cells[id]!).loadSeconds;
  const sorted = ids
    .map((id) => persons.get(id)!)
    .sort(
      (a, b) =>
        Number(a.id === UNASSIGNED) - Number(b.id === UNASSIGNED) ||
        loadOf(b.id) - loadOf(a.id) ||
        a.name.localeCompare(b.name),
    );
  rows.sort(
    (a, b) =>
      Number(!a.flag) - Number(!b.flag) ||
      (a.dueDate || '9999-12-31').localeCompare(b.dueDate || '9999-12-31') ||
      a.key.localeCompare(b.key),
  );

  return {
    range,
    granularity,
    hoursPerDay,
    periods,
    persons: sorted,
    cells,
    totals,
    summary: sumCells(totals),
    issues: rows,
    unscheduled: rows.filter((r) => r.flag === 'unscheduled'),
    overdue: rows.filter((r) => r.flag === 'overdue'),
  };
}
```

- [ ] **Step 4: Run tests**

Run: `pnpm --filter @kermanych/ui test -- capacity`
Expected: PASS (all describe blocks).

- [ ] **Step 5: Commit**

```bash
git add apps/ui/src/lib/capacity.ts apps/ui/test/capacity.spec.ts
git commit -m "feat(capacity): plan issues and build the capacity report

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: Core types, section capability, and the digest

**Files:**
- Modify: `packages/core/src/management.ts:114`
- Modify: `packages/core/src/management-actions.ts:368-395` (types + `ManagementContext.capacity`)
- Modify: `packages/core/src/index.ts:129-153` (exports)
- Modify: `apps/ui/src/i18n/en/index.ts:987`, `apps/ui/src/i18n/uk/index.ts:991` (limitation text)
- Modify: `apps/ui/src/lib/capacity.ts` (digest), `apps/ui/src/lib/format.ts` (`hours`)
- Test: `packages/core/test/management-actions.spec.ts`, `apps/ui/test/capacity.spec.ts`, `apps/ui/test/format.spec.ts` (create if absent)

**Interfaces:**
- Produces (core): `ManagementCapacityWeek = { week: string; capacityH: number; plannedH: number; loggedH: number }`, `ManagementCapacityPerson = { name: string; weeks: ManagementCapacityWeek[]; openIssues: number; unscheduled: number; overdue: number }`, `ManagementCapacity = { from: string; to: string; hoursPerDay: number; team: ManagementCapacityWeek[]; persons: ManagementCapacityPerson[]; unscheduled: number; overdue: number }`, `ManagementContext.capacity?: ManagementCapacity`.
- Produces (ui lib): `DIGEST_WEEKS_BACK = 2`, `DIGEST_WEEKS_AHEAD = 6`, `digestRange(today): CapacityRange`, `hoursOf(seconds): number` (one decimal), `capacityDigest(report): ManagementCapacity`; `format.ts hours(seconds): string`.

- [ ] **Step 1: Write the failing core test**

Append to `packages/core/test/management-actions.spec.ts`:

```ts
import { managementSection } from "../src/management";

describe("management-capacity section", () => {
  it("is readable, not writable, and states why", () => {
    const s = managementSection("management-capacity")!;
    expect(s.capability).toBe("read");
    expect(s.limitation).toContain("Jira");
  });
});
```

(If the file already imports from `../src/management`, merge the import.)

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @kermanych/core test -- management-actions`
Expected: FAIL — capability is `"none"`.

- [ ] **Step 3: Flip the section and add the types**

`packages/core/src/management.ts` line 114 becomes:

```ts
  // Readable since Team Capacity got a screen: it shows Jira's estimates and worklogs
  // against an 8 h/day baseline. Nothing on it is ours to write — load changes by editing
  // tickets in Jira — so the assistant describes it (from the digest in its context) and
  // refuses to change it with this sentence.
  {
    name: "management-capacity",
    path: "team-capacity",
    label: "Team Capacity",
    hint: "навантаження команди",
    capability: "read",
    limitation:
      "розділ лише читає оцінки й ворклоги Jira — навантаження змінюється редагуванням тікетів у Jira, не з чату",
  },
```

`packages/core/src/management-actions.ts` — after `ManagementJiraBoard` (line 368) add:

```ts
// One week of somebody's (or everybody's) capacity, in hours with one decimal. `week` is
// the Monday, YYYY-MM-DD. Past weeks carry `loggedH` (worklogs), future weeks `plannedH`
// (remaining estimates spread to their due dates); the current week carries both.
export type ManagementCapacityWeek = { week: string; capacityH: number; plannedH: number; loggedH: number };

// One Jira assignee. `name` blank = the unassigned bucket. Not a `ManagementMember`: the
// estimates belong to Jira accounts, and the two rosters only overlap.
export type ManagementCapacityPerson = {
  name: string;
  weeks: ManagementCapacityWeek[];
  openIssues: number;
  unscheduled: number;
  overdue: number;
};

// The Team Capacity digest: a fixed window of weeks around today, computed in the browser by
// the same function the screen renders (apps/ui/src/lib/capacity.ts), so the assistant's
// numbers are the screen's. Travels on the ask like the register: the mirror is behind RLS.
export type ManagementCapacity = {
  from: string;
  to: string;
  hoursPerDay: number;
  team: ManagementCapacityWeek[];
  persons: ManagementCapacityPerson[];
  unscheduled: number;
  overdue: number;
};
```

In `ManagementContext`, after `jira?: ManagementJiraBoard;` add:

```ts
  // Team Capacity, present only when the workspace has a Jira board. Re-sent every turn:
  // estimates move between turns.
  capacity?: ManagementCapacity;
```

`packages/core/src/index.ts` — add to the `./management-actions` export block:

```ts
  type ManagementCapacity,
  type ManagementCapacityPerson,
  type ManagementCapacityWeek,
```

- [ ] **Step 4: Update the limitation in both locales**

`apps/ui/src/i18n/en/index.ts` line 987:

```ts
      'management-capacity': { hint: 'team workload', limitation: 'the section only reads Jira estimates and worklogs — workload changes by editing tickets in Jira, not from the chat' },
```

`apps/ui/src/i18n/uk/index.ts` line 991:

```ts
      'management-capacity': { hint: 'навантаження команди', limitation: 'розділ лише читає оцінки й ворклоги Jira — навантаження змінюється редагуванням тікетів у Jira, не з чату' },
```

- [ ] **Step 5: Run core tests**

Run: `pnpm --filter @kermanych/core test && pnpm --filter @kermanych/core build`
Expected: PASS. (`packages/core/test/management-actions.spec.ts` refusal tests still pass — an `unsupported` aimed at a `read` section is still a refusal. `apps/ui/test/management-actions.spec.ts:63` pins the OLD limitation string and goes red: update its expected text to the new limitation — the test's intent, "a refusal quotes the section table", is unchanged.)

- [ ] **Step 6: Write the failing digest + format tests**

Append to `apps/ui/test/capacity.spec.ts` (add `capacityDigest, digestRange, hoursOf` to the import):

```ts
describe('digest', () => {
  it('windows two weeks back and six ahead from the Monday of today', () => {
    expect(digestRange(TODAY)).toEqual({ from: '2026-08-17', to: '2026-10-11' });
  });

  it('rounds hours to one decimal', () => {
    expect(hoursOf(3600)).toBe(1);
    expect(hoursOf(5400)).toBe(1.5);
    expect(hoursOf(100)).toBe(0);
    expect(hoursOf(0)).toBe(0);
  });

  it('compresses a weekly report into the assistant digest', () => {
    const range = digestRange(TODAY);
    const r = capacityReport(
      [
        issue({ key: 'KAN-1', assigneeAccountId: 'acc1', assigneeName: 'Andrii', remainingEstimateSeconds: 10 * H, dueDate: '2026-09-08' }),
        issue({ key: 'KAN-2', assigneeAccountId: 'acc1', assigneeName: 'Andrii', remainingEstimateSeconds: H }),
        issue({ key: 'KAN-3', remainingEstimateSeconds: H, dueDate: '2026-09-01' }),
      ],
      [worklog({ authorAccountId: 'acc1', seconds: 4 * H, startedAt: '2026-08-25T10:00:00.000Z' })],
      { range, today: TODAY, granularity: 'week' },
    );
    const d = capacityDigest(r);
    expect(d.from).toBe('2026-08-17');
    expect(d.hoursPerDay).toBe(8);
    expect(d.team).toHaveLength(8);
    expect(d.team[1]).toEqual({ week: '2026-08-24', capacityH: 40, plannedH: 0, loggedH: 4 });
    expect(d.persons.map((p) => p.name)).toEqual(['Andrii', '']);
    const andrii = d.persons[0]!;
    expect(andrii).toMatchObject({ openIssues: 2, unscheduled: 1, overdue: 0 });
    // 10h over Fri 04, Mon 07, Tue 08 → 3.3h this week, 6.7h next.
    expect(andrii.weeks[2]!.plannedH).toBeCloseTo(3.3, 1);
    expect(andrii.weeks[3]!.plannedH).toBeCloseTo(6.7, 1);
    expect(d.unscheduled).toBe(1);
    expect(d.overdue).toBe(1);
  });
});
```

Create `apps/ui/test/format.spec.ts` if it does not exist (else append):

```ts
import { describe, expect, it } from 'vitest';
import { hours } from '../src/lib/format';

describe('hours', () => {
  it('prints whole hours bare and fractions to one decimal', () => {
    expect(hours(0)).toBe('0');
    expect(hours(3600)).toBe('1');
    expect(hours(5400)).toBe('1.5');
    expect(hours(28800)).toBe('8');
    expect(hours(100)).toBe('0');
  });
});
```

- [ ] **Step 7: Run to verify they fail**

Run: `pnpm --filter @kermanych/ui test -- capacity format`
Expected: FAIL — `digestRange` / `hours` missing.

- [ ] **Step 8: Implement the digest and `hours`**

In `apps/ui/src/lib/capacity.ts`, add the import `import type { ManagementCapacity, ManagementCapacityWeek } from '@kermanych/core';` beside the other imports and append:

```ts
// The assistant's window: the two weeks behind (what got logged) and six ahead including
// this one (what is planned), by week. Fixed rather than asked for, because the model's
// only channel back is prose — it cannot ask the app for another range — and this is the
// span a manager's «how are we next two weeks / this month» falls inside.
export const DIGEST_WEEKS_BACK = 2;
export const DIGEST_WEEKS_AHEAD = 6;

export function digestRange(today: string): CapacityRange {
  const monday = weekMonday(today);
  return { from: shiftDays(monday, -7 * DIGEST_WEEKS_BACK), to: shiftDays(monday, 7 * DIGEST_WEEKS_AHEAD - 1) };
}

/** Seconds as hours with one decimal — the resolution a prompt line or a table cell needs. */
export function hoursOf(seconds: number): number {
  return Math.round(seconds / 360) / 10;
}

export function capacityDigest(report: CapacityReport): ManagementCapacity {
  const week = (c: CapacityCell, p: CapacityPeriod): ManagementCapacityWeek => ({
    week: p.key,
    capacityH: hoursOf(c.capacitySeconds),
    plannedH: hoursOf(c.plannedSeconds),
    loggedH: hoursOf(c.loggedSeconds),
  });
  return {
    from: report.range.from,
    to: report.range.to,
    hoursPerDay: report.hoursPerDay,
    team: report.periods.map((p, i) => week(report.totals[i]!, p)),
    persons: report.persons.map((person) => ({
      name: person.id === UNASSIGNED ? '' : person.name,
      weeks: report.periods.map((p, i) => week(report.cells[person.id]![i]!, p)),
      openIssues: report.issues.filter((r) => r.person.id === person.id).length,
      unscheduled: report.unscheduled.filter((r) => r.person.id === person.id).length,
      overdue: report.overdue.filter((r) => r.person.id === person.id).length,
    })),
    unscheduled: report.unscheduled.length,
    overdue: report.overdue.length,
  };
}
```

In `apps/ui/src/lib/format.ts` append:

```ts
// Seconds as hours for a capacity cell: `8`, `2.5`, `0`. Bare number — the unit word sits
// with the caller (`h` / `год`), like `tokens` above.
export function hours(seconds: number): string {
  const h = Math.round(seconds / 360) / 10;
  return Number.isInteger(h) ? String(h) : h.toFixed(1);
}
```

- [ ] **Step 9: Run tests and typecheck**

Run: `pnpm --filter @kermanych/ui test -- capacity format i18n && pnpm --filter @kermanych/ui typecheck`
Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add packages/core/src/management.ts packages/core/src/management-actions.ts packages/core/src/index.ts packages/core/test/management-actions.spec.ts apps/ui/src/i18n/en/index.ts apps/ui/src/i18n/uk/index.ts apps/ui/src/lib/capacity.ts apps/ui/src/lib/format.ts apps/ui/test/capacity.spec.ts apps/ui/test/format.spec.ts
git commit -m "feat(capacity): readable section, digest types and builder

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 7: Prompt prints the digest; controller sanitizes it

**Files:**
- Modify: `apps/api/src/management/management-prompt.ts:11-31` (imports), `:136-143` (protocol), `:414-442` (`contextBlock`)
- Modify: `apps/api/src/http/management.controller.ts:3-18` (imports), `:118` (sanitizer), `:160-167` (context)
- Test: `apps/api/test/management-prompt.spec.ts`, `apps/api/test/management-controller.spec.ts`

**Interfaces:**
- Consumes: `ManagementCapacity`, `ManagementCapacityWeek`, `ManagementCapacityPerson`, `isReleaseDate` from `@kermanych/core`.

- [ ] **Step 1: Write the failing prompt tests**

Append to `apps/api/test/management-prompt.spec.ts` (add `type ManagementCapacity` to the core import):

```ts
describe("capacity lines", () => {
  const capacity: ManagementCapacity = {
    from: "2026-08-17",
    to: "2026-10-11",
    hoursPerDay: 8,
    team: [{ week: "2026-08-31", capacityH: 80, plannedH: 30, loggedH: 12 }],
    persons: [
      { name: "Марина", weeks: [{ week: "2026-08-31", capacityH: 40, plannedH: 30, loggedH: 12 }], openIssues: 4, unscheduled: 1, overdue: 0 },
      { name: "", weeks: [{ week: "2026-08-31", capacityH: 0, plannedH: 2.5, loggedH: 0 }], openIssues: 1, unscheduled: 0, overdue: 1 },
    ],
    unscheduled: 1,
    overdue: 1,
  };

  it("prints the team line, one line per person and the unassigned bucket", () => {
    const text = buildManagementTurn({ first: false, repos: [], context: { ...context, capacity }, today: TODAY, text: "?" });
    expect(text).toContain("Навантаження команди Jira (Team Capacity), 2026-08-17 … 2026-10-11");
    expect(text).toContain("8 год/робочий день");
    expect(text).toContain("- КОМАНДА РАЗОМ · без дати 1 · прострочено 1 · 2026-08-31: 42/80 год (лог 12 · план 30)");
    expect(text).toContain("- Марина · відкритих 4 · без дати 1 · прострочено 0 · 2026-08-31: 42/40 год (лог 12 · план 30)");
    expect(text).toContain("- (не призначено) · відкритих 1 · без дати 0 · прострочено 1 · 2026-08-31: 2.5/0 год (лог 0 · план 2.5)");
  });

  it("says capacity is unavailable without a Jira board", () => {
    const text = buildManagementTurn({ first: false, repos: [], context, today: TODAY, text: "?" });
    expect(text).toContain("Навантаження команди (Team Capacity): недоступне");
  });

  it("carries the capacity protocol in the contract", () => {
    const text = buildManagementTurn({ first: true, repos: [], context, today: TODAY, text: "?" });
    expect(text).toContain("НАВАНТАЖЕННЯ КОМАНДИ (management-capacity)");
    expect(text).toContain("management-capacity · Team Capacity · capability=read");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @kermanych/api test -- management-prompt`
Expected: FAIL — strings absent.

- [ ] **Step 3: Implement the prompt**

In `apps/api/src/management/management-prompt.ts`, add to the `@kermanych/core` import: `type ManagementCapacity, type ManagementCapacityPerson, type ManagementCapacityWeek,`.

After `ticketProtocol()` (before `// One attached file…`, ~line 330) add:

```ts
// Team Capacity is the one section the assistant READS but never writes, and the protocol
// spends its words on what the numbers mean: a manager who hears «45 of 40 hours» has to
// know whether that is time logged or time still estimated, and a model left to guess says
// «planned» about a week that already happened.
function capacityProtocol(): string {
  return [
    "НАВАНТАЖЕННЯ КОМАНДИ (management-capacity). Розділ лише читається: єдина дія для нього — unsupported.",
    "Питання «яка потужність / яке навантаження команди або людини» — відповідай ПРОЗОЮ і ТІЛЬКИ з блоку",
    "«Навантаження команди Jira» у контексті:",
    "  • дай розбивку по людях і по тижнях: навантаження проти потужності, у годинах і у відсотках;",
    "    назви, хто перевантажений (понад 100%) і хто недовантажений (менше 80%);",
    "  • минулі тижні — це ЗАЛОГОВАНИЙ час (факт); поточний і майбутні — ОЦІНКИ, що лишилися по відкритих тікетах,",
    "    розкладені рівномірно між датою початку (або сьогодні) і дедлайном;",
    "  • тікети без дедлайну в тижні не входять — назви їх кількість окремо: це робота, якої графік не показує;",
    "    прострочені лягають цілком на сьогодні;",
    "  • «потужність проєкту» — це ця дошка Jira; «людина» — виконавець Jira з цього блоку. Не вигадуй людей і",
    "    чисел, яких у блоці немає; «(не призначено)» — робота без виконавця, потужності в неї нема;",
    "  • період поза вікном блоку — скажи це прямо і відправ на екран Team Capacity, де є вибір дат.",
    "    Блоку немає — воркспейс без дошки Jira, оцінок узяти нізвідки.",
  ].join("\n");
}
```

In `contract()`, after `ticketProtocol(),` and its `"",` add:

```ts
    capacityProtocol(),
    "",
```

Before `function contextBlock` add:

```ts
function hoursText(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}

function capacityWeek(w: ManagementCapacityWeek): string {
  return `${w.week}: ${hoursText(Math.round((w.loggedH + w.plannedH) * 10) / 10)}/${hoursText(w.capacityH)} год (лог ${hoursText(w.loggedH)} · план ${hoursText(w.plannedH)})`;
}

function capacityPerson(p: ManagementCapacityPerson): string {
  return `- ${p.name || "(не призначено)"} · відкритих ${p.openIssues} · без дати ${p.unscheduled} · прострочено ${p.overdue} · ${p.weeks.map(capacityWeek).join(" · ")}`;
}

// The Team Capacity digest, one line per person. Absent means the workspace has no Jira
// board, and the line says so: the alternative is a model that invents a team's hours.
function capacityLines(c: ManagementCapacity | undefined): string {
  if (c === undefined)
    return "Навантаження команди (Team Capacity): недоступне — у воркспейсу немає дошки Jira, а оцінки є тільки там";
  return [
    `Навантаження команди Jira (Team Capacity), ${c.from} … ${c.to}, тижні від понеділка, потужність ${c.hoursPerDay} год/робочий день на людину; тиждень читається як «понеділок: навантаження/потужність год (лог · план)»:`,
    `- КОМАНДА РАЗОМ · без дати ${c.unscheduled} · прострочено ${c.overdue} · ${c.team.map(capacityWeek).join(" · ")}`,
    ...c.persons.map(capacityPerson),
  ].join("\n");
}
```

In `contextBlock`, after `jiraLines(c.jira),` add `capacityLines(c.capacity),`.

- [ ] **Step 4: Run prompt tests**

Run: `pnpm --filter @kermanych/api test -- management-prompt`
Expected: PASS.

- [ ] **Step 5: Write the failing controller test**

Append to `apps/api/test/management-controller.spec.ts`:

```ts
describe("ManagementController — capacity context", () => {
  it("rebuilds the capacity digest with caps and drops a malformed one", async () => {
    let seen: ManagementChatAsk | undefined;
    const ctl = make({ chat: { ask: async (a: ManagementChatAsk) => ((seen = a), {}) } as Partial<ManagementChatService> });
    const weeks = Array.from({ length: 20 }, (_, i) => ({ week: `2026-01-${String(i + 1).padStart(2, "0")}`, capacityH: 40, plannedH: -3, loggedH: 1.26 }));
    await ctl.ask(
      chatAsk({
        context: {
          workspaceName: "A",
          section: "s",
          risks: [],
          members: [],
          capacity: {
            from: "2026-08-17",
            to: "2026-10-11",
            hoursPerDay: 8,
            team: weeks,
            persons: [{ name: " Марина ", weeks, openIssues: 2.7, unscheduled: -1, overdue: 1 }, { name: 7 }],
            unscheduled: 1,
            overdue: "x",
          },
        } as unknown as ManagementChatAsk["context"],
      }),
    );
    const c = seen!.context.capacity!;
    expect(c.team).toHaveLength(12);
    expect(c.team[0]).toEqual({ week: "2026-01-01", capacityH: 40, plannedH: 0, loggedH: 1.3 });
    expect(c.persons).toHaveLength(2);
    expect(c.persons[0]).toMatchObject({ name: "Марина", openIssues: 2, unscheduled: 0, overdue: 1 });
    expect(c.persons[1]).toMatchObject({ name: "", weeks: [] });
    expect(c.overdue).toBe(0);

    await ctl.ask(chatAsk({ context: { workspaceName: "A", section: "s", risks: [], members: [], capacity: { from: "не дата" } } as unknown as ManagementChatAsk["context"] }));
    expect("capacity" in seen!.context).toBe(false);
  });
});
```

- [ ] **Step 6: Run to verify it fails**

Run: `pnpm --filter @kermanych/api test -- management-controller`
Expected: FAIL — `capacity` is forwarded raw (length 20) or absent.

- [ ] **Step 7: Implement the sanitizer**

In `apps/api/src/http/management.controller.ts`, add to the core import: `type ManagementCapacity, type ManagementCapacityPerson, type ManagementCapacityWeek,`.

After `jiraBoard()` add:

```ts
// The Team Capacity digest as the browser sent it, rebuilt field by field for `riskRows`'
// reason: it is printed into the prompt as fact. Caps keep a pathological board from
// turning every turn into a page of numbers; negatives and NaN become 0, never a lie.
const MAX_CAPACITY_PERSONS = 60;
const MAX_CAPACITY_WEEKS = 12;

function hoursNum(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.round(v * 10) / 10 : 0;
}

function countNum(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0;
}

function capacityWeeks(v: unknown): ManagementCapacityWeek[] {
  if (!Array.isArray(v)) return [];
  const out: ManagementCapacityWeek[] = [];
  for (const w of v.slice(0, MAX_CAPACITY_WEEKS)) {
    if (!w || typeof w !== "object") continue;
    const x = w as Record<string, unknown>;
    if (typeof x.week !== "string" || !isReleaseDate(x.week)) continue;
    out.push({ week: x.week, capacityH: hoursNum(x.capacityH), plannedH: hoursNum(x.plannedH), loggedH: hoursNum(x.loggedH) });
  }
  return out;
}

function capacityDigest(v: unknown): ManagementCapacity | undefined {
  if (typeof v !== "object" || v === null) return undefined;
  const x = v as Record<string, unknown>;
  if (typeof x.from !== "string" || !isReleaseDate(x.from) || typeof x.to !== "string" || !isReleaseDate(x.to)) return undefined;
  const persons: ManagementCapacityPerson[] = [];
  if (Array.isArray(x.persons)) {
    for (const p of x.persons.slice(0, MAX_CAPACITY_PERSONS)) {
      if (!p || typeof p !== "object") continue;
      const y = p as Record<string, unknown>;
      persons.push({
        name: typeof y.name === "string" ? y.name.trim() : "",
        weeks: capacityWeeks(y.weeks),
        openIssues: countNum(y.openIssues),
        unscheduled: countNum(y.unscheduled),
        overdue: countNum(y.overdue),
      });
    }
  }
  return {
    from: x.from,
    to: x.to,
    hoursPerDay: hoursNum(x.hoursPerDay) || 8,
    team: capacityWeeks(x.team),
    persons,
    unscheduled: countNum(x.unscheduled),
    overdue: countNum(x.overdue),
  };
}
```

In `ask()`, after `const jira = jiraBoard(b.context.jira);` add `const capacity = capacityDigest(b.context.capacity);` and in the `context` literal after `...(jira ? { jira } : {}),` add `...(capacity ? { capacity } : {}),`.

- [ ] **Step 8: Run API tests and typecheck**

Run: `pnpm --filter @kermanych/api test && pnpm --filter @kermanych/api typecheck`
Expected: PASS (including `management-chat.spec.ts`, untouched).

- [ ] **Step 9: Commit**

```bash
git add apps/api/src/management/management-prompt.ts apps/api/src/http/management.controller.ts apps/api/test/management-prompt.spec.ts apps/api/test/management-controller.spec.ts
git commit -m "feat(capacity): print the capacity digest into the assistant's context

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 8: Stores — worklog fetch and the chat digest

**Files:**
- Modify: `apps/ui/src/stores/jira.ts:14-22` (imports), after `loadBoard` (~line 156), `:253-273` (return)
- Modify: `apps/ui/src/stores/management-chat.ts:39-64` (imports), after `jiraDigest` (~line 264), `:633-646` (send)
- Modify: `apps/ui/test/management-tickets.spec.ts:76-90` (jira mock)
- Test: `apps/ui/test/management-capacity-digest.spec.ts`

**Interfaces:**
- Produces: `useJira().fetchWorklogs(range: CapacityRange): Promise<JiraWorklog[]>` (no store state — the page and the chat each keep their own), `useJira().loadBoard()` exported.
- Produces: `ManagementChatAsk.context.capacity` set when the workspace has a Jira integration.

- [ ] **Step 1: Write the failing digest test**

```ts
// apps/ui/test/management-capacity-digest.spec.ts
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import type { ManagementChatAsk, ManagementChatReply } from '@kermanych/core';
import { useManagementChat } from '../src/stores/management-chat';

// The assistant's capacity block is built in the browser from the same mirror the screen
// reads, and only when there is a Jira board to read. Two facts, two tests.
const managementChat = vi.fn();
const fetchWorklogs = vi.fn();
const loadBoard = vi.fn();

const jiraState = {
  integration: null as { id: string; siteUrl: string; projectKey: string; boardName: string } | null | undefined,
  issues: [] as unknown[],
};

vi.mock('../src/lib/api', () => ({
  api: { managementChat: (ask: unknown) => managementChat(ask), resetManagementChat: vi.fn(), jiraTokenStatus: vi.fn() },
}));
vi.mock('../src/stores/orchestrator', () => ({ useOrchestrator: () => ({ selectedWorkspaceId: 'w1', notify: vi.fn() }) }));
vi.mock('../src/stores/projects', () => ({
  useProjects: () => ({ projects: [], members: { w1: [] }, workspaceById: new Map([['w1', { id: 'w1', name: 'Acme' }]]), loadMembers: vi.fn() }),
}));
vi.mock('../src/stores/board', () => ({ useBoard: () => ({ createTask: vi.fn() }) }));
vi.mock('../src/stores/jira', () => ({
  useJira: () => ({
    get integration() {
      return jiraState.integration;
    },
    get issues() {
      return jiraState.issues;
    },
    tokenPresent: false,
    assignable: [],
    probe: vi.fn(),
    loadAssignable: vi.fn(async () => []),
    loadBoard: () => loadBoard(),
    fetchWorklogs: (range: unknown) => fetchWorklogs(range),
    upsert: vi.fn(),
  }),
}));
vi.mock('../src/stores/risks', () => ({ useRisks: () => ({ byWorkspace: { w1: [] }, load: vi.fn(), create: vi.fn(), save: vi.fn() }) }));
vi.mock('../src/stores/release-notes', () => ({ useReleaseNotes: () => ({ generate: vi.fn() }) }));

const reply: ManagementChatReply = { text: 'ok', actions: [], rejected: [], notices: [], ms: 1 };

const issue = (over: Record<string, unknown>) => ({
  integrationId: 'i1', workspaceId: 'w1', issueId: '1', key: 'KAN-1', summary: 's', descriptionHtml: '',
  typeName: '', typeIcon: '', priorityName: '', priorityIcon: '', labels: [],
  originalEstimate: '', timeSpent: '', remainingEstimate: '',
  originalEstimateSeconds: 0, timeSpentSeconds: 0, remainingEstimateSeconds: 0,
  startDate: '', dueDate: '', statusId: '1', statusName: 'To Do', statusCategory: 'new',
  jiraUpdatedAt: '', updatedAt: '', ...over,
});

describe('management chat — capacity digest', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    managementChat.mockReset().mockResolvedValue(reply);
    fetchWorklogs.mockReset().mockResolvedValue([]);
    loadBoard.mockReset();
    jiraState.integration = null;
    jiraState.issues = [];
  });

  it('sends no capacity without a Jira board', async () => {
    await useManagementChat().send('capacity?', 'management-capacity');
    const ask = managementChat.mock.calls[0]![0] as ManagementChatAsk;
    expect('capacity' in ask.context).toBe(false);
    expect(fetchWorklogs).not.toHaveBeenCalled();
  });

  it('sends a weekly digest built from the mirror when there is one', async () => {
    jiraState.integration = { id: 'i1', siteUrl: 'https://x.atlassian.net', projectKey: 'KAN', boardName: 'KAN board' };
    jiraState.issues = [
      issue({ assigneeAccountId: 'acc1', assigneeName: 'Andrii', remainingEstimateSeconds: 8 * 3600, startDate: '2099-01-04', dueDate: '2099-01-05' }),
    ];
    await useManagementChat().send('capacity?', 'management-capacity');
    const ask = managementChat.mock.calls[0]![0] as ManagementChatAsk;
    expect(loadBoard).not.toHaveBeenCalled(); // issues were already there
    expect(fetchWorklogs).toHaveBeenCalledTimes(1);
    const c = ask.context.capacity!;
    expect(c.hoursPerDay).toBe(8);
    expect(c.team).toHaveLength(8);
    expect(c.persons.map((p) => p.name)).toEqual(['Andrii']);
    expect(c.persons[0]!.openIssues).toBe(0); // starts and ends in 2099: wholly outside the window, unflagged
  });

  it('loads the board first when nothing is mirrored yet, and survives a failed read', async () => {
    jiraState.integration = { id: 'i1', siteUrl: 'https://x.atlassian.net', projectKey: 'KAN', boardName: 'KAN board' };
    fetchWorklogs.mockRejectedValueOnce(new Error('offline'));
    await useManagementChat().send('capacity?', 'management-capacity');
    expect(loadBoard).toHaveBeenCalledTimes(1);
    const ask = managementChat.mock.calls[0]![0] as ManagementChatAsk;
    expect('capacity' in ask.context).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @kermanych/ui test -- management-capacity-digest`
Expected: FAIL — `capacity` never set / `fetchWorklogs` not called.

- [ ] **Step 3: Extend the Jira store**

In `apps/ui/src/stores/jira.ts`:

Imports — add `JiraWorklog` to the `@kermanych/cloud` type import, `listJiraWorklogsBetween` to the value import, and:

```ts
import { shiftDays } from '../lib/calendar';
import type { CapacityRange } from '../lib/capacity';
```

After `loadBoard()`:

```ts
  // Worklogs of the whole board for a calendar range — Team Capacity's read. Returned, not
  // stored: the screen and the Менеджмент chat ask for different ranges at the same time,
  // and one `worklogs` ref would have them overwrite each other. A day of slack on both
  // ends because `started_at` is an instant and the range is the operator's wall calendar;
  // lib/capacity.ts buckets by local day and drops what falls outside.
  async function fetchWorklogs(range: CapacityRange): Promise<JiraWorklog[]> {
    const row = integration.value;
    if (!row) return [];
    return listJiraWorklogsBetween(
      auth.client,
      row.id,
      `${shiftDays(range.from, -1)}T00:00:00.000Z`,
      `${shiftDays(range.to, 2)}T00:00:00.000Z`,
    );
  }
```

Add `loadBoard,` and `fetchWorklogs,` to the returned object.

- [ ] **Step 4: Build the digest in the chat store**

In `apps/ui/src/stores/management-chat.ts`:

Imports — add `ManagementCapacity` to the `@kermanych/core` type import, and:

```ts
import { capacityDigest, capacityReport, digestRange, todayIso } from '../lib/capacity';
```

After `jiraDigest()`:

```ts
  // Team Capacity as the assistant is shown it: the same `capacityReport` the screen renders,
  // over the fixed digest window, by week. Only with a Jira board — the native board has no
  // estimates — and never fatal: a failed read costs the assistant this one block, and the
  // prompt then says capacity is unavailable rather than inventing it.
  async function capacityDigestFor(): Promise<ManagementCapacity | undefined> {
    if (!jira.integration) return undefined;
    try {
      if (!jira.issues.length) await jira.loadBoard();
      const today = todayIso(Date.now());
      const range = digestRange(today);
      const worklogs = await jira.fetchWorklogs(range);
      return capacityDigest(capacityReport(jira.issues, worklogs, { range, today, granularity: 'week' }));
    } catch {
      return undefined;
    }
  }
```

In `send()`, after `const jiraBoard = await jiraDigest(workspaceId);` add `const capacity = await capacityDigestFor();`, and in the `context` literal after `...(jiraBoard ? { jira: jiraBoard } : {}),` add `...(capacity ? { capacity } : {}),`.

- [ ] **Step 5: Keep the ticket spec's Jira mock complete**

In `apps/ui/test/management-tickets.spec.ts`, inside the `useJira: () => ({ … })` mock add:

```ts
    issues: [],
    loadBoard: vi.fn(),
    fetchWorklogs: vi.fn(async () => []),
```

- [ ] **Step 6: Run UI tests and typecheck**

Run: `pnpm --filter @kermanych/ui test && pnpm --filter @kermanych/ui typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/ui/src/stores/jira.ts apps/ui/src/stores/management-chat.ts apps/ui/test/management-tickets.spec.ts apps/ui/test/management-capacity-digest.spec.ts
git commit -m "feat(capacity): send the capacity digest with every chat turn

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 9: i18n keys for the screen

**Files:**
- Modify: `apps/ui/src/i18n/en/index.ts` (inside `management: { … }`, after the `releases:` block), `apps/ui/src/i18n/uk/index.ts` (same place)
- Test: `apps/ui/test/i18n-completeness.spec.ts` (existing)

- [ ] **Step 1: Add the English keys**

Inside `management: {` in `apps/ui/src/i18n/en/index.ts`, add a sibling of `risks:` / `releases:`:

```ts
    capacity: {
      leadBefore: 'Team capacity of workspace',
      leadAfter: '— Jira estimates and logged work against {hours} h per person per business day.',
      gateTitle: 'Capacity reads from Jira',
      gateText: 'Team Capacity adds up the estimates and worklogs of the workspace’s Jira board. The native board has no estimates, so there is nothing to show until a Jira board is connected.',
      gateButton: 'Open Integrations',
      loading: 'Reading the Jira mirror…',
      loadError: 'Could not read the Jira mirror: {error}',
      from: 'From',
      to: 'To',
      preset: {
        thisWeek: 'This week',
        nextWeek: 'Next week',
        next2Weeks: 'Next 2 weeks',
        thisMonth: 'This month',
        nextMonth: 'Next month',
        last2Weeks: 'Last 2 weeks',
      },
      wholeTeam: 'Whole team',
      unassigned: 'Unassigned',
      others: 'Others',
      view: { chart: 'Chart', table: 'Table' },
      granularity: { day: 'Days', week: 'Weeks' },
      stat: {
        capacity: 'capacity',
        planned: 'planned',
        logged: 'logged',
        utilization: 'utilization',
        flags: '{unscheduled} unscheduled · {overdue} overdue',
        flagsHint: 'estimated work the timeline cannot place',
      },
      h: 'h',
      col: {
        person: 'Person',
        total: 'Total',
        util: 'Util.',
        open: 'Open',
        key: 'Key',
        summary: 'Summary',
        status: 'Status',
        start: 'Start',
        due: 'Due',
        remaining: 'Remaining',
        inRange: 'In range',
        flag: 'Flag',
      },
      flag: { overdue: 'overdue', unscheduled: 'no due date', unestimated: 'no estimate' },
      teamTotal: 'Team',
      showAll: 'All issues',
      showFlagged: 'Flagged only',
      empty: 'No estimated work lands in this range.',
      emptyHint: '{count} open issues carry an estimate but no due date — they are not on the timeline.',
      chartAria: 'Workload per period against capacity',
      legendCapacity: 'capacity',
      legendLogged: 'logged',
      legendPlanned: 'planned',
      today: 'today',
      tip: '{name} · {load}h of {cap}h · {period}',
      tipTeam: 'Team · {load}h of {cap}h · {period}',
    },
```

- [ ] **Step 2: Add the Ukrainian keys**

Same place in `apps/ui/src/i18n/uk/index.ts`:

```ts
    capacity: {
      leadBefore: 'Навантаження команди воркспейсу',
      leadAfter: '— оцінки Jira та залогований час проти {hours} год на людину за робочий день.',
      gateTitle: 'Навантаження читається з Jira',
      gateText: 'Team Capacity додає оцінки й ворклоги дошки Jira цього воркспейсу. У власної дошки оцінок немає, тож показувати нічого, доки не підключено дошку Jira.',
      gateButton: 'Відкрити Інтеграції',
      loading: 'Читаємо дзеркало Jira…',
      loadError: 'Не вдалося прочитати дзеркало Jira: {error}',
      from: 'Від',
      to: 'До',
      preset: {
        thisWeek: 'Цей тиждень',
        nextWeek: 'Наступний тиждень',
        next2Weeks: 'Наступні 2 тижні',
        thisMonth: 'Цей місяць',
        nextMonth: 'Наступний місяць',
        last2Weeks: 'Останні 2 тижні',
      },
      wholeTeam: 'Уся команда',
      unassigned: 'Не призначено',
      others: 'Інші',
      view: { chart: 'Графік', table: 'Таблиця' },
      granularity: { day: 'Дні', week: 'Тижні' },
      stat: {
        capacity: 'потужність',
        planned: 'заплановано',
        logged: 'залоговано',
        utilization: 'завантаження',
        flags: '{unscheduled} без дати · {overdue} прострочено',
        flagsHint: 'оцінена робота, якої графік не показує',
      },
      h: 'год',
      col: {
        person: 'Людина',
        total: 'Разом',
        util: 'Заван.',
        open: 'Відкр.',
        key: 'Ключ',
        summary: 'Назва',
        status: 'Статус',
        start: 'Початок',
        due: 'Дедлайн',
        remaining: 'Лишилось',
        inRange: 'У періоді',
        flag: 'Позначка',
      },
      flag: { overdue: 'прострочено', unscheduled: 'без дедлайну', unestimated: 'без оцінки' },
      teamTotal: 'Команда',
      showAll: 'Усі тікети',
      showFlagged: 'Лише з позначкою',
      empty: 'У цьому періоді немає оціненої роботи.',
      emptyHint: '{count} відкритих тікетів мають оцінку, але не мають дедлайну — їх немає на графіку.',
      chartAria: 'Навантаження за період проти потужності',
      legendCapacity: 'потужність',
      legendLogged: 'залоговано',
      legendPlanned: 'заплановано',
      today: 'сьогодні',
      tip: '{name} · {load} з {cap} год · {period}',
      tipTeam: 'Команда · {load} з {cap} год · {period}',
    },
```

- [ ] **Step 3: Run the completeness test**

Run: `pnpm --filter @kermanych/ui test -- i18n`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/ui/src/i18n/en/index.ts apps/ui/src/i18n/uk/index.ts
git commit -m "feat(capacity): screen strings in en and uk

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 10: `CapacityChart.vue`

**Files:**
- Create: `apps/ui/src/components/capacity/CapacityChart.vue`

**Interfaces:**
- Consumes: `CapacityReport`, `CapacityPerson`, `CapacityCell`, `CapacityPeriod`, `hoursOf` from `lib/capacity.ts`; `UNASSIGNED` from `lib/jira-view.ts`; `formatIsoDate` from `lib/calendar.ts`; `v-tip` directive (global).
- Produces: `<CapacityChart :report="…" @pick="(personId: string) => …" />`. Emits `pick` with a person id when a legend swatch is clicked.

No unit test (apps/ui has no component tests); its numbers come from the tested lib and it is verified visually in Task 12.

- [ ] **Step 1: Write the component**

```vue
<template>
  <figure class="capchart" :aria-label="t('management.capacity.chartAria')">
    <svg class="capchart__svg" :viewBox="`0 0 ${width} ${HEIGHT}`" :style="{ minWidth: `${width}px` }" role="img">
      <defs>
        <!-- Planned time is a forecast; logged time happened. Same colour per person, the
             forecast hatched — so the eye reads the today rule as a change of fact, not of
             person. -->
        <pattern id="capchart-hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <line x1="0" y1="0" x2="0" y2="6" stroke="var(--k-bg)" stroke-width="2.5" stroke-opacity="0.55" />
        </pattern>
      </defs>

      <!-- Y grid: one hairline per tick, hours at the left. -->
      <g v-for="tick in ticks" :key="tick" class="capchart__grid">
        <line :x1="PAD_L" :x2="width - PAD_R" :y1="y(tick)" :y2="y(tick)" />
        <text :x="PAD_L - 6" :y="y(tick) + 3" text-anchor="end" class="capchart__axis mono">{{ tick }}</text>
      </g>

      <!-- Bars -->
      <g v-for="(bar, i) in bars" :key="report.periods[i]!.key">
        <rect
          v-for="seg in bar.segments"
          :key="seg.key"
          :x="x(i)"
          :y="seg.y"
          :width="BAR_W"
          :height="seg.h"
          :style="{ fill: seg.color }"
          class="capchart__seg"
          v-tip="seg.tip"
        />
        <rect
          v-for="seg in bar.segments.filter((s) => s.planned)"
          :key="`${seg.key}:hatch`"
          :x="x(i)"
          :y="seg.y"
          :width="BAR_W"
          :height="seg.h"
          fill="url(#capchart-hatch)"
          pointer-events="none"
        />
        <!-- Capacity tick: where the bar should stop. -->
        <line
          v-if="bar.capacity > 0"
          :x1="x(i) - 3"
          :x2="x(i) + BAR_W + 3"
          :y1="y(bar.capacity)"
          :y2="y(bar.capacity)"
          class="capchart__cap"
        />
        <rect
          v-if="bar.over"
          :x="x(i) - 1"
          :y="bar.top - 1"
          :width="BAR_W + 2"
          :height="PLOT_BOTTOM - bar.top + 1"
          class="capchart__over"
          pointer-events="none"
        />
        <text :x="x(i) + BAR_W / 2" :y="PLOT_BOTTOM + 14" text-anchor="middle" class="capchart__axis mono" :class="{ 'capchart__axis--past': report.periods[i]!.past }">
          {{ label(i) }}
        </text>
      </g>

      <!-- Today: the boundary between what was logged and what is planned. -->
      <g v-if="todayX !== undefined">
        <line :x1="todayX" :x2="todayX" :y1="PAD_T - 4" :y2="PLOT_BOTTOM" class="capchart__today" />
        <text :x="todayX + 4" :y="PAD_T + 6" class="capchart__axis capchart__axis--today mono">{{ t('management.capacity.today') }}</text>
      </g>
    </svg>

    <figcaption class="capchart__legend">
      <button
        v-for="s in series"
        :key="s.id"
        type="button"
        class="capchart__key"
        :disabled="s.id === OTHERS"
        @click="emit('pick', s.id)"
      >
        <i class="capchart__swatch" :style="{ background: s.color }" aria-hidden="true"></i>
        {{ s.name }}
      </button>
      <span class="capchart__key capchart__key--static">
        <i class="capchart__swatch capchart__swatch--hatch" aria-hidden="true"></i>{{ t('management.capacity.legendPlanned') }}
      </span>
      <span class="capchart__key capchart__key--static">
        <i class="capchart__swatch capchart__swatch--cap" aria-hidden="true"></i>{{ t('management.capacity.legendCapacity') }}
      </span>
    </figcaption>
  </figure>
</template>

<script setup lang="ts">
// The capacity chart: one stacked bar per period, one segment per person, a capacity tick
// per bar. Hand-rolled SVG like RiskMatrix — the app has no chart library and its palette
// is the token set, which a library would not read.
//
// Everything numeric arrives in the report; this file only decides pixels. Persons beyond
// the top MAX_SERIES by load are folded into «Others» so a twelve-person board stays
// legible, and the unassigned bucket keeps its own muted swatch because it is load with
// nobody's hours behind it.
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { hoursOf, sumCells, type CapacityReport } from '../../lib/capacity';
import { formatIsoDate } from '../../lib/calendar';
import { UNASSIGNED } from '../../lib/jira-view';

const props = defineProps<{ report: CapacityReport }>();
const emit = defineEmits<{ pick: [personId: string] }>();
const { t } = useI18n();

const HEIGHT = 260;
const PAD_L = 40;
const PAD_R = 12;
const PAD_T = 18;
const PAD_B = 24;
const BAR_W = 22;
const GAP = 10;
const PLOT_BOTTOM = HEIGHT - PAD_B;
const PLOT_H = PLOT_BOTTOM - PAD_T;
const MAX_SERIES = 8;
const OTHERS = '@others';

// Token-derived categorical palette: the three status hues first (they are already tuned
// for both canvases), then mixes toward text so neighbours never share a hue.
const PALETTE = [
  'var(--k-accent)',
  'var(--k-success)',
  'var(--k-warning)',
  'color-mix(in srgb, var(--k-accent) 45%, var(--k-text))',
  'color-mix(in srgb, var(--k-success) 45%, var(--k-text))',
  'color-mix(in srgb, var(--k-warning) 45%, var(--k-text))',
  'color-mix(in srgb, var(--k-accent) 50%, var(--k-success))',
  'color-mix(in srgb, var(--k-warning) 50%, var(--k-success))',
];
const OTHERS_COLOR = 'var(--k-muted)';
const UNASSIGNED_COLOR = 'var(--k-faint)';

type Series = { id: string; name: string; color: string; members: string[] };

const series = computed<Series[]>(() => {
  const named = props.report.persons.filter((p) => p.id !== UNASSIGNED);
  const top = named.slice(0, MAX_SERIES);
  const rest = named.slice(MAX_SERIES);
  const out: Series[] = top.map((p, i) => ({ id: p.id, name: p.name, color: PALETTE[i % PALETTE.length]!, members: [p.id] }));
  if (rest.length) out.push({ id: OTHERS, name: t('management.capacity.others'), color: OTHERS_COLOR, members: rest.map((p) => p.id) });
  if (props.report.persons.some((p) => p.id === UNASSIGNED))
    out.push({ id: UNASSIGNED, name: t('management.capacity.unassigned'), color: UNASSIGNED_COLOR, members: [UNASSIGNED] });
  return out;
});

const width = computed(() => PAD_L + props.report.periods.length * (BAR_W + GAP) + PAD_R);

// Y axis in hours, topped at a multiple of 8 above the tallest bar or tick.
const yMaxHours = computed(() => {
  let max = 0;
  props.report.totals.forEach((c) => {
    max = Math.max(max, hoursOf(c.loadSeconds), hoursOf(c.capacitySeconds));
  });
  return Math.max(8, Math.ceil(max / 8) * 8);
});

const ticks = computed(() => {
  const step = yMaxHours.value <= 40 ? 8 : Math.ceil(yMaxHours.value / 5 / 8) * 8;
  const out: number[] = [];
  for (let h = 0; h <= yMaxHours.value; h += step) out.push(h);
  return out;
});

function y(hoursValue: number): number {
  return PAD_T + PLOT_H * (1 - Math.min(hoursValue, yMaxHours.value) / yMaxHours.value);
}

function x(i: number): number {
  return PAD_L + i * (BAR_W + GAP) + GAP / 2;
}

function periodLabel(i: number): string {
  const p = props.report.periods[i]!;
  return props.report.granularity === 'day' ? formatIsoDate(p.key) : `${formatIsoDate(p.from)} – ${formatIsoDate(p.to)}`;
}

function label(i: number): string {
  const p = props.report.periods[i]!;
  const d = formatIsoDate(p.key); // DD.MM.YYYY
  return props.report.granularity === 'day' ? d.slice(0, 2) : d.slice(0, 5);
}

type Segment = { key: string; y: number; h: number; color: string; planned: boolean; tip: string };
type Bar = { segments: Segment[]; capacity: number; top: number; over: boolean };

const bars = computed<Bar[]>(() =>
  props.report.periods.map((p, i) => {
    const segments: Segment[] = [];
    // Stack in SECONDS and round once per boundary: rounding each segment to 0.1h before
    // adding lets the drawn bar drift from the total that decides the over-capacity outline.
    let stackSecs = 0;
    const period = periodLabel(i);
    for (const s of series.value) {
      const cell = sumCells(s.members.map((id) => props.report.cells[id]![i]!));
      const cap = hoursOf(cell.capacitySeconds);
      for (const planned of [false, true]) {
        const secs = planned ? cell.plannedSeconds : cell.loggedSeconds;
        if (secs <= 0) continue;
        const yTop = y(hoursOf(stackSecs + secs));
        const yBottom = y(hoursOf(stackSecs));
        segments.push({
          key: `${s.id}:${planned ? 'plan' : 'log'}`,
          y: yTop,
          h: Math.max(yBottom - yTop, 1),
          color: s.color,
          planned,
          tip: t('management.capacity.tip', { name: s.name, load: hoursOf(secs), cap, period }),
        });
        stackSecs += secs;
      }
    }
    const total = props.report.totals[i]!;
    const capacity = hoursOf(total.capacitySeconds);
    return { segments, capacity, top: y(hoursOf(stackSecs)), over: capacity > 0 && hoursOf(total.loadSeconds) > capacity };
  }),
);

// The rule sits at the start of the first period that is not wholly past — only when
// there is something past to separate it from.
const todayX = computed<number | undefined>(() => {
  const i = props.report.periods.findIndex((p) => !p.past);
  if (i <= 0) return undefined;
  return x(i) - GAP / 2;
});
</script>

<style scoped lang="scss">
.capchart {
  display: flex;
  flex-direction: column;
  gap: var(--k-sp-2);
  margin: 0;
  overflow-x: auto;
}

.capchart__svg {
  display: block;
  width: 100%;
  height: auto;
}

.capchart__grid line {
  stroke: var(--k-line);
  stroke-width: 1;
}

.capchart__axis {
  font-size: 9px;
  fill: var(--k-faint);
}

.capchart__axis--past {
  fill: var(--k-muted);
}

.capchart__axis--today {
  fill: var(--k-accent);
}

.capchart__seg {
  transition: opacity 0.16s ease;

  &:hover {
    opacity: 0.85;
  }
}

.capchart__cap {
  stroke: var(--k-text);
  stroke-width: 2;
}

.capchart__over {
  fill: none;
  stroke: var(--k-danger);
  stroke-width: 1.5;
}

.capchart__today {
  stroke: var(--k-accent);
  stroke-width: 1;
  stroke-dasharray: 3 3;
}

.capchart__legend {
  display: flex;
  flex-wrap: wrap;
  gap: var(--k-sp-2) var(--k-sp-3);
}

.capchart__key {
  appearance: none;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 0;
  border: 0;
  background: none;
  font-size: var(--k-fs-xs);
  color: var(--k-muted);
  cursor: pointer;

  &:disabled,
  &--static {
    cursor: default;
  }

  &:not(:disabled):not(&--static):hover {
    color: var(--k-text);
  }
}

.capchart__swatch {
  display: inline-block;
  width: 10px;
  height: 10px;
  border-radius: 2px;
}

.capchart__swatch--hatch {
  background: repeating-linear-gradient(45deg, var(--k-muted) 0 2px, transparent 2px 4px);
}

.capchart__swatch--cap {
  height: 2px;
  background: var(--k-text);
}

@media (prefers-reduced-motion: reduce) {
  .capchart__seg {
    transition: none;
  }
}
</style>
```

- [ ] **Step 2: Typecheck**

Run: `pnpm --filter @kermanych/ui typecheck`
Expected: PASS (the component is not yet mounted anywhere; vue-tsc still checks it).

- [ ] **Step 3: Commit**

```bash
git add apps/ui/src/components/capacity/CapacityChart.vue
git commit -m "feat(capacity): stacked capacity chart

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 11: `ManagementCapacityPage.vue` and the route

**Files:**
- Create: `apps/ui/src/pages/ManagementCapacityPage.vue`
- Modify: `apps/ui/src/router/routes.ts:16-20` (`SECTION_PAGES`)

**Interfaces:**
- Consumes: `useJira()` (`probe`, `open`, `close`, `integration`, `issues`, `loading`, `loadError`, `syncing`, `fetchWorklogs`), `lib/capacity.ts` (everything), `lib/format.ts hours`, `lib/calendar.ts` (`todayIso`, `formatIsoDate`), kit `KDateField`, `KChipSelect`, `KSelect`, `KTabs`, `KTable`, `KTag`, `KBtn`, `CapacityChart`.

- [ ] **Step 1: Register the route**

In `apps/ui/src/router/routes.ts` `SECTION_PAGES` add:

```ts
  'management-capacity': () => import('pages/ManagementCapacityPage.vue'),
```

- [ ] **Step 2: Write the page**

```vue
<template>
  <section class="cap">
    <p class="cap__lead">
      {{ t('management.capacity.leadBefore') }}
      <span class="cap__lead-workspace mono">{{ workspaceName }}</span>
      {{ t('management.capacity.leadAfter', { hours: DEFAULT_HOURS_PER_DAY }) }}
    </p>

    <!-- The «regular board only» state, stated rather than hidden: the section exists in
         the rail for every workspace, and an empty pane under a finished nav reads as a bug. -->
    <div v-if="jira.integration === null" class="cap__gate">
      <span class="cap__gate-title mono">{{ t('management.capacity.gateTitle') }}</span>
      <p class="cap__gate-text">{{ t('management.capacity.gateText') }}</p>
      <KBtn variant="primary" @click="router.push({ name: 'management-integrations' })">
        {{ t('management.capacity.gateButton') }}
      </KBtn>
    </div>

    <p v-else-if="jira.integration === undefined || (jira.loading && !jira.issues.length)" class="cap__note mono">
      {{ t('management.capacity.loading') }}
    </p>

    <template v-else>
      <div class="cap__toolbar">
        <KDateField v-model="from" :label="t('management.capacity.from')" :now-ms="nowMs" />
        <KDateField v-model="to" :label="t('management.capacity.to')" :now-ms="nowMs" />
        <KChipSelect v-model="presetModel" :options="presetOptions" :title="t('management.capacity.from')" />
        <KSelect v-model="person" :options="personOptions" />
        <KTabs v-model="granularityModel" :tabs="granularityTabs" />
        <KTabs v-model="view" :tabs="viewTabs" />
      </div>

      <p v-if="jira.loadError" class="cap__error">{{ t('management.capacity.loadError', { error: jira.loadError }) }}</p>

      <div class="cap__stats">
        <article class="cap__stat">
          <span class="cap__stat-label mono">{{ t('management.capacity.stat.capacity') }}</span>
          <strong class="cap__stat-value">{{ hours(report.summary.capacitySeconds) }}<small>{{ t('management.capacity.h') }}</small></strong>
        </article>
        <article class="cap__stat">
          <span class="cap__stat-label mono">{{ t('management.capacity.stat.planned') }}</span>
          <strong class="cap__stat-value">{{ hours(report.summary.plannedSeconds) }}<small>{{ t('management.capacity.h') }}</small></strong>
        </article>
        <article class="cap__stat">
          <span class="cap__stat-label mono">{{ t('management.capacity.stat.logged') }}</span>
          <strong class="cap__stat-value">{{ hours(report.summary.loggedSeconds) }}<small>{{ t('management.capacity.h') }}</small></strong>
        </article>
        <article class="cap__stat" :class="`cap__stat--${bandOf(report.summary.utilization)}`">
          <span class="cap__stat-label mono">{{ t('management.capacity.stat.utilization') }}</span>
          <strong class="cap__stat-value">{{ percentOf(report.summary.utilization) }}</strong>
        </article>
        <button
          type="button"
          class="cap__stat cap__stat--button"
          :class="{ 'cap__stat--warn': report.unscheduled.length || report.overdue.length, 'cap__stat--active': flaggedOnly }"
          v-tip="t('management.capacity.stat.flagsHint')"
          @click="toggleFlagged"
        >
          <span class="cap__stat-label mono">{{ t('management.capacity.stat.flags', { unscheduled: report.unscheduled.length, overdue: report.overdue.length }) }}</span>
          <span class="cap__stat-note">{{ flaggedOnly ? t('management.capacity.showAll') : t('management.capacity.showFlagged') }}</span>
        </button>
      </div>

      <div v-if="!report.summary.loadSeconds && !flaggedOnly" class="cap__blank">
        <p class="cap__blank-text">{{ t('management.capacity.empty') }}</p>
        <p v-if="report.unscheduled.length" class="cap__blank-hint mono">
          {{ t('management.capacity.emptyHint', { count: report.unscheduled.length }) }}
        </p>
      </div>

      <CapacityChart v-else-if="view === 'chart' && !flaggedOnly" :report="report" @pick="pickPerson" />

      <div v-else-if="teamTable" class="cap__table-wrap">
        <KTable :columns="teamColumns" :rows="teamRows" :row-key="(r: TeamRow) => r.id" clickable @row-click="(r: TeamRow) => pickPerson(r.id)">
          <template #cell-person="{ row }">
            <span :class="{ 'cap__dash': row.id === UNASSIGNED, 'cap__strong': row.id === TEAM }">{{ row.name }}</span>
          </template>
          <template v-for="(p, i) in report.periods" :key="p.key" #[`cell-p${i}`]="{ row }">
            <span class="cap__cell mono" :class="`cap__cell--${bandOf(row.cells[i]!.utilization)}`" v-tip="cellTip(row, i)">
              {{ hours(row.cells[i]!.loadSeconds) }}<span class="cap__cell-cap">/{{ hours(row.cells[i]!.capacitySeconds) }}</span>
            </span>
          </template>
          <template #cell-total="{ row }">
            <span class="mono">{{ hours(row.total.loadSeconds) }}/{{ hours(row.total.capacitySeconds) }}</span>
          </template>
          <template #cell-util="{ row }">
            <span class="cap__cell mono" :class="`cap__cell--${bandOf(row.total.utilization)}`">{{ percentOf(row.total.utilization) }}</span>
          </template>
          <template #cell-open="{ row }">
            <span class="mono">{{ row.open }}</span>
          </template>
        </KTable>
      </div>

      <div v-else class="cap__table-wrap">
        <KTable :columns="issueColumns" :rows="issueRows" :row-key="(r: CapacityIssueRow) => r.key">
          <template #cell-key="{ row }">
            <a class="cap__key mono" :href="issueUrl(row.key)" target="_blank" rel="noopener">{{ row.key }}</a>
          </template>
          <template #cell-person="{ row }">
            <span :class="{ 'cap__dash': row.person.id === UNASSIGNED }">{{ personName(row.person) }}</span>
          </template>
          <template #cell-status="{ row }">
            <KTag plain>{{ row.statusName }}</KTag>
          </template>
          <template #cell-start="{ row }">
            <span class="mono" :class="{ 'cap__dash': !row.startDate }">{{ row.startDate ? formatIsoDate(row.startDate) : '—' }}</span>
          </template>
          <template #cell-due="{ row }">
            <span class="mono" :class="{ 'cap__dash': !row.dueDate, 'cap__overdue': row.flag === 'overdue' }">{{ row.dueDate ? formatIsoDate(row.dueDate) : '—' }}</span>
          </template>
          <template #cell-remaining="{ row }">
            <span class="mono">{{ hours(row.remainingSeconds) }}{{ t('management.capacity.h') }}</span>
          </template>
          <template #cell-inRange="{ row }">
            <span class="mono">{{ hours(row.inRangeSeconds) }}{{ t('management.capacity.h') }}</span>
          </template>
          <template #cell-flag="{ row }">
            <KTag v-if="row.flag" :class="`cap__flag cap__flag--${row.flag}`">{{ t(`management.capacity.flag.${row.flag}`) }}</KTag>
          </template>
        </KTable>
      </div>
    </template>
  </section>
</template>

<script setup lang="ts">
// Team Capacity — Jira's estimates and worklogs against an 8 h/day baseline, for a date range
// the operator picks. The shell (ManagementPage) renders the heading and the workspace gate;
// this component assumes a workspace and adds one gate of its own: a Jira board, because the
// native board has no estimates and capacity without estimates is a blank chart.
//
// View state only. Every number comes from lib/capacity.ts `capacityReport`, which is also
// what the Менеджмент assistant is handed — so a figure quoted in the chat is a figure on
// this screen.
import { computed, onUnmounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRouter } from 'vue-router';
import type { JiraWorklog } from '@kermanych/cloud';
import KBtn from 'components/kit/KBtn.vue';
import KChipSelect from 'components/kit/KChipSelect.vue';
import KDateField from 'components/kit/KDateField.vue';
import KSelect, { type KSelectOption } from 'components/kit/KSelect.vue';
import KTable, { type KTableColumn } from 'components/kit/KTable.vue';
import KTabs from 'components/kit/KTabs.vue';
import KTag from 'components/kit/KTag.vue';
import CapacityChart from 'components/capacity/CapacityChart.vue';
import { useJira } from 'stores/jira';
import { useNow } from '../composables/useNow';
import { formatIsoDate } from '../lib/calendar';
import { hours } from '../lib/format';
import { UNASSIGNED } from '../lib/jira-view';
import {
  CAPACITY_PRESETS,
  DEFAULT_HOURS_PER_DAY,
  capacityReport,
  defaultGranularity,
  normalizeRange,
  presetRange,
  sumCells,
  todayIso,
  type CapacityCell,
  type CapacityGranularity,
  type CapacityIssueRow,
  type CapacityPerson,
  type CapacityPreset,
  type CapacityRange,
} from '../lib/capacity';

const props = defineProps<{ workspaceId: string; workspaceName: string }>();

const { t } = useI18n();
const router = useRouter();
const jira = useJira();
// The report is anchored on today; a minute's tick is enough for a screen measured in days.
const nowMs = useNow(60_000);
const today = computed(() => todayIso(nowMs.value));

const TEAM = '@team';
const ALL = '';

// ── range ─────────────────────────────────────────────────────────────────────

// Remembered per workspace, like the board's view switch: a manager who looks at «next two
// weeks» every Monday should not have to pick it every Monday.
type Saved = { from: string; to: string; preset: CapacityPreset | ''; granularity: CapacityGranularity | '' };
const storageKey = () => `capacity:${props.workspaceId}`;
function readSaved(): Saved | undefined {
  try {
    const raw = localStorage.getItem(storageKey());
    return raw ? (JSON.parse(raw) as Saved) : undefined;
  } catch {
    return undefined;
  }
}

const preset = ref<CapacityPreset | ''>('next2Weeks');
const from = ref('');
const to = ref('');
// '' = follow the range length (defaultGranularity); set once the operator chose.
const granularityChoice = ref<CapacityGranularity | ''>('');

function applyPreset(p: CapacityPreset): void {
  const r = presetRange(p, today.value);
  from.value = r.from;
  to.value = r.to;
  preset.value = p;
  granularityChoice.value = '';
}

// Editing a date deselects the preset; the chip then reads as «custom».
watch([from, to], () => {
  if (preset.value && presetRange(preset.value, today.value).from !== from.value) preset.value = '';
  else if (preset.value && presetRange(preset.value, today.value).to !== to.value) preset.value = '';
});

// KChipSelect is generic over its option type; the model is a plain string here so the
// «no preset» state ('') needs no option of its own.
const presetModel = computed({
  get: () => preset.value as string,
  set: (v: string) => {
    if (v) applyPreset(v as CapacityPreset);
  },
});
const presetOptions = computed(() =>
  CAPACITY_PRESETS.map((value) => ({ value: value as string, label: t(`management.capacity.preset.${value}`) })),
);

const range = computed<CapacityRange | undefined>(() =>
  from.value && to.value ? normalizeRange({ from: from.value, to: to.value }) : undefined,
);

const granularityModel = computed({
  get: () => granularityChoice.value || (range.value ? defaultGranularity(range.value) : 'day'),
  set: (v: string) => {
    granularityChoice.value = v as CapacityGranularity;
  },
});
const granularityTabs = computed(() => [
  { value: 'day', label: t('management.capacity.granularity.day') },
  { value: 'week', label: t('management.capacity.granularity.week') },
]);

watch([from, to, preset, granularityChoice], () => {
  try {
    localStorage.setItem(storageKey(), JSON.stringify({ from: from.value, to: to.value, preset: preset.value, granularity: granularityChoice.value } satisfies Saved));
  } catch {
    /* private mode: the preference just does not stick */
  }
});

// ── person / view ─────────────────────────────────────────────────────────────

const person = ref(ALL);
// A string, not a union: KTabs emits `string`, and a narrower ref fails vue-tsc on v-model.
const view = ref<string>('chart');
const viewTabs = computed(() => [
  { value: 'chart', label: t('management.capacity.view.chart') },
  { value: 'table', label: t('management.capacity.view.table') },
]);
const flaggedOnly = ref(false);

function toggleFlagged(): void {
  flaggedOnly.value = !flaggedOnly.value;
  if (flaggedOnly.value) view.value = 'table';
}

function pickPerson(id: string): void {
  if (id === TEAM) return;
  person.value = person.value === id ? ALL : id;
}

// ── data ──────────────────────────────────────────────────────────────────────

const worklogs = ref<JiraWorklog[]>([]);
let worklogGeneration = 0;

async function loadWorklogs(): Promise<void> {
  const r = range.value;
  if (!r || !jira.integration) return;
  const mine = ++worklogGeneration;
  try {
    const rows = await jira.fetchWorklogs(r);
    if (mine === worklogGeneration) worklogs.value = rows;
  } catch {
    // The chart still shows the plan; logged time is best-effort until the next tick.
  }
}

watch(
  () => props.workspaceId,
  async (id) => {
    if (!id) return;
    person.value = ALL;
    flaggedOnly.value = false;
    const saved = readSaved();
    // A remembered PRESET is re-resolved against today — «next 2 weeks» saved last Monday
    // means this coming fortnight, not last week's. Only custom dates are kept verbatim.
    if (saved?.preset) applyPreset(saved.preset);
    else if (saved?.from && saved.to) {
      from.value = saved.from;
      to.value = saved.to;
      preset.value = '';
    } else applyPreset('next2Weeks');
    if (saved?.granularity) granularityChoice.value = saved.granularity;
    await jira.open(id);
    void loadWorklogs();
  },
  { immediate: true },
);

watch(range, () => void loadWorklogs());
// The sync tick refreshes issues through realtime; worklogs have no channel, so they are
// re-read when a tick finishes.
watch(
  () => jira.syncing,
  (now, before) => {
    if (before && !now) void loadWorklogs();
  },
);

onUnmounted(() => jira.close());

// The unfiltered report feeds the person picker, so the list does not shrink to the one
// person picked.
const teamReport = computed(() =>
  capacityReport(jira.issues, worklogs.value, {
    range: range.value ?? { from: today.value, to: today.value },
    today: today.value,
    granularity: granularityModel.value as CapacityGranularity,
  }),
);
const report = computed(() =>
  person.value === ALL
    ? teamReport.value
    : capacityReport(jira.issues, worklogs.value, {
        range: range.value ?? { from: today.value, to: today.value },
        today: today.value,
        granularity: granularityModel.value as CapacityGranularity,
        person: person.value,
      }),
);

function personName(p: CapacityPerson): string {
  return p.id === UNASSIGNED ? t('management.capacity.unassigned') : p.name || p.id;
}

const personOptions = computed<KSelectOption[]>(() => [
  { value: ALL, label: t('management.capacity.wholeTeam') },
  ...teamReport.value.persons.map((p) => ({ value: p.id, label: personName(p) })),
]);

// ── presentation ──────────────────────────────────────────────────────────────

// Utilization bands: the same four-step ladder the risk matrix uses, so the colours mean
// the same thing across Менеджмент.
function bandOf(u: number): 'idle' | 'ok' | 'high' | 'over' {
  if (u > 1.2) return 'over';
  if (u > 1) return 'high';
  if (u >= 0.8) return 'ok';
  return 'idle';
}

function percentOf(u: number): string {
  return `${Math.round(u * 100)}%`;
}

function issueUrl(key: string): string {
  const site = jira.integration?.siteUrl ?? '';
  return `${site.replace(/\/$/, '')}/browse/${key}`;
}

type TeamRow = { id: string; name: string; cells: CapacityCell[]; total: CapacityCell; open: number };

const teamTable = computed(() => person.value === ALL && !flaggedOnly.value);

const teamColumns = computed<KTableColumn[]>(() => [
  { key: 'person', label: t('management.capacity.col.person'), width: '160px' },
  ...report.value.periods.map((p, i) => ({
    key: `p${i}`,
    label: report.value.granularity === 'day' ? formatIsoDate(p.key).slice(0, 5) : formatIsoDate(p.from).slice(0, 5),
    align: 'right' as const,
    mono: true,
  })),
  { key: 'total', label: t('management.capacity.col.total'), align: 'right', width: '92px', mono: true },
  { key: 'util', label: t('management.capacity.col.util'), align: 'right', width: '64px', mono: true },
  { key: 'open', label: t('management.capacity.col.open'), align: 'right', width: '56px', mono: true },
]);

const teamRows = computed<TeamRow[]>(() => [
  ...report.value.persons.map((p) => ({
    id: p.id,
    name: personName(p),
    cells: report.value.cells[p.id]!,
    total: sumCells(report.value.cells[p.id]!),
    open: report.value.issues.filter((r) => r.person.id === p.id).length,
  })),
  { id: TEAM, name: t('management.capacity.teamTotal'), cells: report.value.totals, total: report.value.summary, open: report.value.issues.length },
]);

function cellTip(row: TeamRow, i: number): string {
  const c = row.cells[i]!;
  const p = report.value.periods[i]!;
  const period = report.value.granularity === 'day' ? formatIsoDate(p.key) : `${formatIsoDate(p.from)} – ${formatIsoDate(p.to)}`;
  return row.id === TEAM
    ? t('management.capacity.tipTeam', { load: hours(c.loadSeconds), cap: hours(c.capacitySeconds), period })
    : t('management.capacity.tip', { name: row.name, load: hours(c.loadSeconds), cap: hours(c.capacitySeconds), period });
}

const issueColumns = computed<KTableColumn[]>(() => [
  { key: 'key', label: t('management.capacity.col.key'), width: '92px', mono: true },
  { key: 'summary', label: t('management.capacity.col.summary') },
  { key: 'person', label: t('management.capacity.col.person'), width: '140px' },
  { key: 'status', label: t('management.capacity.col.status'), width: '110px' },
  { key: 'start', label: t('management.capacity.col.start'), width: '96px' },
  { key: 'due', label: t('management.capacity.col.due'), width: '96px' },
  { key: 'remaining', label: t('management.capacity.col.remaining'), align: 'right', width: '84px' },
  { key: 'inRange', label: t('management.capacity.col.inRange'), align: 'right', width: '84px' },
  { key: 'flag', label: t('management.capacity.col.flag'), width: '110px' },
]);

const issueRows = computed<CapacityIssueRow[]>(() =>
  flaggedOnly.value ? report.value.issues.filter((r) => r.flag) : report.value.issues,
);
</script>

<style scoped lang="scss">
.cap {
  display: flex;
  flex-direction: column;
  gap: var(--k-sp-4);
}

.cap__lead {
  margin: 0;
  font-size: var(--k-fs-sm);
  color: var(--k-muted);
}

.cap__lead-workspace {
  color: var(--k-text);
}

.cap__gate {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: var(--k-sp-3);
  max-width: 460px;
  padding: var(--k-sp-5);
  background: color-mix(in srgb, var(--k-surface2) 30%, transparent);
  border: var(--k-rule-thin) dashed var(--k-line-strong);
  border-radius: var(--k-r-lg);
}

.cap__gate-title {
  font-size: 10px;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: var(--k-accent);
}

.cap__gate-text,
.cap__blank-text {
  margin: 0;
  font-size: var(--k-fs-sm);
  color: var(--k-muted);
}

.cap__note {
  margin: 0;
  font-size: var(--k-fs-xs);
  color: var(--k-faint);
}

.cap__toolbar {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-end;
  gap: var(--k-sp-2);

  > :nth-child(1),
  > :nth-child(2) {
    flex: 0 1 150px;
    min-width: 0;
  }

  > :nth-child(4) {
    flex: 0 1 200px;
    min-width: 0;
  }

  > :last-child {
    margin-left: auto;
  }
}

.cap__error {
  margin: 0;
  padding: var(--k-sp-3);
  font-size: var(--k-fs-sm);
  color: var(--k-text);
  background: color-mix(in srgb, var(--k-accent) 10%, transparent);
  border-left: var(--k-rule-strong) solid var(--k-accent);
}

.cap__stats {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
  gap: var(--k-sp-3);
}

.cap__stat {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: var(--k-sp-3);
  text-align: left;
  background: color-mix(in srgb, var(--k-surface2) 40%, transparent);
  border: var(--k-rule-thin) solid var(--k-line);
  border-radius: var(--k-r-lg);
}

.cap__stat--button {
  appearance: none;
  font: inherit;
  color: inherit;
  cursor: pointer;

  &:hover {
    border-color: var(--k-line-strong);
  }
}

.cap__stat--warn {
  border-color: color-mix(in srgb, var(--k-warning) 50%, transparent);
}

.cap__stat--active {
  border-color: var(--k-accent);
}

.cap__stat--ok .cap__stat-value {
  color: var(--k-success);
}

.cap__stat--high .cap__stat-value {
  color: var(--k-warning);
}

.cap__stat--over .cap__stat-value {
  color: var(--k-danger);
}

.cap__stat-label {
  font-size: 10px;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: var(--k-faint);
}

.cap__stat-value {
  font-family: var(--k-font-ui);
  font-size: 24px;
  font-weight: 800;
  letter-spacing: -0.02em;
  line-height: 1.15;
  color: var(--k-text);

  small {
    margin-left: 2px;
    font-size: 12px;
    font-weight: 500;
    color: var(--k-muted);
  }
}

.cap__stat-note {
  font-size: var(--k-fs-xs);
  color: var(--k-muted);
}

.cap__blank {
  display: flex;
  flex-direction: column;
  gap: var(--k-sp-2);
  padding: var(--k-sp-6);
  background: color-mix(in srgb, var(--k-surface2) 30%, transparent);
  border: var(--k-rule-thin) dashed var(--k-line-strong);
  border-radius: var(--k-r-lg);
}

.cap__blank-hint {
  margin: 0;
  font-size: var(--k-fs-xs);
  color: var(--k-faint);
}

.cap__table-wrap {
  overflow-x: auto;
}

.cap__cell {
  display: inline-block;
  padding: 1px 6px;
  border-radius: var(--k-r-sm);
}

.cap__cell-cap {
  color: var(--k-faint);
}

.cap__cell--ok {
  background: color-mix(in srgb, var(--k-success) 18%, transparent);
}

.cap__cell--high {
  background: color-mix(in srgb, var(--k-warning) 22%, transparent);
}

.cap__cell--over {
  background: color-mix(in srgb, var(--k-danger) 30%, transparent);
}

.cap__strong {
  font-weight: 700;
}

.cap__dash {
  color: var(--k-faint);
}

.cap__overdue {
  color: var(--k-danger);
}

.cap__key {
  color: var(--k-text);
  text-decoration: none;

  &:hover {
    text-decoration: underline;
  }
}

.cap__flag--overdue {
  color: var(--k-danger);
}

.cap__flag--unscheduled {
  color: var(--k-warning);
}
</style>
```

- [ ] **Step 3: Typecheck and run the UI suite**

Run: `pnpm --filter @kermanych/ui typecheck && pnpm --filter @kermanych/ui test`
Expected: PASS. Fix any vue-tsc complaint about the dynamic slot names (`#[\`cell-p${i}\`]`) by keeping the `v-for` on `<template>` exactly as written — Vue 3 supports dynamic slot names on `v-for` templates.

- [ ] **Step 4: Apply the migration to the dev stack and check the screen**

Run (per README «Applying a migration»): `supabase db push` or the project's documented equivalent; then `pnpm dev:api` and `pnpm dev:ui` in two terminals, open `/management/team-capacity` with a Jira-connected workspace selected, and press «Sync now» on the Jira board (or wait ≤10 min) so the `*_seconds` columns fill.

Verify by eye:
- Workspace without Jira → dashed «Capacity reads from Jira» card with a working button to Integrations.
- With Jira → toolbar, four tiles, chart with hatched future bars and a dashed «today» rule; capacity ticks per bar; over-capacity bars outlined red.
- Presets set both dates; editing a date clears the chip; Days/Weeks toggle; the choice survives a reload.
- Person select narrows chart + table; clicking a legend swatch or a team-table row does the same; picking again clears.
- Table (team) shows `load/cap` per period with band colours; Table (person) or the flags tile shows the issue rows with links to Jira.
- Dark and light themes both legible.

- [ ] **Step 5: Commit**

```bash
git add apps/ui/src/pages/ManagementCapacityPage.vue apps/ui/src/router/routes.ts
git commit -m "feat(capacity): Team Capacity screen

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 12: Docs and full verification

**Files:**
- Modify: `README.md:475-500` (the Менеджмент intro bullet list), `README.md:596-600` (the «every remaining section» sentence)

- [ ] **Step 1: Document the section and the digest**

In `README.md`, in the bullet list under «That field is a real assistant, and it is deliberately narrow:», add after the release-notes bullet:

```markdown
- **It reads the team's capacity.** Team Capacity is the one section marked `read`: the
  screen adds up the Jira board's remaining estimates (spread over business days up to
  each ticket's due date) and its worklogs against 8 h per person per business day, for a
  date range you pick, as a chart or a table, for the whole team or one assignee. The
  browser hands the assistant the same numbers by week — two weeks back, six ahead — as
  `context.capacity` on every turn, so «what's Marina's load for the next two weeks» is
  answered from the figures on the screen, never from the model's memory. Nothing there is
  writable: load changes by editing tickets in Jira, and the assistant says so. A
  workspace without a Jira board has no capacity to show — the native board carries no
  estimates — and both the screen and the context block state that.
```

Update the sentence at line ~598 «every remaining section is `none` or `read`» to:

```markdown
The Risk Registry and Release Notes are wired end to end; Team Capacity is `read` (a screen
and a context digest, nothing to write); every remaining section is `none`, and the chat
has no write path into them on purpose.
```

Also update the intro line «six workspace-scoped sections» → «seven workspace-scoped sections» if it still says six (count `MANAGEMENT_SECTIONS`).

- [ ] **Step 2: Run everything**

Run from the repo root:

```bash
pnpm -r test && pnpm --filter @kermanych/ui typecheck && pnpm --filter @kermanych/api typecheck && pnpm --filter @kermanych/core build && pnpm --filter @kermanych/cloud build
```

Expected: every package PASS, no type errors.

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs(capacity): describe Team Capacity and its chat digest

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

## Amendments made during execution

Rulings taken while executing (the ledger has the reasoning; the code is authoritative where it
differs from the task text above):

- **Task 5 / 8 fixtures:** the spread rule (max(start, today) → due) applies to every fixture;
  the KAN-6 and 2099 expectations above were corrected to match it.
- **Task 6:** `apps/ui/test/management-actions.spec.ts` pins the section limitation and was
  updated to the new text.
- **Task 10:** the chart stacks in seconds and rounds once per boundary; the hatch pattern id
  is per-instance (`useId`); the SVG never upscales (`width: auto; max-width: 100%`); the
  accessible name sits on the `<svg role="img">`. The per-person `cap` in the tooltip is by
  design.
- **Task 11:** `KChipSelect` needs an option for the custom state → `management.capacity.
  preset.custom` in both locales and `presetModel` maps `''` ↔ `'custom'`. User date edits go
  through an explicit `editDate()` handler that clears the preset and the Days/Weeks override
  (the `watch([from, to])` is gone). `useJira().open()` returns a token and `close(token)`
  ignores stale tokens; the page opens in `onMounted` (after a leaving Jira board's
  post-flush `close()`) and closes with its token. Saved presets/granularity are validated
  before use.

## Self-review notes

- **Spec coverage:** §1 data → Tasks 1–3; §2 model → Tasks 4–6; §3 store → Task 8; §4 screen (gate, toolbar, presets, person, view, granularity, tiles, chart, table, empty/error states, localStorage) → Tasks 10–11; §5 chat (capability `read`, types, digest window, prompt lines, protocol, sanitizer) → Tasks 6–8; §6 i18n + README → Tasks 6, 9, 12. §8 «Later» intentionally unbuilt.
- **Deviation from spec, on purpose:** `capacityReport` also seeds the roster from every assignee on the board (done issues included) so team capacity counts people with nothing due; `fetchWorklogs` returns rows instead of storing them, because the chat and the page read different ranges at once. `hoursOf` lives in `lib/capacity.ts` (numeric) and `hours` in `lib/format.ts` (string) — one for the digest, one for cells.
- **Type consistency:** `CapacityRange`, `CapacityReport`, `CapacityCell`, `CapacityIssueRow`, `CapacityPerson`, `sumCells`, `hoursOf`, `digestRange`, `capacityDigest`, `fetchWorklogs`, `loadBoard`, `ManagementCapacity{,Week,Person}` are named identically in every task that uses them.
