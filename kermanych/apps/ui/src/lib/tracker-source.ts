// apps/ui/src/lib/tracker-source.ts
// Which tracker Team Capacity and the Home capacity/tasks tiles read
// (docs/specs/2026-11-04-plane-integration.md, Decision 14). Pure, so the rule is tested
// apart from the stores that feed it.

export type TrackerKind = 'jira' | 'plane';

// The «Jira | Plane» switch's options: product names, the same in every language.
export const TRACKER_SOURCE_OPTIONS: { value: TrackerKind; label: string }[] = [
  { value: 'jira', label: 'Jira' },
  { value: 'plane', label: 'Plane' },
];

// The operator's last pick, per workspace, in this browser only.
export const trackerSourceKey = (workspaceId: string): string => `kermanych.tracker-source.${workspaceId}`;

/**
 * The tracker to read, given the ones the workspace has connected and the remembered pick.
 * With one connected, that one, whatever was remembered; with both, the remembered pick,
 * else Jira (the older integration, so a workspace that just added Plane keeps its view);
 * with none, null.
 */
export function pickTrackerSource(available: readonly TrackerKind[], stored: string | null): TrackerKind | null {
  if (stored && (available as readonly string[]).includes(stored)) return stored as TrackerKind;
  if (available.includes('jira')) return 'jira';
  return available[0] ?? null;
}
