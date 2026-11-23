// apps/ui/src/stores/pr-loop.ts
// «Петля після ПР» on this machine (docs/specs/2026-11-23-pr-feedback-loop.md): the api watches
// the CI and the review comments of every PR a session opened; this store mirrors the latest
// state per session for the status line (KStatusLine), and announces the events that need the
// operator (decision 10). Machine-local like «Посіпака» (stores/minion.ts): the local api only.
import { defineStore } from 'pinia';
import { ref } from 'vue';
import { isReadyToMerge, type PrLoopSettings, type PrLoopState } from '@kermanych/core';
import { api } from '../lib/api';
import { bounceDock } from '../lib/dock';
import { globalTr } from '../boot/i18n';
import { useOrchestrator } from './orchestrator';

/** The events of decision 10, each worth one announcement on the transition into it. */
export type PrLoopEvent = 'paused' | 'ready' | 'manualReady' | 'ciStuck';

/**
 * What changed between two states of one session that the operator must hear about. Pure, so the
 * rule is testable: the loop paused; the PR became ready to merge; manual mode got feedback to
 * pass; the CI started hanging past the stuck limit.
 */
export function prLoopEvents(before: PrLoopState, next: PrLoopState): PrLoopEvent[] {
  const out: PrLoopEvent[] = [];
  if (next.loop.phase === 'paused' && before.loop.phase !== 'paused') out.push('paused');
  if (isReadyToMerge(next) && !isReadyToMerge(before)) out.push('ready');
  if (next.loop.phase === 'manual_ready' && before.loop.phase !== 'manual_ready') out.push('manualReady');
  if (next.ci.stuckMin !== undefined && before.ci.stuckMin === undefined) out.push('ciStuck');
  return out;
}

export const usePrLoop = defineStore('pr-loop', () => {
  const local = useOrchestrator();
  // Per session id. A session absent here is not watched (or not read yet): the status line then
  // shows the plain «На ревʼю».
  const states = ref<Record<string, PrLoopState>>({});

  function put(s: PrLoopState): void {
    states.value = { ...states.value, [s.sessionId]: s };
  }
  function drop(id: string): void {
    if (!(id in states.value)) return;
    const next = { ...states.value };
    delete next[id];
    states.value = next;
  }

  // Decision 10: a toast and, while the window is unfocused, a native notification with the Dock
  // bounce — the pair «Посіпака»'s pause uses (stores/minion.ts). The bounce follows the
  // «Підстрибувати» switch (lib/dock.ts). Both open the session.
  function announce(s: PrLoopState, event: PrLoopEvent): void {
    const session = local.sessions.find((x) => x.id === s.sessionId);
    const name = session?.name ?? (s.pr ? `#${s.pr.number}` : '');
    const body = globalTr.t(
      `prLoop.notify.${event}`,
      { n: s.loop.maxRounds, min: s.ci.stuckMin ?? 0, pr: s.pr ? `#${s.pr.number}` : '' },
      event === 'paused' ? s.loop.maxRounds : undefined,
    );
    const open = (): void => {
      if (!session) return;
      local.selectProject(session.projectId);
      local.selectSession(session.id);
    };
    local.notify(`${name}: ${body}`, 'info', 15_000, session ? { label: globalTr.t('prLoop.notify.open'), run: open } : undefined);
    bounceDock();
    if (typeof document !== 'undefined' && !document.hasFocus() && typeof Notification !== 'undefined') {
      const n = new Notification(name || globalTr.t('prLoop.notify.title'), { body });
      n.onclick = () => {
        window.kermanych?.focus();
        open();
      };
    }
  }

  // An event for a session already known announces what changed. A read never does: the first one
  // has no «before», and a reconnect's re-read would announce what the operator may have seen.
  function onUpdate(sessionId: string, next: PrLoopState | null): void {
    if (!next) return drop(sessionId);
    const before = states.value[sessionId];
    put(next);
    if (before) for (const event of prLoopEvents(before, next)) announce(next, event);
  }

  // Replies can overlap (a reconnect's snapshot while an event arrives); only the newest read
  // paints, and an event outdates a read still in flight.
  let readRun = 0;
  async function load(): Promise<void> {
    const run = ++readRun;
    try {
      const list = await api.prLoop();
      if (run !== readRun) return;
      states.value = Object.fromEntries(list.map((s) => [s.sessionId, s]));
    } catch {
      // The api is down or restarting: the next snapshot reads again. The status line keeps
      // what it had; a missing state only means the plain «На ревʼю».
    }
  }

  // Every socket (re)connect starts with a `snapshot`: the api may have moved while the socket was
  // down, so the whole list is read again. Between snapshots `pr_loop_update` carries each change.
  local.onServerEvent((e) => {
    if (e.type === 'snapshot') void load();
    else if (e.type === 'pr_loop_update') {
      readRun++;
      onUpdate(e.sessionId, e.state);
    }
  });
  // Created after the first snapshot (a hot reload): read now rather than wait for a reconnect.
  if (local.snapshotReceived) void load();

  // The actions; the callers wrap them in useAsyncAction / useKeyedAction for the spinner and the
  // error toast. The api answers `send` with nothing to paint: the session's own turn and the next
  // `pr_loop_update` show the result.
  async function send(id: string, keys?: string[]): Promise<void> {
    await api.prLoopSend(id, keys);
  }
  async function resume(id: string): Promise<void> {
    readRun++;
    put(await api.prLoopResume(id));
  }
  const settings = (projectId: string): Promise<PrLoopSettings> => api.prLoopSettings(projectId);
  const saveSettings = (projectId: string, patch: Partial<PrLoopSettings>): Promise<PrLoopSettings> =>
    api.setPrLoopSettings(projectId, patch);

  return { states, load, send, resume, settings, saveSettings };
});
