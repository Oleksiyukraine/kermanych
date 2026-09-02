// apps/ui/src/stores/jira.ts
// The Jira mirror's client state: one workspace's integration row, columns, issues, and
// per-issue children. Reads come straight from Supabase under the user's JWT (member
// RLS is the authorization surface, the tasks-store rule); every ACTION goes through the
// local api, which signs the Jira call with this user's token and patches the mirror.
//
// Freshness has two engines and this store runs both while a Jira view is open:
//   realtime  — jira_issues is in the publication, so any machine's mirror write lands
//               here as an upsert/delete;
//   the tick  — POST /jira/sync every 30 s; the api's shared lease makes N open boards
//               cost one actual poller.
import { defineStore } from 'pinia';
import { ref } from 'vue';
import type { JiraColumn, JiraIntegration, JiraIssue, JiraIssueChildren } from '@kermanych/cloud';
import {
  getJiraIntegration,
  listJiraColumns,
  listJiraIssueChildren,
  listJiraIssues,
  subscribeJiraIssues,
} from '@kermanych/cloud';
import { api } from '../lib/api';
import { useAuth } from './auth';
import { useOrchestrator } from './orchestrator';
import { IS_PREVIEW } from '../lib/preview';

const SYNC_TICK_MS = 30_000;

export const useJira = defineStore('jira', () => {
  const auth = useAuth();
  const local = useOrchestrator();

  // `undefined` = not asked yet, `null` = asked and the workspace has none. The board
  // switcher renders only on a real row, so the three states must stay distinct.
  const integration = ref<JiraIntegration | null | undefined>(undefined);
  const columns = ref<JiraColumn[]>([]);
  const issues = ref<JiraIssue[]>([]);
  const children = ref<Record<string, JiraIssueChildren>>({});
  const tokenPresent = ref(false);
  const tokenEmail = ref<string | undefined>(undefined);
  const loading = ref(false);
  const loadError = ref<string | null>(null);
  const syncing = ref(false);

  let unsubscribe: (() => void) | undefined;
  let ticker: ReturnType<typeof setInterval> | undefined;
  // The load()/open() race guard, the board store's `generation` idiom: a stale async
  // completion must not install state for a workspace the user already left.
  let generation = 0;

  function upsert(issue: JiraIssue): void {
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
  // MainLayout/BoardPage to ask on every workspace switch just to decide whether the «Jira»
  // tab exists at all.
  //
  // The token status travels WITH the row, and not only inside `loadBoard`, because it is a
  // property of the same question: the Менеджмент chat has to tell the model whether a Jira
  // ticket can be created before anybody has opened the Jira board, and «there is a board»
  // without «I can write to it» would have it promise a ticket the api cannot sign. It costs
  // a local sqlite read through the local api, not a Jira call.
  async function probe(workspaceId: string): Promise<void> {
    if (IS_PREVIEW || !auth.user) {
      integration.value = null;
      tokenPresent.value = false;
      return;
    }
    const mine = ++generation;
    try {
      const row = await getJiraIntegration(auth.client, workspaceId);
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
      const status = await api.jiraTokenStatus(row.siteUrl);
      if (mine !== generation) return;
      tokenPresent.value = status.present;
      tokenEmail.value = status.email;
    } catch {
      if (mine === generation) tokenPresent.value = false;
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

  // The Jira view's lifecycle: probe + board + realtime + the sync ticker. Idempotent —
  // reopening rebuilds one channel and one ticker, never two.
  async function open(workspaceId: string): Promise<void> {
    close();
    await probe(workspaceId);
    const row = integration.value;
    if (!row) return;
    await loadBoard();

    unsubscribe = subscribeJiraIssues(auth.client, row.id, (change) => {
      if (change.kind === 'delete') drop(change.issueId);
      else upsert(change.issue);
    });

    const tick = async () => {
      if (!tokenPresent.value) return; // read-only member: someone else's tick feeds them
      syncing.value = true;
      try {
        await api.jiraSync(workspaceId);
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
  }

  function close(): void {
    generation++;
    unsubscribe?.();
    unsubscribe = undefined;
    clearInterval(ticker);
    ticker = undefined;
  }

  // Children are refetch-on-open (no realtime on the child tables). The cache keeps a
  // reopened dialog instant; `refreshIssue` below replaces it with live truth.
  async function loadChildren(issueId: string): Promise<JiraIssueChildren | undefined> {
    const row = integration.value;
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

  // Live refresh through the api (Jira → mirror → this store): the dialog calls it on
  // open so comments are fresher than the 30 s tick.
  async function refreshIssue(workspaceId: string, key: string): Promise<void> {
    if (!tokenPresent.value) return; // no token = mirror is all this member gets
    try {
      const issue = await api.jiraRefreshIssue(workspaceId, key);
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
    tokenEmail,
    loading,
    loadError,
    syncing,
    probe,
    open,
    close,
    upsert,
    drop,
    loadChildren,
    refreshIssue,
  };
});
