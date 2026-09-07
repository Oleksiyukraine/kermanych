// Team Capacity's remembered preferences, per workspace. Two consumers read the same blob:
// pages/ManagementCapacityPage.vue (which also writes it) and stores/management-chat.ts,
// which needs the active roster and the configured hours so the assistant answers from the
// team the operator actually counts — not everyone who ever touched the board.
//
// localStorage, not the cloud: the active/inactive marks are one manager's view of the board
// (a contractor muted, a QA who logs no estimates hidden), the same scope as the range and
// the granularity already kept here.
import type { CapacityGranularity, CapacityPreset } from './capacity';

export type CapacityPrefs = {
  from: string;
  to: string;
  preset: CapacityPreset | '';
  granularity: CapacityGranularity | '';
  capacityMode?: 'team' | 'member';
  teamHoursPerDay?: number;
  memberHours?: Record<string, number>;
  // Person ids marked inactive: out of the totals, the per-member hours and the assistant's
  // digest alike. Stored as the exclusion set (empty = whole team) so an older saved blob and
  // the chart legend's own toggle mean the same thing.
  excluded?: string[];
};

export function capacityStorageKey(workspaceId: string): string {
  return `capacity:${workspaceId}`;
}

export function readCapacityPrefs(workspaceId: string): CapacityPrefs | undefined {
  try {
    const raw = localStorage.getItem(capacityStorageKey(workspaceId));
    return raw ? (JSON.parse(raw) as CapacityPrefs) : undefined;
  } catch {
    return undefined;
  }
}
