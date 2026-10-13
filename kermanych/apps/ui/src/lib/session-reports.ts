// apps/ui/src/lib/session-reports.ts
// How «Агенти» reads back the reports the api leaves on a session's cloud card
// (`tasks.docs_report`, `tasks.session_report`; docs/specs/2026-10-12-docs-tab-survives-restart.md,
// decision 10). The transcript and the live «Зміни» listing are gone after an api restart or
// «Завершити», the card is not — so each list here is the card's merged with whatever the
// session still has live. Pure, so the precedence rules are pinned by a test rather than by
// the page's markup.
import { isDocPath, type DocChange, type DocsReport, type SessionReport } from '@kermanych/core';
import type { Task } from '@kermanych/cloud';

/**
 * The card's reports that describe THIS session. A card relaunched after a terminal status
 * carries the newer session's reports, and showing them under the older session would put
 * another run's documents and skills on its tabs.
 */
export function ownReports(
  task: Pick<Task, 'docsReport' | 'sessionReport'> | undefined,
  sessionId: string | undefined,
): { docs?: DocsReport; session?: SessionReport } {
  if (!task || !sessionId) return {};
  return {
    ...(task.docsReport?.sessionId === sessionId ? { docs: task.docsReport } : {}),
    ...(task.sessionReport?.sessionId === sessionId ? { session: task.sessionReport } : {}),
  };
}

/**
 * The card's list followed by whatever the transcript adds, first-seen order, no repeats. The
 * card first: it is the older record (the api accumulates it across compactions and restarts),
 * so a path does not jump position when the live transcript happens to see it again.
 */
export function unionInOrder(card: readonly string[] | undefined, live: readonly string[]): string[] {
  return [...new Set([...(card ?? []), ...live])];
}

/**
 * «Створено або оновлено». While the session has its worktree the live listing is the truth —
 * it tracks every edit and every revert — with the card's copy standing in only until the first
 * listing arrives (`liveFiles` null), so the tab does not open empty and then fill. A finished
 * session (merged, or its worktree retired) has no listing to ask for and nothing behind a row:
 * the diff and «Задача →» would only meet `session has no worktree`, so its rows are the card's
 * and LIST-ONLY.
 */
export function changedDocsView(input: {
  finished: boolean;
  liveFiles: readonly DocChange[] | null;
  card: readonly DocChange[] | undefined;
}): { docs: DocChange[]; listOnly: boolean } {
  if (input.finished) return { docs: [...(input.card ?? [])], listOnly: true };
  if (input.liveFiles) return { docs: input.liveFiles.filter((f) => isDocPath(f.path)), listOnly: false };
  return { docs: [...(input.card ?? [])], listOnly: false };
}
