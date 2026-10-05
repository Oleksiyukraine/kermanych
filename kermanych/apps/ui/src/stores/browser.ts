// apps/ui/src/stores/browser.ts
// The session browser's renderer side (docs/specs/2026-10-05-embedded-browser.md): the last
// state main reported for each session's view, which sessions' agents are driving theirs right
// now, and the operator's picks tray per session. The views themselves live in Electron main;
// in the web build (no `window.kermanych.browser`) this store stays empty and inert.
import { defineStore } from 'pinia';
import { ref } from 'vue';
import type { TrayPick } from '../lib/browser-picks';

// How long after an agent's browser tool call the Браузер tab keeps its live marker.
const AGENT_LIVE_MS = 5_000;

export const useSessionBrowser = defineStore('sessionBrowser', () => {
  const bridge = window.kermanych?.browser;
  const states = ref<Record<string, KermanychBrowserState>>({});
  // Sessions whose agent called a browser tool within AGENT_LIVE_MS. A timer per session
  // drops the mark, so nothing has to tick while no agent is browsing.
  const agentLive = ref(new Set<string>());
  const liveTimers = new Map<string, number>();
  // Kept here, not in the pane, so the tray survives tab switches and session hops.
  const picks = ref<Record<string, TrayPick[]>>({});

  function markAgent(s: KermanychBrowserState): void {
    const left = s.agentAt + AGENT_LIVE_MS - Date.now();
    if (!s.agentAt || left <= 0) return;
    window.clearTimeout(liveTimers.get(s.sessionId));
    agentLive.value.add(s.sessionId);
    liveTimers.set(
      s.sessionId,
      window.setTimeout(() => {
        liveTimers.delete(s.sessionId);
        agentLive.value.delete(s.sessionId);
      }, left),
    );
  }

  function put(s: KermanychBrowserState): void {
    states.value = { ...states.value, [s.sessionId]: s };
    markAgent(s);
  }

  // One subscription for the app's lifetime: the store is a singleton and main reports every
  // session's view, including ones the operator is not looking at (the agent may drive them).
  bridge?.onState(put);

  // A pane mounting asks once for the state it may have missed (the view could predate this
  // window, or have changed before the store subscribed). Null means no view yet.
  async function refresh(sessionId: string): Promise<void> {
    const s = await bridge?.state(sessionId);
    if (s) put(s);
  }

  function addPick(sessionId: string, pick: KermanychBrowserPick): void {
    const entry: TrayPick = { id: crypto.randomUUID(), pick, comment: '' };
    picks.value = { ...picks.value, [sessionId]: [...(picks.value[sessionId] ?? []), entry] };
  }

  function setComment(sessionId: string, pickId: string, comment: string): void {
    const list = picks.value[sessionId];
    if (!list) return;
    picks.value = { ...picks.value, [sessionId]: list.map((p) => (p.id === pickId ? { ...p, comment } : p)) };
  }

  function removePick(sessionId: string, pickId: string): void {
    const list = (picks.value[sessionId] ?? []).filter((p) => p.id !== pickId);
    const next = { ...picks.value };
    if (list.length) next[sessionId] = list;
    else delete next[sessionId];
    picks.value = next;
  }

  function clearPicks(sessionId: string): void {
    const next = { ...picks.value };
    delete next[sessionId];
    picks.value = next;
  }

  return { available: !!bridge, states, agentLive, picks, refresh, addPick, setComment, removePick, clearPicks };
});
