import type { Session, SessionStatus } from '@kermanych/core';

// A child that is alive and streaming: its Live already holds the rendered rows, so the
// transcript endpoint serves them without a rehydrate.
const RUNNING_STATUSES: readonly SessionStatus[] = ['queued', 'thinking', 'tool', 'waiting_input'];

// Which call an OPEN of a session must make to put its log on screen.
//
// Only a resume rehydrates: after an app restart the api holds no child for the session, so
// GET /transcript answers the "dormant" notice — and once the idle reaper has stopped the
// child but KEPT its Live, it answers an empty list, which renders as «Журнал порожній» with
// nothing to tell the operator why. `resumeSession` respawns the child, replays claude's own
// persisted transcript through the reducers and broadcasts `transcript_reset`.
//
// It is safe on a live session (the server's liveOrResume never respawns a running turn) and
// de-duplicated per id, so the cases below are about avoiding pointless or harmful spawns,
// not about correctness of a double call. ChatPage.selectThread applies the same rule.
export function historyLoadFor(s: Session): 'resume' | 'load' {
  // A native harness is a TUI process no reaper stops, so browsing sessions would leave one
  // running per session looked at. Its pane offers «Продовжити» explicitly.
  if (s.native) return 'load';
  // The worktree is retired: doResume throws «session was merged…», so an open would greet
  // the operator with an error toast instead of the history. «↻ Відновити» is that path.
  if (s.status === 'merged') return 'load';
  // Never launched: no conversation to rehydrate, and a resume would spawn a child for a card
  // the operator has not started.
  if (s.status === 'backlog') return 'load';
  if (RUNNING_STATUSES.includes(s.status)) return 'load';
  return 'resume';
}
