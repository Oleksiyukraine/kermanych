// apps/ui/src/lib/message-mode.ts
// Which omp message mode the session's next message takes — one rule for every place the
// operator talks to an agent: the «Агенти», «Чат» and «Синергія» composers, «Надіслати агенту» from
// the session browser, and the voice conversation. An empty session (a fresh quick chat) starts
// its first turn with a prompt. Otherwise: a settled session gets a fresh follow-up; a live one is
// steered mid-turn.
import type { Session, TranscriptEntry } from '@kermanych/core';
import type { MessageMode } from './api';

export function nextMode(s: Session, history: readonly TranscriptEntry[]): MessageMode {
  const hasTurn = history.some((e) => e.kind === 'user_text' || e.kind === 'assistant_text');
  return !hasTurn ? 'prompt' : s.status === 'done' ? 'follow_up' : 'steer';
}
