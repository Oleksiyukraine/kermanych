// apps/ui/src/stores/minion.ts
// «Посіпака» on this machine (docs/specs/2026-10-23-minion-auto-run.md): its cap, its pause, the
// projects it works for and what it is doing — the api's MinionState, mirrored. Machine-local
// like the resource profile, so it comes from the local api and never from the cloud.
import { defineStore } from 'pinia';
import { ref } from 'vue';
import type { MinionPause, MinionState } from '@kermanych/core';
import { api } from '../lib/api';
import { minionPauseText } from '../lib/minion';
import { globalTr } from '../boot/i18n';
import { useOrchestrator } from './orchestrator';

export const useMinion = defineStore('minion', () => {
  const local = useOrchestrator();
  // `undefined` until the first read answers: «not loaded» is not «no project active».
  const state = ref<MinionState | undefined>(undefined);
  // Why the last read failed; cleared by the next good one. A panel shows it instead of a
  // skeleton that would never end.
  const loadError = ref('');

  // A pause that was not there before (or a different one), worth telling the operator about.
  // The first read has no «before»: a pause from an earlier run of the app is shown by the strip
  // and the «Посіпака» card, not announced on every start.
  function apply(next: MinionState): void {
    const before = state.value;
    state.value = next;
    const pause = next.pause;
    if (before && pause && (before.pause?.code !== pause.code || before.pause?.at !== pause.at)) announce(pause);
  }

  // Decision 12: a pause is a toast and, while the window is unfocused, a native notification —
  // the same pair the watchdog's alerts use (orchestrator onMachineAlert). A pause stops the
  // queue on an unattended machine, so it is worth reaching the operator wherever they are.
  function announce(pause: MinionPause): void {
    const message = globalTr.t('minion.notify.paused', { reason: minionPauseText((k, named) => globalTr.t(k, named ?? {}), pause) });
    local.notify(message, pause.code === 'operator' ? 'info' : 'error', 15_000);
    if (typeof document !== 'undefined' && !document.hasFocus() && typeof Notification !== 'undefined') {
      const n = new Notification(globalTr.t('minion.notify.title'), { body: message });
      n.onclick = () => window.kermanych?.focus();
    }
  }

  // Replies can overlap (a reconnect's snapshot during a write); only the newest read paints.
  let readRun = 0;
  async function load(): Promise<void> {
    const run = ++readRun;
    try {
      const next = await api.minion();
      if (run !== readRun) return;
      loadError.value = '';
      apply(next);
    } catch (e) {
      if (run !== readRun) return;
      loadError.value = e instanceof Error ? e.message : String(e);
    }
  }

  // Every socket (re)connect starts with a `snapshot`: the api may have changed state while the
  // socket was down (a pause, a finished run), so the whole state is read again. The connect at
  // start is the app's first read. Between snapshots `minion_update` carries every change.
  local.onServerEvent((e) => {
    if (e.type === 'snapshot') void load();
    else if (e.type === 'minion_update') {
      // An event outdates any read still in flight.
      readRun++;
      loadError.value = '';
      apply(e.state);
    }
  });

  // The writes answer with the whole state, as the event does; the callers wrap them in
  // useAsyncAction / useOptimisticValue for the spinner and the error toast. An event that
  // arrives while the request is in flight is newer than the reply, so the reply then yields.
  async function write(send: () => Promise<MinionState>): Promise<void> {
    const run = ++readRun;
    const next = await send();
    if (run === readRun) apply(next);
  }

  const setCap = (cap: number) => write(() => api.setMinion({ cap }));
  const setPaused = (paused: boolean) => write(() => api.setMinion({ paused }));
  const setProjectActive = (projectId: string, active: boolean) => write(() => api.setMinionProject(projectId, active));

  return { state, loadError, load, setCap, setPaused, setProjectActive };
});
