import { describe, expect, it } from 'vitest';
import type { JiraIssue, JiraWorklog } from '@kermanych/cloud';
import {
  businessDays,
  capacityPeriods,
  capacityReport,
  defaultGranularity,
  eachDay,
  isBusinessDay,
  normalizeRange,
  planIssue,
  presetRange,
  remainingSeconds,
  weekMonday,
} from '../src/lib/capacity';
import { UNASSIGNED } from '../src/lib/jira-view';

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
    // Unassigned work is load without capacity. KAN-6 due Mon 07, no start date: window is
    // [Fri 04, Mon 07] = 2 business days from today, 2h each.
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
