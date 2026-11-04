// apps/ui/src/lib/cuk-digest.ts
// What ЦУК is told about the app every turn, pure: the session and board rows of the context
// block, and how the executor finds a session the model named by its `ref`
// (docs/specs/2026-11-04-cuk-control-console.md, decision 5).
import type { CukBoardRow, CukSessionRow, Session } from '@kermanych/core';
import type { Task } from '@kermanych/cloud';
import { boardTasks } from './tasks-view';

// How many rows of each a turn carries. Enough for any one person's machine and board; the
// count of the rest travels too, so «їх більше» can be said honestly.
export const CUK_MAX_SESSIONS = 60;
export const CUK_MAX_ARCHIVED = 10;
export const CUK_MAX_BOARD = 50;

// The handle a session is named by in the prompt: the head of its id. Eight characters of a
// uuid are unique on one machine by a wide margin; `findSessionByRef` refuses a clash anyway.
export function sessionRef(id: string): string {
  return id.slice(0, 8);
}

// Statuses that say a card on the board is finished; the digest leaves those cards out.
const CLOSED_TASK: Record<string, true> = { merged: true, done: true };

// Live sessions first — the ones waiting for an answer at the very top, then the rest by
// latest activity — and after them the most recent archived ones, so «розархівуй» has a
// session to name. Merged sessions and project chats are not the console's business.
export function cukSessionRows(
  sessions: readonly Session[],
  projectName: (projectId: string) => string,
  previewOn: (sessionId: string) => boolean,
): { rows: CukSessionRow[]; omitted: number } {
  const eligible = sessions.filter((s) => s.kind !== 'chat' && s.status !== 'merged');
  const waiting = (s: Session): boolean => s.status === 'waiting_input' || !!s.pendingUiRequest;
  const recent = (a: Session, b: Session): number => b.lastActivityAt.localeCompare(a.lastActivityAt);
  const live = eligible.filter((s) => !s.archived).sort((a, b) => Number(waiting(b)) - Number(waiting(a)) || recent(a, b));
  const archived = eligible.filter((s) => s.archived).sort(recent);
  const picked = [...live.slice(0, CUK_MAX_SESSIONS), ...archived.slice(0, CUK_MAX_ARCHIVED)];
  return {
    rows: picked.map((s) => ({
      ref: sessionRef(s.id),
      project: projectName(s.projectId),
      name: s.name,
      kind: s.designDir ? 'design' : s.kind,
      status: s.status,
      waiting: waiting(s),
      archived: !!s.archived,
      ...(previewOn(s.id) ? { preview: true } : {}),
    })),
    omitted: eligible.length - picked.length,
  };
}

// The board's open cards, the ones the kanban itself would show, newest first.
export function cukBoardRows(
  tasks: readonly Task[],
  projectName: (projectId: string) => string,
  assigneeName: (task: Task) => string,
): { rows: CukBoardRow[]; omitted: number } {
  const open = boardTasks([...tasks]).filter((t) => !CLOSED_TASK[t.status]);
  return {
    rows: open.slice(0, CUK_MAX_BOARD).map((t) => ({
      title: t.title,
      project: projectName(t.projectId),
      status: t.status,
      assignee: assigneeName(t),
    })),
    omitted: Math.max(0, open.length - CUK_MAX_BOARD),
  };
}

// The session a `ref` names: an exact id, or the one session whose id starts with it. Two
// matches name nobody — the executor says so rather than picking one.
export function findSessionByRef(sessions: readonly Session[], ref: string): Session | undefined {
  const wanted = ref.trim().toLowerCase();
  if (!wanted) return undefined;
  const exact = sessions.find((s) => s.id.toLowerCase() === wanted);
  if (exact) return exact;
  const hits = sessions.filter((s) => s.id.toLowerCase().startsWith(wanted));
  return hits.length === 1 ? hits[0] : undefined;
}
