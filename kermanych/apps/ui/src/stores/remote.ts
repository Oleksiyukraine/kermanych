// apps/ui/src/stores/remote.ts
// «Пульт» on this machine (docs/specs/2026-11-24-mobile-remote-control.md): the switch, what the
// api found out about Tailscale, the phase of `tailscale serve` and the paired phones — the api's
// RemoteState, mirrored. Machine-local like «Посіпака» (stores/minion.ts, the model of this
// store), so it comes from the local api and never from the cloud.
import { defineStore } from 'pinia';
import { ref } from 'vue';
import type { RemoteState } from '@kermanych/core';
import { api } from '../lib/api';
import { useOrchestrator } from './orchestrator';

export const useRemote = defineStore('remote', () => {
  const local = useOrchestrator();
  // `undefined` until the first read answers: «not loaded» is not «off».
  const state = ref<RemoteState | undefined>(undefined);
  // Why the last read failed; cleared by the next good one. The section shows it instead of a
  // skeleton that would never end.
  const loadError = ref('');

  // Replies can overlap (a reconnect's snapshot during a write); only the newest read paints.
  let readRun = 0;
  async function load(): Promise<void> {
    const run = ++readRun;
    try {
      const next = await api.remote();
      if (run !== readRun) return;
      loadError.value = '';
      state.value = next;
    } catch (e) {
      if (run !== readRun) return;
      loadError.value = e instanceof Error ? e.message : String(e);
    }
  }

  // Every socket (re)connect starts with a `snapshot`: the api may have changed state while the
  // socket was down (serve came up, a phone paired or lapsed), so the whole state is read again.
  // Between snapshots `remote_update` carries every change.
  local.onServerEvent((e) => {
    if (e.type === 'snapshot') void load();
    else if (e.type === 'remote_update') {
      // An event outdates any read still in flight.
      readRun++;
      loadError.value = '';
      state.value = e.state;
    }
  });

  // The writes answer with the whole state, as the event does; the callers wrap them in
  // useAsyncAction / useOptimisticValue / useKeyedAction for the spinner and the error toast. An
  // event that arrives while the request is in flight is newer than the reply, so the reply
  // then yields.
  async function write(send: () => Promise<RemoteState>): Promise<void> {
    const run = ++readRun;
    const next = await send();
    if (run === readRun) state.value = next;
  }

  const setEnabled = (enabled: boolean) => write(() => api.setRemote(enabled));
  const recheck = () => write(() => api.recheckRemote());
  // Linux (decision 10): the system's own password dialog, once.
  const grantOperator = () => write(() => api.remoteOperator());
  const removeDevice = (id: string) => write(() => api.removeRemoteDevice(id));

  return { state, loadError, load, setEnabled, recheck, grantOperator, removeDevice };
});
