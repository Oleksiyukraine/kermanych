// apps/ui/src/lib/notification-feed.ts
// «Центр сповіщень»'s one feed (docs/specs/2026-11-06-scheduled-tasks.md, decision 6): the skill
// improvements read from the cloud and this machine's schedule slips, merged by time, newest
// first. Pure, so the order and the «new» count are one rule for the column, its head and the
// avatar's dot.
import type { ScheduleSlip, SkillImprovementEntry } from '@kermanych/core';

/** One row of the column. */
export type NotificationItem =
  | { kind: 'skill-improvement'; entry: SkillImprovementEntry }
  | { kind: 'schedule-slip'; slip: ScheduleSlip };

function itemAt(i: NotificationItem): number {
  const ms = Date.parse(i.kind === 'skill-improvement' ? i.entry.createdAt : i.slip.at);
  return Number.isNaN(ms) ? 0 : ms;
}

/** Newest first; equal times keep the cloud rows before the local ones, each list in its own order. */
export function mergeFeed(improvements: readonly SkillImprovementEntry[], slips: readonly ScheduleSlip[]): NotificationItem[] {
  const items: NotificationItem[] = [
    ...improvements.map((entry) => ({ kind: 'skill-improvement' as const, entry })),
    ...slips.map((slip) => ({ kind: 'schedule-slip' as const, slip })),
  ];
  // Array.prototype.sort is stable, so ties keep the order above.
  return items.sort((a, b) => itemAt(b) - itemAt(a));
}

/** New = not marked seen: an improvement without `seenAt`, a slip with `seen: false`. */
export function isUnseen(i: NotificationItem): boolean {
  return i.kind === 'skill-improvement' ? !i.entry.seenAt : !i.slip.seen;
}
