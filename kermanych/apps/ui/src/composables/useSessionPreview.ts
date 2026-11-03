// apps/ui/src/composables/useSessionPreview.ts
// The live preview of one `agent` session as the «Браузер» tab shows it
// (docs/specs/2026-11-03-session-browser-preview.md, decisions 4, 6, 7). The state is the api's
// (stores/orchestrator.ts `previews`); the config status is read here, from the session
// directory, whenever it may have changed: on mount, when the agent's turn ends (it may have
// written `.kermanych/preview.json`), and after every state change. The preview row
// (KPreviewRow), the logs panel (KPreviewLogs) and the pane around them share one instance.
import { computed, ref, watch, type Ref } from 'vue';
import { useI18n } from 'vue-i18n';
import type { PreviewConfigStatus, PreviewState, Session } from '@kermanych/core';
import { useOrchestrator } from '../stores/orchestrator';
import { errorText, useAsyncAction } from './useAsyncAction';
import { useLoadPhase } from './useLoadPhase';
import { previewStatusView } from '../lib/preview-view';

const BUSY_STATUSES: Session['status'][] = ['thinking', 'tool'];

export function useSessionPreview(session: () => Session) {
  const { t } = useI18n();
  const store = useOrchestrator();
  const sessionId = () => session().id;

  const state = computed<PreviewState | null>(() => store.previews[sessionId()] ?? null);
  const live = computed(() => state.value?.phase === 'starting' || state.value?.phase === 'running');
  const url = computed(() => (state.value?.phase === 'running' ? state.value.url : null));

  // undefined = not read yet (the row shows a skeleton), apart from a read that failed.
  const config = ref<PreviewConfigStatus | undefined>(undefined);
  const configError = ref<string | null>(null);
  let configSeq = 0;
  async function loadConfig(): Promise<void> {
    const seq = ++configSeq;
    const id = sessionId();
    try {
      const info = await store.previewInfo(id);
      if (seq !== configSeq) return;
      config.value = info.config;
      configError.value = null;
    } catch (e) {
      if (seq === configSeq) configError.value = errorText(e);
    }
  }
  const configPhase = useLoadPhase(() => config.value === undefined && configError.value === null);
  const status = computed(() => previewStatusView(state.value, config.value));
  const configOk = computed(() => config.value?.kind === 'ok');

  watch(sessionId, () => {
    config.value = undefined;
    configError.value = null;
    void loadConfig();
  });
  watch(
    () => session().status,
    (now, before) => {
      if (before && BUSY_STATUSES.includes(before) && !BUSY_STATUSES.includes(now)) void loadConfig();
    },
  );
  watch(state, () => void loadConfig());
  void loadConfig();

  // ── Logs panel ───────────────────────────────────────────────────────────
  // Open on demand, and by itself on the failed step when a run crashes or fails while the tab
  // is mounted (a crash the operator was not here for still shows in the row, red).
  const logsOpen = ref(false);
  const logsStep: Ref<string | null> = ref(null);
  watch(state, (s, before) => {
    if (s === before || !s) return;
    if (s.phase === 'crashed' || s.phase === 'failed') {
      logsStep.value = s.step;
      logsOpen.value = true;
    }
  });
  function toggleLogs(): void {
    logsOpen.value = !logsOpen.value;
  }

  // ── Actions ──────────────────────────────────────────────────────────────
  // The web build has no page of its own: ▶ opens a tab inside the click (a tab opened after the
  // await would be eaten by the popup blocker) and points it at the URL once the preview runs.
  // The watch reads the store, not this pane's `state`, and is not tied to the pane: the tab
  // keeps waiting for its URL when the operator moves on to another session meanwhile.
  const bridge = window.kermanych?.browser;
  function placeholder(restart: boolean): ((ok: boolean) => void) | null {
    if (bridge) return null;
    const win = window.open('', '_blank');
    if (!win) return null;
    win.document.write(`<p style="font:14px system-ui;padding:24px;color:#888">${t('agents.preview.loadingText')}</p>`);
    const id = sessionId();
    const before = store.previews[id] ?? null;
    let started = false;
    const point = (s: PreviewState | null): void => {
      if (win.closed) return stop();
      if (s?.phase === 'running' && (s !== before || !restart)) {
        win.location.href = s.url;
        return stop();
      }
      if (s === before) return;
      if (s?.phase === 'starting') started = true;
      // A restart may pass through `stopped` on its way; only a stop after it started (◼), a run
      // that ended badly or a session that is gone gives up on the tab.
      else if (!s || s.phase === 'crashed' || s.phase === 'failed' || (s.phase === 'stopped' && started)) {
        win.close();
        stop();
      }
    };
    const stop = watch(() => store.previews[id] ?? null, point);
    point(before);
    return (ok) => {
      if (ok || win.closed) return;
      win.close();
      stop();
    };
  }

  const startAction = useAsyncAction(async () => {
    await store.startPreview(sessionId());
    return true;
  });
  const restartAction = useAsyncAction(async () => {
    await store.startPreview(sessionId(), true);
    return true;
  });
  const stopAction = useAsyncAction(() => store.stopPreview(sessionId()));
  async function start(restart = false): Promise<void> {
    const action = restart ? restartAction : startAction;
    if (action.busy.value) return;
    const settle = placeholder(restart);
    const ok = await action.run();
    settle?.(!!ok);
  }

  // «Доручити агенту»: a native session refuses while busy; the refusal stays in the row.
  const configureError = ref<string | null>(null);
  const configureAction = useAsyncAction(
    async () => {
      configureError.value = null;
      await store.configurePreview(sessionId());
      store.notify(t('agents.preview.configureSent'));
    },
    {
      onError: (e) => {
        configureError.value = errorText(e);
      },
    },
  );

  return {
    state,
    live,
    url,
    config,
    configError,
    configPhase,
    configOk,
    status,
    logsOpen,
    logsStep,
    toggleLogs,
    start,
    startAction,
    restartAction,
    stopAction,
    configureAction,
    configureError,
  };
}

export type SessionPreview = ReturnType<typeof useSessionPreview>;
