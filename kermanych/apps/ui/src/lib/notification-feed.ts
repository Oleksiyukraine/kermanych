// apps/ui/src/lib/notification-feed.ts
// «Центр сповіщень»'s one feed (docs/specs/2026-11-06-scheduled-tasks.md, decision 6): the skill
// improvements read from the cloud, this machine's schedule slips and the updates of Kermanych
// this machine received (docs/specs/2026-10-12-desktop-releases-and-updates.md, decision 12),
// merged by time, newest first. Pure, so the order and the «new» count are one rule for the
// column, its head and the avatar's dot.
import type { ScheduleSlip, SkillImprovementEntry } from '@kermanych/core';
import type { AppUpdateEntry } from '../stores/app-update';

/** One row of the column. */
export type NotificationItem =
  | { kind: 'skill-improvement'; entry: SkillImprovementEntry }
  | { kind: 'schedule-slip'; slip: ScheduleSlip }
  | { kind: 'app-update'; update: AppUpdateEntry };

function itemAt(i: NotificationItem): number {
  const at = i.kind === 'skill-improvement' ? i.entry.createdAt : i.kind === 'app-update' ? i.update.createdAt : i.slip.at;
  const ms = Date.parse(at);
  return Number.isNaN(ms) ? 0 : ms;
}

/** Newest first; equal times keep the cloud rows before the local ones, each list in its own order. */
export function mergeFeed(
  improvements: readonly SkillImprovementEntry[],
  slips: readonly ScheduleSlip[],
  updates: readonly AppUpdateEntry[],
): NotificationItem[] {
  const items: NotificationItem[] = [
    ...improvements.map((entry) => ({ kind: 'skill-improvement' as const, entry })),
    ...slips.map((slip) => ({ kind: 'schedule-slip' as const, slip })),
    ...updates.map((update) => ({ kind: 'app-update' as const, update })),
  ];
  // Array.prototype.sort is stable, so ties keep the order above.
  return items.sort((a, b) => itemAt(b) - itemAt(a));
}

/** New = not marked seen: an improvement or an update without `seenAt`, a slip with `seen: false`. */
export function isUnseen(i: NotificationItem): boolean {
  if (i.kind === 'skill-improvement') return !i.entry.seenAt;
  if (i.kind === 'app-update') return !i.update.seenAt;
  return !i.slip.seen;
}
