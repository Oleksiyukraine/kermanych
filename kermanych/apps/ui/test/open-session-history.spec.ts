import { describe, expect, it } from 'vitest';
import type { Session } from '@kermanych/core';
import { historyLoadFor } from '../src/lib/open-session-history';

// Opening a session must bring its log back. After an app restart the api holds no child for
// it, so GET /transcript can only answer the "dormant" notice — or, once the idle reaper has
// stopped the child but kept its Live, an EMPTY list that renders as «Журнал порожній».
// Only a resume rehydrates, so this is the rule that decides which call an open makes.
// ChatPage.selectThread already applies the same rule to threads.

const base: Session = {
  id: 's1',
  projectId: 'p1',
  kind: 'agent',
  name: 'agent',
  status: 'done',
  createdAt: '2026-10-20T00:00:00Z',
  lastActivityAt: '2026-10-20T00:00:00Z',
} as Session;

const session = (patch: Partial<Session> = {}): Session => ({ ...base, ...patch });

describe('historyLoadFor', () => {
  it('resumes a settled managed session so its transcript rehydrates', () => {
    expect(historyLoadFor(session({ status: 'done' }))).toBe('resume');
    expect(historyLoadFor(session({ status: 'in_review' }))).toBe('resume');
    expect(historyLoadFor(session({ status: 'stopped' }))).toBe('resume');
    expect(historyLoadFor(session({ status: 'error' }))).toBe('resume');
  });

  // A native harness is a TUI process no reaper stops, so browsing sessions would leave one
  // running per session looked at. Its detail pane offers «Продовжити» instead.
  it('only loads a native session, never starting its harness on a click', () => {
    expect(historyLoadFor(session({ native: true }))).toBe('load');
  });

  // Its worktree is gone: doResume throws «session was merged…», so an open would greet the
  // operator with an error toast instead of the history. «↻ Відновити» is the deliberate path.
  it('only loads a merged session, whose worktree a resume cannot rebuild', () => {
    expect(historyLoadFor(session({ status: 'merged' }))).toBe('load');
  });

  // Never launched — there is no conversation to rehydrate, and a resume would spawn a child
  // for a card the operator has not started.
  it('only loads a backlog card, which has no conversation yet', () => {
    expect(historyLoadFor(session({ status: 'backlog' }))).toBe('load');
  });

  // The child is alive and its Live already holds the rendered rows; a resume is a no-op the
  // server de-duplicates, but asking for one per click costs a round trip for nothing.
  it('only loads a session whose child is still running', () => {
    expect(historyLoadFor(session({ status: 'thinking' }))).toBe('load');
    expect(historyLoadFor(session({ status: 'tool' }))).toBe('load');
    expect(historyLoadFor(session({ status: 'queued' }))).toBe('load');
    expect(historyLoadFor(session({ status: 'waiting_input' }))).toBe('load');
  });
});
