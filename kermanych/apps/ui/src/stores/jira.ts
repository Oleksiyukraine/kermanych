// apps/ui/src/stores/jira.ts
// The Jira mirror's client state: one workspace's connected boards (up to ten), the board
// the user is currently looking at, and that board's columns, issues, and per-issue
// children. Reads come straight from Supabase under the user's JWT (member RLS is the
// authorization surface, the tasks-store rule); every ACTION goes through the local api,
// which signs the Jira call with this user's token and patches the mirror.
//
// A workspace may connect several boards; the store keeps them all in `integrations` and
// tracks ONE `active` board — the switcher's selection, persisted per workspace. Everything
// derived (columns/issues/children/assignable/token/realtime/tick) belongs to the active
// board and is rebuilt when the selection changes, so a second board behaves exactly like
// the first did when it was the only one.
//
// Freshness has two engines and this store runs both while a Jira view is open:
//   realtime  — jira_issues is in the publication, so any machine's mirror write for the
//               active board lands here as an upsert/delete;
//   the tick  — POST /jira/sync/{integrationId} every 30 s; the api's shared lease makes N
//               open clients of the same board cost one actual poller.
import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import type { JiraColumn, JiraIntegration, JiraIssue, JiraIssueChildren, JiraWorklog } from '@kermanych/cloud';
import {
  getJiraIntegrationById,
  listJiraColumns,
  listJiraIntegrations,
  listJiraIssueChildren,
  listJiraIssues,
  listJiraWorklogsBetween,
  subscribeJiraIssues,
} from '@kermanych/cloud';
import { api, type JiraAssignableUser } from '../lib/api';
import { useAuth } from './auth';
import { useOrchestrator } from './orchestrator';
import { IS_PREVIEW } from '../lib/preview';
import { globalTr } from '../boot/i18n';
import { shiftDays } from '../lib/calendar';
import type { CapacityRange } from '../lib/capacity';

const SYNC_TICK_MS = 30_000;

// Which board a workspace last had open, so a return to the Jira view lands on the same
// board rather than resetting to the first. Per workspace, in this browser only.
const activeKey = (workspaceId: string): string => `kermanych.jira-active.${workspaceId}`;

export const useJira = defineStore('jira', () => {
  const auth = useAuth();
  const local = useOrchestrator();

  // Every board this workspace has connected, oldest first — the switcher's order. Empty
  // after a probe means the workspace has none.
  const integrations = ref<JiraIntegration[]>([]);
  // The board the user is looking at, by its integration id. Null when there is none.
  const activeId = ref<string | null>(null);
  // Whether the current workspace has been probed at least once. `integration` folds this
  // into the tri-state the gates read (undefined = not asked yet).
  const probed = ref(false);
  // The workspace these boards belong to — the argument the list read and the persistence
  // key both need, and what `setActive` rebuilds a feed against.
  const workspaceId = ref<string | null>(null);

  // The active board, or null. Every board-scoped read/write resolves through this.
  const active = computed<JiraIntegration | null>(
    () => integrations.value.find((i) => i.id === activeId.value) ?? null,
  );
  // Back-compat tri-state, the whole UI's «is there a Jira board here» gate: `undefined`
  // until probed, `null` when the workspace has none, otherwise the ACTIVE board. Readers
  // that used to hold the single integration now hold whichever board is selected.
  const integration = computed<JiraIntegration | null | undefined>(() =>
    !probed.value ? undefined : active.value,
  );

  // All of the following belong to the ACTIVE board and are cleared/reloaded on a switch.
  const columns = ref<JiraColumn[]>([]);
  const issues = ref<JiraIssue[]>([]);
  const children = ref<Record<string, JiraIssueChildren>>({});
  const tokenPresent = ref(false);
  const tokenEmail = ref<string | undefined>(undefined);
  // Jira's own assignable users for the active board's project — the assignee picker's list,
  // and the ONLY set an issue on that board may be assigned from.
  const assignable = ref<JiraAssignableUser[]>([]);
  const loading = ref(false);
  const loadError = ref<string | null>(null);
  const syncing = ref(false);

  let unsubscribe: (() => void) | undefined;
  let ticker: ReturnType<typeof setInterval> | undefined;
  // The load()/open() race guard, the board store's `generation` idiom: a stale async
  // completion must not install state for a workspace or board the user already left.
  let generation = 0;
  // Set while a Jira view holds a session open (see open/close). `setActive` rebuilds the
  // realtime feed + tick only while one is held — switching boards on the Integrations tab,
  // which never calls open(), must not start a poller.
  let sessionOpen = false;

  function upsert(issue: JiraIssue): void {
    // Ignore an upsert for a board the user is not looking at: realtime is per-channel, but
    // guarding keeps a late event from a previous board out of the current list.
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

  // The active board's token status. A board may live on a different Jira site than its
  // siblings, so the answer is per board: switching to a board on a site this machine has
  // no token for drops the view to read-only, exactly as an unconnected token would.
  async function refreshTokenStatus(): Promise<void> {
    const row = active.value;
    if (!row) {
      tokenPresent.value = false;
      tokenEmail.value = undefined;
      return;
    }
    const mine = generation;
    try {
      const status = await api.jiraTokenStatus(row.siteUrl);
      if (mine !== generation) return;
      tokenPresent.value = status.present;
      tokenEmail.value = status.email;
    } catch {
      if (mine === generation) tokenPresent.value = false;
    }
  }

  // The workspace's boards plus this machine's answer to «may I write to the active one» —
  // cheap enough for MainLayout/BoardPage to ask on every workspace switch just to decide
  // whether the «Jira» tab exists at all. The active board is the persisted selection when
  // it is still connected, otherwise the first board.
  //
  // The token status travels WITH the boards, and not only inside `loadBoard`, because it is
  // a property of the same question: the Менеджмент chat has to tell the model whether a Jira
  // ticket can be created before anybody has opened the Jira board, and «there is a board»
  // without «I can write to it» would have it promise a ticket the api cannot sign. It costs
  // a local sqlite read through the local api, not a Jira call.
  async function probe(ws: string): Promise<void> {
    workspaceId.value = ws;
    if (IS_PREVIEW || !auth.user) {
      integrations.value = [];
      activeId.value = null;
      probed.value = true;
      tokenPresent.value = false;
      return;
    }
    const mine = ++generation;
    // The cached assignee list belongs to the board this probe is about to replace, so it is
    // dropped here: a Jira roster held over from the previous workspace would be printed into
    // the next workspace's prompt as its own.
    assignable.value = [];
    try {
      const rows = await listJiraIntegrations(auth.client, ws);
      if (mine !== generation) return;
      integrations.value = rows;
      probed.value = true;
      const stored = readActive(ws);
      activeId.value = rows.find((r) => r.id === stored)?.id ?? rows[0]?.id ?? null;
    } catch {
      // An unreachable cloud answers «нема табу», not an error banner: the native board
      // already owns the offline story.
      if (mine === generation) {
        integrations.value = [];
        activeId.value = null;
        probed.value = true;
      }
    }
    if (!active.value) {
      if (mine === generation) tokenPresent.value = false;
      return;
    }
    await refreshTokenStatus();
  }

  function readActive(ws: string): string | null {
    try {
      return localStorage.getItem(activeKey(ws));
    } catch {
      return null;
    }
  }

  // Switch the board the view shows. Clears the previous board's state, refreshes the token
  // for the new board's site, and — only while a session is open — rebuilds the realtime feed
  // and the sync tick against the new board.
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
    // The previous board's cards, columns, children and roster do not belong to this one.
    generation++;
    columns.value = [];
    issues.value = [];
    children.value = {};
    assignable.value = [];
    loadError.value = null;
    await refreshTokenStatus();
    if (sessionOpen) {
      teardownFeed();
      await startFeed();
    }
  }

  // Jira's assignable users for the active board's project, cached after the first answer. A
  // Jira call, so it is NOT part of `probe`: the board tab only needs to know whether Jira
  // exists, while the people who may be assigned matter only to something about to assign one.
  //
  // Never throws. An unreadable list costs the caller the ability to name an assignee, not its
  // whole turn — and it degrades to the empty list, which every reader states as «not
  // available» rather than as «nobody is assignable». Empty is therefore not cached either: a
  // turn that failed on a dropped connection retries on the next one, which is the whole
  // difference between a transient failure and a board with nobody on it.
  async function loadAssignable(): Promise<JiraAssignableUser[]> {
    const row = active.value;
    if (!row || !tokenPresent.value) return [];
    if (assignable.value.length) return assignable.value;
    const mine = generation;
    try {
      const users = await api.jiraAssignableUsers(row.id, '');
      if (mine !== generation) return [];
      assignable.value = users;
      return users;
    } catch {
      return [];
    }
  }

  async function loadBoard(): Promise<void> {
    const row = active.value;
    if (!row) return;
    const mine = generation;
    loading.value = true;
    loadError.value = null;
    try {
      const [cols, iss] = await Promise.all([
        listJiraColumns(auth.client, row.id),
        listJiraIssues(auth.client, row.id),
      ]);
      if (mine !== generation) return;
      columns.value = cols;
      issues.value = iss;
    } catch (e) {
      if (mine === generation) loadError.value = e instanceof Error ? e.message : String(e);
    } finally {
      if (mine === generation) loading.value = false;
    }
  }

  // Worklogs of the active board for a calendar range — Team Capacity's read. Returned, not
  // stored: the screen and the Менеджмент chat ask for different ranges at the same time, and
  // one `worklogs` ref would have them overwrite each other. A day of slack on both ends
  // because `started_at` is an instant and the range is the operator's wall calendar;
  // lib/capacity.ts buckets by local day and drops what falls outside.
  async function fetchWorklogs(range: CapacityRange): Promise<JiraWorklog[]> {
    const row = active.value;
    if (!row) return [];
    return listJiraWorklogsBetween(
      auth.client,
      row.id,
      `${shiftDays(range.from, -1)}T00:00:00.000Z`,
      `${shiftDays(range.to, 2)}T00:00:00.000Z`,
    );
  }

  // Which caller currently owns the session. The board and Team Capacity both open/close this
  // singleton; a view that is leaving must not tear down the session the arriving view just
  // built, so close() is a no-op for any token but the latest.
  let opener = 0;

  function teardownFeed(): void {
    unsubscribe?.();
    unsubscribe = undefined;
    clearInterval(ticker);
    ticker = undefined;
  }

  // The realtime channel + sync ticker for the active board. Split from open() so setActive
  // can rebuild it against a newly-chosen board without re-probing.
  async function startFeed(): Promise<void> {
    const row = active.value;
    if (!row) return;
    await loadBoard();
    unsubscribe = subscribeJiraIssues(auth.client, row.id, (change) => {
      if (change.kind === 'delete') drop(change.issueId);
      else upsert(change.issue);
    });

    const tick = async () => {
      if (!tokenPresent.value) return; // read-only member: someone else's tick feeds them
      if (syncing.value) return; // a manual sync or a slow previous tick still owns the poll
      syncing.value = true;
      try {
        await api.jiraSync(row.id);
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

  // The Jira view's lifecycle: probe + board + realtime + the sync ticker for the active
  // board. Idempotent — reopening rebuilds one channel and one ticker, never two. Returns a
  // token the caller hands back to close(), so a stale unmount cannot tear down a session it
  // no longer owns.
  async function open(ws: string): Promise<number> {
    const token = ++opener;
    close();
    sessionOpen = true;
    await probe(ws);
    if (!active.value) return token;
    await startFeed();
    return token;
  }

  // The «Синхронізувати» button. A deliberate human act, so it differs from the tick in three
  // ways: it passes `full`, which makes the api bypass the shared lease and run a full sweep
  // (deletion reconciliation + column layout) instead of an incremental poll; it reloads the
  // mirror afterwards, because jira_columns has no realtime channel and a relayout would
  // otherwise stay invisible until the next open(); and it reports, since a click with no
  // visible answer reads as a dead button.
  async function syncNow(): Promise<void> {
    const row = active.value;
    if (!row) return;
    if (syncing.value) return; // the tick is mid-poll — its spinner is already the answer
    if (!tokenPresent.value) return; // nothing to sign the Jira call with
    const mine = generation;
    syncing.value = true;
    try {
      await api.jiraSync(row.id, true);
      if (mine !== generation) return; // left the board meanwhile
      await loadBoard();
      local.notify(globalTr.t('jira.notify.synced'), 'info');
    } catch (e) {
      if (mine !== generation) return;
      const msg = e instanceof Error ? e.message : String(e);
      // Unlike the tick, this one talks: the user asked.
      if (/token/.test(msg)) tokenPresent.value = false;
      local.notify(globalTr.t('jira.notify.syncFailed', { error: msg }), 'error');
    } finally {
      syncing.value = false;
    }
  }

  function close(token?: number): void {
    if (token !== undefined && token !== opener) return;
    generation++;
    sessionOpen = false;
    teardownFeed();
  }

  // Children are refetch-on-open (no realtime on the child tables). The cache keeps a reopened
  // dialog instant; `refreshIssue` below replaces it with live truth.
  async function loadChildren(issueId: string): Promise<JiraIssueChildren | undefined> {
    const row = active.value;
    if (!row) return undefined;
    try {
      const kids = await listJiraIssueChildren(auth.client, row.id, issueId);
      children.value = { ...children.value, [issueId]: kids };
      return kids;
    } catch (e) {
      local.notify(e instanceof Error ? e.message : String(e), 'error');
      return undefined;
    }
  }

  // Live refresh through the api (Jira → mirror → this store): the dialog calls it on open so
  // comments are fresher than the 30 s tick. Signs against the active board.
  async function refreshIssue(key: string): Promise<void> {
    const row = active.value;
    if (!row || !tokenPresent.value) return; // no token = mirror is all this member gets
    try {
      const issue = await api.jiraRefreshIssue(row.id, key);
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
    tokenEmail,
    assignable,
    loading,
    loadError,
    syncing,
    probe,
    loadAssignable,
    loadBoard,
    fetchWorklogs,
    open,
    syncNow,
    close,
    upsert,
    drop,
    loadChildren,
    refreshIssue,
  };
});
