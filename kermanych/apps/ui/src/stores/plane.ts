// apps/ui/src/stores/plane.ts
// The Plane mirror's client state: one workspace's connected projects (up to ten), the
// project the user is currently looking at, and that project's columns, issues, and
// per-issue children. Reads come straight from Supabase under the user's JWT (member RLS is
// the authorization surface, the tasks-store rule); every ACTION goes through the local
// api, which signs the Plane call with this user's API token and patches the mirror.
//
// Structurally the Jira store's twin (stores/jira.ts): a connected «board» is one Plane
// project, the workspace may connect several, and ONE `active` project — the switcher's
// selection, persisted per workspace — owns everything derived (columns/issues/children/
// token/realtime/tick). A workspace may have Jira, Linear AND Plane connected at once, so
// this store is entirely separate: its own rows, its own tables, its own realtime channel.
//
// Freshness has two engines and this store runs both while a Plane view is open:
//   realtime  — plane_issues is in the publication, so any machine's mirror write for the
//               active project lands here as an upsert/delete;
//   the tick  — POST /plane/sync/{integrationId} every 30 s; the api's shared lease makes N
//               open clients of the same project cost one actual poller, and the api keeps
//               each tick inside Plane's 60-requests-a-minute budget.
import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import type { PlaneColumn, PlaneIntegration, PlaneIssue, PlaneIssueChildren, PlaneWorklog } from '@kermanych/cloud';
import {
  listPlaneColumns,
  listPlaneIntegrations,
  listPlaneIssueChildren,
  listPlaneIssues,
  listPlaneWorklogsBetween,
  subscribePlaneIssues,
} from '@kermanych/cloud';
import { api, type PlaneAssignableUser, type PlaneEditorOptions } from '../lib/api';
import { useAuth } from './auth';
import { useOrchestrator } from './orchestrator';
import { IS_PREVIEW } from '../lib/preview';
import { globalTr } from '../boot/i18n';
import { shiftDays } from '../lib/calendar';
import type { CapacityRange } from '../lib/capacity';

const SYNC_TICK_MS = 30_000;

// Which project a workspace last had open, so a return to the Plane view lands on the same
// project rather than resetting to the first. Per workspace, in this browser only.
const activeKey = (workspaceId: string): string => `kermanych.plane-active.${workspaceId}`;

// The editor's live lists for one project: what the ticket dialog's selects and the issue
// editor both offer.
export type PlaneEditorLists = { options: PlaneEditorOptions; assignable: PlaneAssignableUser[] };

export const usePlane = defineStore('plane', () => {
  const auth = useAuth();
  const local = useOrchestrator();

  // Every project this workspace has connected, oldest first — the switcher's order. Empty
  // after a probe means the workspace has none.
  const integrations = ref<PlaneIntegration[]>([]);
  // The project the user is looking at, by its integration id. Null when there is none.
  const activeId = ref<string | null>(null);
  // Whether the current workspace has been probed at least once. `integration` folds this
  // into the tri-state the gates read (undefined = not asked yet).
  const probed = ref(false);
  // The workspace these projects belong to — the argument the list read and the persistence
  // key both need, and what `setActive` rebuilds a feed against.
  const workspaceId = ref<string | null>(null);

  // The active project, or null. Every project-scoped read/write resolves through this.
  const active = computed<PlaneIntegration | null>(
    () => integrations.value.find((i) => i.id === activeId.value) ?? null,
  );
  // The whole UI's «is there a Plane board here» gate: `undefined` until probed, `null` when
  // the workspace has none, otherwise the ACTIVE project.
  const integration = computed<PlaneIntegration | null | undefined>(() =>
    !probed.value ? undefined : active.value,
  );

  // All of the following belong to the ACTIVE project and are cleared/reloaded on a switch.
  const columns = ref<PlaneColumn[]>([]);
  const issues = ref<PlaneIssue[]>([]);
  const children = ref<Record<string, PlaneIssueChildren>>({});
  const tokenPresent = ref(false);
  // Who this machine's token is in Plane — the Integrations card names it.
  const tokenName = ref<string | undefined>(undefined);
  // Whether the active project's token status has been answered: the «Тільки читання» badge
  // must not flash before the probe says whether this machine can write.
  const tokenKnown = ref(false);
  // True from the start of open()/probe() through the end of loadBoard — the contract the
  // Management/Board/Home skeletons read (`integration === undefined || loading && !issues`).
  // Two halves, because the probe and the board session have different owners: closing the
  // board view (close()) ends the board half but must not hide a probe still in flight.
  const probing = ref(false);
  const boardLoading = ref(false);
  const loading = computed(() => probing.value || boardLoading.value);
  const loadError = ref<string | null>(null);
  const syncing = ref(false);

  let unsubscribe: (() => void) | undefined;
  let ticker: ReturnType<typeof setInterval> | undefined;
  // The board/feed race guard, the board store's `generation` idiom: a stale async
  // completion must not install state for a workspace or project the user already left.
  // Bumped by close/open/setActive and by a workspace change.
  let generation = 0;
  // The probe's own guard, bumped only by a newer probe: closing the board view between a
  // workspace switch and its probe's reply must not throw that reply away (the new
  // workspace would never get its Plane tab).
  let probeGen = 0;
  // The probe in flight, so an overlapping probe of the same workspace shares it instead of
  // superseding it.
  let inflight: { ws: string; done: Promise<void> } | null = null;
  // Set while a Plane view holds a session open (see open/close). `setActive` rebuilds the
  // realtime feed + tick only while one is held — switching projects on the Integrations
  // tab, which never calls open(), must not start a poller.
  let sessionOpen = false;
  // The editor lists of the active project, asked once per project and shared by every
  // ticket dialog and editor opened on it. Plane allows 60 requests a minute per key, and
  // the lists cost several of them; re-reading them for each ticket opened in a row would
  // spend the budget the sync tick needs. Dropped with the project (switch, workspace
  // change), and a failed read is not kept, so the next open asks again.
  let lists: { integrationId: string; done: Promise<PlaneEditorLists> } | null = null;

  function upsert(issue: PlaneIssue): void {
    // Ignore an upsert for a project the user is not looking at: realtime is per-channel,
    // but guarding keeps a late event from a previous project out of the current list.
    if (activeId.value && issue.integrationId !== activeId.value) return;
    issues.value = [...issues.value.filter((i) => i.issueId !== issue.issueId), issue];
  }

  function drop(issueId: string): void {
    issues.value = issues.value.filter((i) => i.issueId !== issueId);
    if (children.value[issueId]) {
      const next = { ...children.value };
      delete next[issueId];
      children.value = next;
    }
  }

  // The active project's token status. A token is keyed by the Plane address AND the Plane
  // workspace slug, and two connected projects may live in different Plane workspaces, so
  // the answer is per project: switching to one this machine has no token for drops the
  // view to read-only.
  async function refreshTokenStatus(stillCurrent: () => boolean): Promise<void> {
    const row = active.value;
    if (!row) {
      tokenPresent.value = false;
      tokenName.value = undefined;
      tokenKnown.value = true;
      return;
    }
    // The answer is about `row`: it lands only while the caller is current AND that row is
    // still the active project (a switch meanwhile asked for its own).
    const applies = () => stillCurrent() && active.value?.id === row.id;
    try {
      const status = await api.planeTokenStatus(row.siteUrl, row.workspaceSlug);
      if (!applies()) return;
      tokenPresent.value = status.present;
      tokenName.value = status.displayName;
    } catch {
      if (applies()) tokenPresent.value = false;
    }
    if (applies()) tokenKnown.value = true;
  }

  // The workspace's projects plus this machine's answer to «may I write to the active one» —
  // cheap enough for BoardPage/the Integrations tab to ask on every workspace switch just to
  // decide whether the «Plane» tab exists at all. The token status is a local sqlite read
  // through the local api, not a Plane call.
  function probe(ws: string): Promise<void> {
    // Same workspace already being asked: share that answer.
    if (inflight && inflight.ws === ws) return inflight.done;
    // A different workspace's projects must not stay on screen while this one's are asked:
    // reset synchronously, so `integration === undefined` reads «not loaded for this
    // workspace». A re-probe of the same workspace keeps what is shown.
    if (workspaceId.value !== ws) {
      generation++; // an in-flight board load belongs to the workspace being left
      integrations.value = [];
      activeId.value = null;
      probed.value = false;
      columns.value = [];
      issues.value = [];
      children.value = {};
      loadError.value = null;
      tokenPresent.value = false;
      tokenName.value = undefined;
      tokenKnown.value = false;
      lists = null;
    }
    workspaceId.value = ws;
    const mine = ++probeGen;
    probing.value = true;
    const entry = { ws, done: runProbe(ws, mine) };
    inflight = entry;
    void entry.done.finally(() => {
      if (inflight === entry) inflight = null;
    });
    return entry.done;
  }

  async function runProbe(ws: string, mine: number): Promise<void> {
    const current = () => mine === probeGen;
    try {
      if (IS_PREVIEW || !auth.user) {
        integrations.value = [];
        activeId.value = null;
        probed.value = true;
        tokenPresent.value = false;
        tokenKnown.value = true;
        return;
      }
      try {
        const rows = await listPlaneIntegrations(auth.client, ws);
        if (!current()) return;
        integrations.value = rows;
        probed.value = true;
        const stored = readActive(ws);
        activeId.value = rows.find((r) => r.id === stored)?.id ?? rows[0]?.id ?? null;
      } catch {
        // An unreachable cloud answers «нема табу», not an error banner: the native board
        // already owns the offline story.
        if (!current()) return;
        integrations.value = [];
        activeId.value = null;
        probed.value = true;
      }
      await refreshTokenStatus(current);
    } finally {
      if (current()) probing.value = false;
    }
  }

  function readActive(ws: string): string | null {
    try {
      return localStorage.getItem(activeKey(ws));
    } catch {
      return null;
    }
  }

  // Switch the project the view shows. Clears the previous project's state, refreshes the
  // token for the new project's site + workspace, and — only while a session is open —
  // rebuilds the realtime feed and the sync tick against the new project.
  async function setActive(id: string): Promise<void> {
    if (id === activeId.value || !integrations.value.some((i) => i.id === id)) return;
    activeId.value = id;
    if (workspaceId.value) {
      try {
        localStorage.setItem(activeKey(workspaceId.value), id);
      } catch {
        /* private mode: the selection is just not remembered across reloads */
      }
    }
    // The previous project's cards, columns, children and lists do not belong to this one.
    generation++;
    const mine = generation;
    columns.value = [];
    issues.value = [];
    children.value = {};
    loadError.value = null;
    tokenKnown.value = false;
    lists = null;
    // The view shows a skeleton, not «порожня дошка», until the new project's load answers.
    if (sessionOpen) boardLoading.value = true;
    await refreshTokenStatus(() => mine === generation);
    if (sessionOpen) {
      teardownFeed();
      await startFeed();
    }
  }

  async function loadBoard(): Promise<void> {
    const row = active.value;
    if (!row) return;
    const mine = generation;
    boardLoading.value = true;
    loadError.value = null;
    try {
      const [cols, iss] = await Promise.all([
        listPlaneColumns(auth.client, row.id),
        listPlaneIssues(auth.client, row.id),
      ]);
      if (mine !== generation) return;
      columns.value = cols;
      issues.value = iss;
    } catch (e) {
      if (mine === generation) loadError.value = e instanceof Error ? e.message : String(e);
    } finally {
      if (mine === generation) boardLoading.value = false;
    }
  }

  // Worklogs of the active project for a calendar range — the capacity read, Jira's twin.
  // Returned, not stored, for Jira's reason (two readers ask different ranges at once). A day
  // of slack on both ends because `started_at` is an instant (Plane's `created_at`) and the
  // range is the operator's wall calendar; lib/capacity.ts buckets by local day.
  async function fetchWorklogs(range: CapacityRange): Promise<PlaneWorklog[]> {
    const row = active.value;
    if (!row) return [];
    return listPlaneWorklogsBetween(
      auth.client,
      row.id,
      `${shiftDays(range.from, -1)}T00:00:00.000Z`,
      `${shiftDays(range.to, 2)}T00:00:00.000Z`,
    );
  }

  // The active project's editor options and assignable members, read once per project (see
  // `lists`). Rejects like the api does, so the caller decides how a failure degrades.
  function editorLists(): Promise<PlaneEditorLists> {
    const row = active.value;
    if (!row) return Promise.reject(new Error('no Plane project'));
    if (lists && lists.integrationId === row.id) return lists.done;
    const entry = {
      integrationId: row.id,
      done: Promise.all([api.planeEditorOptions(row.id), api.planeAssignableUsers(row.id, '')]).then(
        ([options, assignable]) => ({ options, assignable }),
      ),
    };
    lists = entry;
    entry.done.catch(() => {
      if (lists === entry) lists = null;
    });
    return entry.done;
  }

  // Which caller currently owns the session; close() is a no-op for any token but the
  // latest, so a view that is leaving cannot tear down the session the arriving view built.
  let opener = 0;

  function teardownFeed(): void {
    unsubscribe?.();
    unsubscribe = undefined;
    clearInterval(ticker);
    ticker = undefined;
  }

  // The realtime channel + sync ticker for the active project. Split from open() so
  // setActive can rebuild it against a newly-chosen project without re-probing.
  async function startFeed(): Promise<void> {
    const row = active.value;
    if (!row) return;
    await loadBoard();
    unsubscribe = subscribePlaneIssues(auth.client, row.id, (change) => {
      if (change.kind === 'delete') drop(change.issueId);
      else upsert(change.issue);
    });

    const tick = async () => {
      if (!tokenPresent.value) return; // read-only member: someone else's tick feeds them
      if (syncing.value) return; // a manual sync or a slow previous tick still owns the poll
      syncing.value = true;
      try {
        // `rateLimited` is Plane's budget running out mid-tick: the api already stopped
        // quietly and the next tick carries on, so there is nothing to say here.
        await api.planeSync(row.id);
      } catch (e) {
        // A dead token must stop the loop's noise, not toast every 30 s. The Integrations tab
        // is where the state is explained.
        if (e instanceof Error && /token/.test(e.message)) tokenPresent.value = false;
      } finally {
        syncing.value = false;
      }
    };
    void tick();
    ticker = setInterval(() => void tick(), SYNC_TICK_MS);
  }

  // The Plane view's lifecycle: probe + board + realtime + the sync ticker for the active
  // project. Idempotent — reopening rebuilds one channel and one ticker, never two. Returns
  // a token the caller hands back to close().
  async function open(ws: string): Promise<number> {
    const token = ++opener;
    close();
    sessionOpen = true;
    // Up before the probe ends, so `loading` does not dip between the probe and loadBoard.
    boardLoading.value = true;
    const asked = probe(ws);
    // Taken after probe()'s synchronous workspace reset: only a later close/open/project
    // switch makes this session stale — an overlapping probe does not.
    const mine = generation;
    await asked;
    if (mine !== generation) return token; // a newer open/close owns the session
    if (!active.value) {
      boardLoading.value = false;
      return token;
    }
    await startFeed();
    return token;
  }

  // The «Синхронізувати» button. A deliberate human act, so it differs from the tick in three
  // ways: it passes `full`, which makes the api bypass the shared lease and run a full sweep
  // (deletion reconciliation + the state columns) instead of an incremental poll; it reloads
  // the mirror afterwards, because plane_columns has no realtime channel; and it reports,
  // since a click with no visible answer reads as a dead button. A sweep cut short by Plane's
  // rate limit is reported as that, not as a failure: what it did write is in the mirror, and
  // the tick finishes the rest.
  async function syncNow(): Promise<void> {
    const row = active.value;
    if (!row) return;
    if (syncing.value) return; // the tick is mid-poll — its spinner is already the answer
    if (!tokenPresent.value) return; // nothing to sign the Plane call with
    const mine = generation;
    syncing.value = true;
    try {
      const res = await api.planeSync(row.id, true);
      if (mine !== generation) return; // left the project meanwhile
      await loadBoard();
      local.notify(globalTr.t(res?.rateLimited ? 'plane.notify.rateLimited' : 'plane.notify.synced'), 'info');
    } catch (e) {
      if (mine !== generation) return;
      const msg = e instanceof Error ? e.message : String(e);
      // Unlike the tick, this one talks: the user asked.
      if (/token/.test(msg)) tokenPresent.value = false;
      local.notify(globalTr.t('plane.notify.syncFailed', { error: msg }), 'error');
    } finally {
      syncing.value = false;
    }
  }

  function close(token?: number): void {
    if (token !== undefined && token !== opener) return;
    generation++;
    // The bump discards an in-flight board load, so nothing else would lower its half; a
    // probe in flight keeps `loading` up through its own half.
    boardLoading.value = false;
    sessionOpen = false;
    teardownFeed();
  }

  // Children are refetch-on-open (no realtime on the child tables). The cache keeps a
  // reopened dialog instant; `refreshIssue` below replaces it with live truth.
  async function loadChildren(issueId: string): Promise<PlaneIssueChildren | undefined> {
    const row = active.value;
    if (!row) return undefined;
    try {
      const kids = await listPlaneIssueChildren(auth.client, row.id, issueId);
      children.value = { ...children.value, [issueId]: kids };
      return kids;
    } catch (e) {
      local.notify(e instanceof Error ? e.message : String(e), 'error');
      return undefined;
    }
  }

  // Live refresh through the api (Plane → mirror → this store): the dialog calls it on open,
  // and it is the ONE item whose children are refreshed at once — the sync drains the rest a
  // few per tick to stay inside Plane's rate limit. Signs against the active project.
  async function refreshIssue(key: string): Promise<void> {
    const row = active.value;
    if (!row || !tokenPresent.value) return; // no token = mirror is all this member gets
    try {
      const issue = await api.planeRefreshIssue(row.id, key);
      upsert(issue);
      await loadChildren(issue.issueId);
    } catch {
      // The mirror copy still renders; freshness is best-effort.
    }
  }

  return {
    integrations,
    integration,
    active,
    activeId,
    setActive,
    columns,
    issues,
    children,
    tokenPresent,
    tokenName,
    tokenKnown,
    loading,
    loadError,
    syncing,
    probe,
    loadBoard,
    fetchWorklogs,
    editorLists,
    open,
    syncNow,
    close,
    upsert,
    drop,
    loadChildren,
    refreshIssue,
  };
});
