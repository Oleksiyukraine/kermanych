// apps/ui/src/stores/browser.ts
// The session browser's renderer side (docs/specs/2026-10-05-embedded-browser.md): the last
// state main reported for each session's view, which sessions' agents are driving theirs right
// now, where the shown view sits on screen, the «Поруч із логом» preference, and the operator's
// picks tray per session. The views themselves live in Electron main; in the web build (no
// `window.kermanych.browser`) the browser part stays empty and inert, and only the tray is used
// — by the «Пристрій» tab's device picks (docs/specs/2026-11-03-mobile-device-preview.md).
import { platformHasBrowser } from '@kermanych/core';
import { defineStore } from 'pinia';
import { ref, watch } from 'vue';
import { loadPicksTray, savePicksTray, type TrayPick } from '../lib/browser-picks';
import { globalTr } from '../boot/i18n';
import { useOrchestrator } from './orchestrator';

// How long after an agent's browser tool call the Браузер tab keeps its live marker.
const AGENT_LIVE_MS = 5_000;

// Show the browser beside the Лог instead of in its own tab. Per app, not per session: it is
// a way of working (watch the agent click while reading what it says), not a session fact.
const SPLIT_KEY = 'kermanych.agents.browser-split';

export const useSessionBrowser = defineStore('sessionBrowser', () => {
  const bridge = window.kermanych?.browser;
  const orchestrator = useOrchestrator();
  const states = ref<Record<string, KermanychBrowserState>>({});
  // Sessions whose agent called a browser tool within AGENT_LIVE_MS. A timer per session
  // drops the mark, so nothing has to tick while no agent is browsing.
  const agentLive = ref(new Set<string>());
  const liveTimers = new Map<string, number>();
  // Where the shown view is painted (viewport px), null while every view is parked. The view
  // sits above the whole DOM, so KToast reads this to keep its stack beside it, not under it.
  const shownRect = ref<KermanychBrowserBounds | null>(null);
  const split = ref(localStorage.getItem(SPLIT_KEY) === '1');
  // Kept here, not in the pane, so the tray survives tab switches and session hops; restored
  // from sessionStorage so it survives a renderer reload too (lib/browser-picks.ts).
  const restored = loadPicksTray(sessionStorage);
  const picks = ref<Record<string, TrayPick[]>>(restored.picks);
  // The general comment typed above «Надіслати агенту», per session.
  const notes = ref<Record<string, string>>(restored.notes);

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

  // The view is gone (main closed it: deleted session, idle close) or the session is: forget
  // its state and live mark. The picks tray stays — an idle close must not eat the operator's
  // notes; dropSession clears it for a session that no longer exists at all.
  function forget(sessionId: string): void {
    if (sessionId in states.value) {
      const next = { ...states.value };
      delete next[sessionId];
      states.value = next;
    }
    window.clearTimeout(liveTimers.get(sessionId));
    liveTimers.delete(sessionId);
    agentLive.value.delete(sessionId);
  }

  function persistPicks(): void {
    savePicksTray(sessionStorage, { picks: picks.value, notes: notes.value });
  }

  // One subscription each for the app's lifetime: the store is a singleton and main reports
  // every session's view, including ones the operator is not looking at (the agent may drive
  // them).
  bridge?.onState(put);
  bridge?.onClosed(forget);
  bridge?.onDownload((_sessionId, file) => orchestrator.notify(globalTr.t('agents.browser.downloaded', { name: file.name })));

  // A session that disappears from the orchestrator (deleted, pruned) takes its browser state
  // and tray with it. Diffed against the previous list rather than checked against the
  // current one, so the empty list before the first load prunes nothing.
  watch(
    () => new Set(orchestrator.sessions.map((s) => s.id)),
    (now, before) => {
      let trayChanged = false;
      for (const id of before ?? []) {
        if (now.has(id)) continue;
        forget(id);
        if (id in picks.value || id in notes.value) {
          const nextPicks = { ...picks.value };
          const nextNotes = { ...notes.value };
          delete nextPicks[id];
          delete nextNotes[id];
          picks.value = nextPicks;
          notes.value = nextNotes;
          trayChanged = true;
        }
      }
      if (trayChanged) persistPicks();
    },
  );

  // A project switched to back-end or mobile has no browser (docs/specs/2026-11-03-session-
  // browser-preview.md, decision 9): its sessions' pages close. Every session of the project,
  // not only those with a known state — a view may predate this window's subscription. Diffed
  // against the previous rows, so the first load closes nothing.
  watch(
    () => new Map(orchestrator.projects.map((p) => [p.id, platformHasBrowser(p.platform)])),
    (now, before) => {
      for (const [projectId, has] of now) {
        if (has || !before?.get(projectId)) continue;
        for (const s of orchestrator.sessions) if (s.projectId === projectId) close(s.id);
      }
    },
  );

  // A pane mounting asks once for the state it may have missed (the view could predate this
  // window, or have changed before the store subscribed). Null means no view yet.
  async function refresh(sessionId: string): Promise<void> {
    const s = await bridge?.state(sessionId);
    if (s) put(s);
  }

  // Every renderer-initiated load (address bar, «Відкрити превʼю», «Відкрити знову»). A load
  // failure (connection refused, DNS, …) also arrives as `state.error`, and the pane shows it
  // as a panel in place of the page, so it is not toasted twice. Chromium's net errors carry
  // their `ERR_…` name (Electron rejects loadURL with «ERR_CONNECTION_REFUSED (-102) loading
  // …»); anything else — a refused scheme, a session without a project — is not on the page
  // and still gets a toast. Resolves (never rejects) once main has answered the load — true
  // when the page loaded — so a pane's «Відкрити знову» / «Спробувати ще» can spin until then.
  function settled(load: Promise<void>): Promise<boolean> {
    return load.then(
      () => true,
      (e: unknown) => {
        const message = e instanceof Error ? e.message : String(e);
        if (!/\bERR_[A-Z_]+\b/.test(message)) orchestrator.notify(message, 'error');
        return false;
      },
    );
  }
  // `ephemeral`: a «Тестувальник» run's view lives in its own in-memory partition.
  function navigate(sessionId: string, projectId: string, url: string, ephemeral = false): Promise<boolean> {
    return bridge ? settled(bridge.navigate(sessionId, projectId, url, ephemeral)) : Promise.resolve(false);
  }
  // The running live preview: main keeps the path of a page on the previous preview's origin.
  function openPreview(sessionId: string, projectId: string, url: string, ephemeral = false): Promise<boolean> {
    return bridge ? settled(bridge.openPreview(sessionId, projectId, url, ephemeral)) : Promise.resolve(false);
  }

  function setSplit(on: boolean): void {
    split.value = on;
    localStorage.setItem(SPLIT_KEY, on ? '1' : '0');
  }

  // The operator's ✕ on the Браузер tab. Main reports it back through onClosed, which forgets
  // the state; the picks tray stays, as after an idle close.
  function close(sessionId: string): void {
    bridge?.close(sessionId);
  }

  // A device pick (KDevicePane) joins the same tray: the tray and «Надіслати агенту» live here
  // whichever screen the element was pointed at, in both builds.
  function addPick(sessionId: string, pick: TrayPick['pick']): void {
    const entry: TrayPick = { id: crypto.randomUUID(), pick, comment: '' };
    picks.value = { ...picks.value, [sessionId]: [...(picks.value[sessionId] ?? []), entry] };
    persistPicks();
  }

  function setComment(sessionId: string, pickId: string, comment: string): void {
    const list = picks.value[sessionId];
    if (!list) return;
    picks.value = { ...picks.value, [sessionId]: list.map((p) => (p.id === pickId ? { ...p, comment } : p)) };
    persistPicks();
  }

  function setNote(sessionId: string, note: string): void {
    const next = { ...notes.value };
    if (note) next[sessionId] = note;
    else delete next[sessionId];
    notes.value = next;
    persistPicks();
  }

  function removePick(sessionId: string, pickId: string): void {
    const list = (picks.value[sessionId] ?? []).filter((p) => p.id !== pickId);
    if (!list.length) return clearPicks(sessionId);
    picks.value = { ...picks.value, [sessionId]: list };
    persistPicks();
  }

  // Sent, cleared or emptied pick by pick: the general comment belongs to these picks and
  // goes with them.
  function clearPicks(sessionId: string): void {
    const nextPicks = { ...picks.value };
    const nextNotes = { ...notes.value };
    delete nextPicks[sessionId];
    delete nextNotes[sessionId];
    picks.value = nextPicks;
    notes.value = nextNotes;
    persistPicks();
  }

  // «Синергія», decision 8: what a Синергія request carries — the page shown and the tray —
  // handed to the orchestrator's sendMessage, which cannot import this store back.
  orchestrator.provideSynergyContext((sessionId) => ({
    page: states.value[sessionId]?.url,
    picks: picks.value[sessionId] ?? [],
    note: notes.value[sessionId],
    clear: () => clearPicks(sessionId),
  }));

  return {
    available: !!bridge,
    states,
    agentLive,
    shownRect,
    split,
    picks,
    notes,
    refresh,
    navigate,
    openPreview,
    setSplit,
    close,
    addPick,
    setComment,
    setNote,
    removePick,
    clearPicks,
  };
});
