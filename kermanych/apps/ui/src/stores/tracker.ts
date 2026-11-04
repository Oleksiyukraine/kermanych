// apps/ui/src/stores/tracker.ts
// The tracker Team Capacity and the Home capacity/tasks tiles read: Jira or Plane
// (docs/specs/2026-11-04-plane-integration.md, Decision 14). Both mirrors spell the fields the
// capacity maths reads the same way (Decision 11), so this store only chooses WHICH store's
// issues/worklogs flow into lib/capacity.ts and lib/home-digest.ts; it holds no data of its own.
//
// The choice is per workspace and remembered in this browser: with one tracker connected it is
// that one, with both the operator's last pick, else Jira. A store rather than a composable so
// the two Home tiles and the capacity screen share one pick — flipping the source on one tile
// flips the other, as both describe the same team.
//
// `open` opens BOTH trackers' sessions (they are independent singletons), so the switch is
// instant: the other mirror is already loaded and ticking.
import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import type { JiraIntegration, PlaneIntegration } from '@kermanych/cloud';
import { useJira } from './jira';
import { usePlane } from './plane';
import type { CapacityIssue, CapacityRange, CapacityWorklog } from '../lib/capacity';
import { planeIssueUrl } from '../lib/plane-view';
import { pickTrackerSource, trackerSourceKey, type TrackerKind } from '../lib/tracker-source';

// The two sessions a view opened, handed back to `close` so it tears down only its own.
export type TrackerToken = { jira: number; plane: number };

export const useTrackerSource = defineStore('tracker-source', () => {
  const jira = useJira();
  const plane = usePlane();

  const workspaceId = ref<string | null>(null);
  // The remembered pick for `workspaceId`; validated against what is connected by `kind`.
  const stored = ref<string | null>(null);

  // Both trackers have answered for this workspace. Until then the source is unknown, and the
  // views show a skeleton rather than a gate a moment before the other tracker answers.
  const probed = computed(() => jira.integration !== undefined && plane.integration !== undefined);
  const available = computed<TrackerKind[]>(() => {
    const out: TrackerKind[] = [];
    if (jira.integration) out.push('jira');
    if (plane.integration) out.push('plane');
    return out;
  });
  const kind = computed<TrackerKind | null>(() => pickTrackerSource(available.value, stored.value));
  const chosen = computed(() => (kind.value === 'plane' ? plane : kind.value === 'jira' ? jira : null));

  // The views' gate, the trackers' own tri-state: `undefined` until both are probed, `null` when
  // the workspace has neither, otherwise the chosen tracker's active board / project.
  const integration = computed<JiraIntegration | PlaneIntegration | null | undefined>(() =>
    !probed.value ? undefined : (chosen.value?.integration ?? null),
  );
  const issues = computed<readonly CapacityIssue[]>(() => chosen.value?.issues ?? []);
  // Before the source is known, either tracker still loading keeps the skeleton up.
  const loading = computed(() => (!probed.value ? jira.loading || plane.loading : (chosen.value?.loading ?? false)));
  const syncing = computed(() => chosen.value?.syncing ?? false);
  const loadError = computed(() => chosen.value?.loadError ?? null);

  function readStored(ws: string): string | null {
    try {
      return localStorage.getItem(trackerSourceKey(ws));
    } catch {
      return null;
    }
  }

  // A string, not a TrackerKind: KTabs / KChipSelect emit strings, and anything not connected
  // here is refused rather than remembered.
  function setKind(next: string): void {
    if (!(available.value as string[]).includes(next)) return;
    stored.value = next;
    if (!workspaceId.value) return;
    try {
      localStorage.setItem(trackerSourceKey(workspaceId.value), next);
    } catch {
      /* private mode: the pick is just not remembered across reloads */
    }
  }

  // The chosen tracker's worklogs for a calendar range (each store pads and filters it the
  // same way). Nothing connected → nothing logged.
  async function fetchWorklogs(range: CapacityRange): Promise<CapacityWorklog[]> {
    return chosen.value ? chosen.value.fetchWorklogs(range) : [];
  }

  async function open(ws: string): Promise<TrackerToken> {
    if (workspaceId.value !== ws) {
      workspaceId.value = ws;
      stored.value = readStored(ws);
    }
    const [j, p] = await Promise.all([jira.open(ws), plane.open(ws)]);
    return { jira: j, plane: p };
  }

  // `undefined` closes whatever is open — the trackers' own rule for a view whose open never
  // returned.
  function close(token?: TrackerToken): void {
    jira.close(token?.jira);
    plane.close(token?.plane);
  }

  // The ticket in its tracker's own web UI.
  function issueUrl(key: string): string {
    if (kind.value === 'plane' && plane.integration) return planeIssueUrl(plane.integration, key);
    const site = jira.integration?.siteUrl ?? '';
    return `${site.replace(/\/$/, '')}/browse/${key}`;
  }

  return {
    kind,
    available,
    setKind,
    integration,
    issues,
    loading,
    syncing,
    loadError,
    fetchWorklogs,
    open,
    close,
    issueUrl,
  };
});
