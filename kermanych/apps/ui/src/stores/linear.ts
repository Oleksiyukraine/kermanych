// apps/ui/src/stores/linear.ts
// The Linear mirror's client state: one workspace's integration row, columns, issues, and
// per-issue children. Reads come straight from Supabase under the user's JWT (member
// RLS is the authorization surface, the tasks-store rule); every ACTION goes through the
// local api, which signs the Linear call with this user's API key and patches the mirror.
//
// Structurally the Jira store's twin (stores/jira.ts) with Linear's own shape — a team
// board, workflow states as columns, markdown bodies, and no worklogs. A workspace may
// have Jira AND Linear connected at once, so this store is entirely separate: its own row,
// its own tables, its own realtime channel.
//
// Freshness has two engines and this store runs both while a Linear view is open:
//   realtime  — linear_issues is in the publication, so any machine's mirror write lands
//               here as an upsert/delete;
//   the tick  — POST /linear/sync every 30 s; the api's shared lease makes N open boards
//               cost one actual poller.
import { defineStore } from 'pinia';
import { ref } from 'vue';
import type { LinearColumn, LinearIntegration, LinearIssue, LinearIssueChildren } from '@kermanych/cloud';
import {
  getLinearIntegration,
  listLinearColumns,
  listLinearIssueChildren,
  listLinearIssues,
  subscribeLinearIssues,
} from '@kermanych/cloud';
import { api, type LinearAssignableUser } from '../lib/api';
import { useAuth } from './auth';
import { useOrchestrator } from './orchestrator';
import { IS_PREVIEW } from '../lib/preview';
import { globalTr } from '../boot/i18n';

const SYNC_TICK_MS = 30_000;

export const useLinear = defineStore('linear', () => {
  const auth = useAuth();
  const local = useOrchestrator();

  // `undefined` = not asked yet, `null` = asked and the workspace has none. The board
  // switcher renders only on a real row, so the three states must stay distinct.
  const integration = ref<LinearIntegration | null | undefined>(undefined);
  const columns = ref<LinearColumn[]>([]);
  const issues = ref<LinearIssue[]>([]);
  const children = ref<Record<string, LinearIssueChildren>>({});
  const tokenPresent = ref(false);
  // Linear's own assignable users for this team — the assignee picker's list, and the ONLY
  // set a Linear issue may be assigned from. Kept here rather than in the Менеджмент chat for
  // `probe`'s reason: it is a fact about the board, the chat is only one of its readers, and
  // the names the assistant is shown must be the names the ticket dialog shows.
  const assignable = ref<LinearAssignableUser[]>([]);
  const loading = ref(false);
  const loadError = ref<string | null>(null);
  const syncing = ref(false);

  let unsubscribe: (() => void) | undefined;
  let ticker: ReturnType<typeof setInterval> | undefined;
  // The load()/open() race guard, the board store's `generation` idiom: a stale async
  // completion must not install state for a workspace the user already left.
  let generation = 0;

  function upsert(issue: LinearIssue): void {
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

  // The integration row plus this machine's answer to «may I write to it» — cheap enough for
  // MainLayout/BoardPage to ask on every workspace switch just to decide whether the «Linear»
  // tab exists at all.
  //
  // The token status travels WITH the row, and not only inside `loadBoard`, because it is a
  // property of the same question: «there is a board» without «I can write to it» would have
  // the assistant promise a ticket the api cannot sign. It costs a local sqlite read through
  // the local api, not a Linear call.
  async function probe(workspaceId: string): Promise<void> {
    if (IS_PREVIEW || !auth.user) {
      integration.value = null;
      tokenPresent.value = false;
      return;
    }
    const mine = ++generation;
    // The cached assignee list belongs to the team this probe is about to replace, so it
    // is dropped here: a Linear roster held over from the previous workspace would be printed
    // into the next workspace's prompt as its own.
    assignable.value = [];
    try {
      const row = await getLinearIntegration(auth.client, workspaceId);
      if (mine !== generation) return;
      integration.value = row ?? null;
    } catch {
      // An unreachable cloud answers «нема табу», not an error banner: the native board
      // already owns the offline story.
      if (mine === generation) integration.value = null;
    }
    const row = integration.value;
    if (!row) {
      if (mine === generation) tokenPresent.value = false;
      return;
    }
    try {
      const status = await api.linearTokenStatus(row.orgUrlKey);
      if (mine !== generation) return;
      tokenPresent.value = status.present;
    } catch {
      if (mine === generation) tokenPresent.value = false;
    }
  }

  // Linear's assignable users for this team, cached after the first answer. A Linear call, so
  // it is NOT part of `probe`: the board tab only needs to know whether Linear exists, while
  // the people who may be assigned matter only to something about to assign one.
  //
  // Never throws. An unreadable list costs the caller the ability to name an assignee, not
  // its whole turn — and it degrades to the empty list. Empty is therefore not cached either:
  // a turn that failed on a dropped connection retries on the next one, which is the whole
  // difference between a transient failure and a board with nobody on it.
  async function loadAssignable(workspaceId: string): Promise<LinearAssignableUser[]> {
    if (!integration.value || !tokenPresent.value) return [];
    if (assignable.value.length) return assignable.value;
    const mine = generation;
    try {
      const users = await api.linearAssignableUsers(workspaceId, '');
      if (mine !== generation) return [];
      assignable.value = users;
      return users;
    } catch {
      return [];
    }
  }

  async function loadBoard(): Promise<void> {
    const row = integration.value;
    if (!row) return;
    const mine = generation;
    loading.value = true;
    loadError.value = null;
    try {
      const [cols, iss] = await Promise.all([
        listLinearColumns(auth.client, row.id),
        listLinearIssues(auth.client, row.id),
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

  // Which caller currently owns the session. The board opens/closes this singleton; a view
  // that is leaving must not tear down the session the arriving view just built, so close()
  // is a no-op for any token but the latest.
  let opener = 0;

  // The Linear view's lifecycle: probe + board + realtime + the sync ticker. Idempotent —
  // reopening rebuilds one channel and one ticker, never two. Returns a token the caller
  // hands back to close(), so a stale unmount cannot tear down a session it no longer owns.
  async function open(workspaceId: string): Promise<number> {
    const token = ++opener;
    close();
    await probe(workspaceId);
    const row = integration.value;
    if (!row) return token;
    await loadBoard();

    unsubscribe = subscribeLinearIssues(auth.client, row.id, (change) => {
      if (change.kind === 'delete') drop(change.issueId);
      else upsert(change.issue);
    });

    const tick = async () => {
      if (!tokenPresent.value) return; // read-only member: someone else's tick feeds them
      if (syncing.value) return; // a manual sync or a slow previous tick still owns the poll
      syncing.value = true;
      try {
        await api.linearSync(workspaceId);
      } catch (e) {
        // A dead token must stop the loop's noise, not toast every 30 s. The Integrations
        // tab is where the state is explained.
        if (e instanceof Error && /token/.test(e.message)) tokenPresent.value = false;
      } finally {
        syncing.value = false;
      }
    };
    void tick();
    ticker = setInterval(() => void tick(), SYNC_TICK_MS);
    return token;
  }

  // The «Синхронізувати» button. A deliberate human act, so it differs from the tick in
  // three ways: it passes `full`, which makes the api bypass the shared lease and run a
  // full sweep (deletion reconciliation + column layout) instead of an incremental poll;
  // it reloads the mirror afterwards, because linear_columns has no realtime channel and a
  // relayout would otherwise stay invisible until the next open(); and it reports, since
  // a click with no visible answer reads as a dead button.
  async function syncNow(workspaceId: string): Promise<void> {
    if (syncing.value) return; // the tick is mid-poll — its spinner is already the answer
    if (!tokenPresent.value) return; // nothing to sign the Linear call with
    const mine = generation;
    syncing.value = true;
    try {
      await api.linearSync(workspaceId, true);
      if (mine !== generation) return; // left the board meanwhile
      await loadBoard();
      local.notify(globalTr.t('linear.notify.synced'), 'info');
    } catch (e) {
      if (mine !== generation) return;
      const msg = e instanceof Error ? e.message : String(e);
      // Unlike the tick, this one talks: the user asked.
      if (/token/.test(msg)) tokenPresent.value = false;
      local.notify(globalTr.t('linear.notify.syncFailed', { error: msg }), 'error');
    } finally {
      syncing.value = false;
    }
  }

  function close(token?: number): void {
    if (token !== undefined && token !== opener) return;
    generation++;
    unsubscribe?.();
    unsubscribe = undefined;
    clearInterval(ticker);
    ticker = undefined;
  }

  // Children are refetch-on-open (no realtime on the child tables). The cache keeps a
  // reopened dialog instant; `refreshIssue` below replaces it with live truth.
  async function loadChildren(issueId: string): Promise<LinearIssueChildren | undefined> {
    const row = integration.value;
    if (!row) return undefined;
    try {
      const kids = await listLinearIssueChildren(auth.client, row.id, issueId);
      children.value = { ...children.value, [issueId]: kids };
      return kids;
    } catch (e) {
      local.notify(e instanceof Error ? e.message : String(e), 'error');
      return undefined;
    }
  }

  // Live refresh through the api (Linear → mirror → this store): the dialog calls it on
  // open so comments are fresher than the 30 s tick.
  async function refreshIssue(workspaceId: string, key: string): Promise<void> {
    if (!tokenPresent.value) return; // no token = mirror is all this member gets
    try {
      const issue = await api.linearRefreshIssue(workspaceId, key);
      upsert(issue);
      await loadChildren(issue.issueId);
    } catch {
      // The mirror copy still renders; freshness is best-effort.
    }
  }

  return {
    integration,
    columns,
    issues,
    children,
    tokenPresent,
    assignable,
    loading,
    loadError,
    syncing,
    probe,
    loadAssignable,
    loadBoard,
    open,
    syncNow,
    close,
    upsert,
    drop,
    loadChildren,
    refreshIssue,
  };
});
