// apps/ui/src/composables/useSessionPreview.ts
// The live preview of one `agent` session as the «Браузер» and «Пристрій» tabs show it
// (docs/specs/2026-11-03-session-browser-preview.md, decisions 4, 6, 7;
// docs/specs/2026-11-03-mobile-device-preview.md, decisions 6, 11). The state is the api's
// (stores/orchestrator.ts `previews`); the config status is read here, from the session
// directory, whenever it may have changed: on mount, when the agent's turn ends (it may have
// written `.kermanych/preview.json`), and after every state change. The preview row
// (KPreviewRow), the bottom panel (KPreviewPanel: «Логи» or «Змінні») and the pane around them
// share one instance.
import { computed, ref, watch, type Ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { PREVIEW_DEVICE_STEP, type PreviewConfigStatus, type PreviewState, type Session } from '@kermanych/core';
import { useOrchestrator } from '../stores/orchestrator';
import { errorText, useAsyncAction } from './useAsyncAction';
import { useLoadPhase } from './useLoadPhase';
import { previewStatusView } from '../lib/preview-view';

const BUSY_STATUSES: Session['status'][] = ['thinking', 'tool'];

// `device` (the «Пристрій» tab): the preview has no page, so ▶ opens no placeholder tab in the
// web build. ▶ / ↻ name no device either way: the api starts on the session's clone, else the
// project's choice or the default (docs/specs/2026-11-03-mobile-device-preview.md, decisions
// 4, 6) — so a clone whose base was deleted since still starts. Only the device picker
// (KDevicePane) sends an explicit platform and base.
export type SessionPreviewOptions = { device?: boolean };

export function useSessionPreview(session: () => Session, opts: SessionPreviewOptions = {}) {
  const { t } = useI18n();
  const store = useOrchestrator();
  const sessionId = () => session().id;

  const state = computed<PreviewState | null>(() => store.previews[sessionId()] ?? null);
  const live = computed(() => state.value?.phase === 'starting' || state.value?.phase === 'running');
  // Null on a Mobile preview too: it has no page.
  const url = computed(() => (state.value?.phase === 'running' ? state.value.url : null));
  // The booted device, from the moment it has booted (the screen shows while `install` runs).
  const device = computed(() => (state.value?.phase === 'starting' || state.value?.phase === 'running' ? state.value.device ?? null : null));
  const appExited = computed(() => state.value?.phase === 'running' && state.value.app === 'exited');

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

  // ── Bottom panel: «Логи» or «Змінні» ─────────────────────────────────────
  // One panel under the page, showing either view (docs/specs/2026-11-04-session-env-and-tester-
  // preview-gate.md, decision 2). Logs open on demand, and by themselves on the failed step when a
  // run crashes or fails while the tab is mounted (a crash the operator was not here for still
  // shows in the row, red) — and on the `device` step, which carries the app's log, when a Mobile
  // app exits. Never over «Змінні»: unsaved edits there would be lost, and the row is red anyway.
  const panel = ref<'logs' | 'env' | null>(null);
  const logsOpen = computed(() => panel.value === 'logs');
  const envOpen = computed(() => panel.value === 'env');
  const logsStep: Ref<string | null> = ref(null);
  watch(state, (s, before) => {
    if (s === before || !s) return;
    if (s.phase === 'crashed' || s.phase === 'failed') {
      logsStep.value = s.step;
      if (!envOpen.value) panel.value = 'logs';
    } else if (s.phase === 'running' && s.app === 'exited' && !(before?.phase === 'running' && before.app === 'exited')) {
      logsStep.value = PREVIEW_DEVICE_STEP;
      if (!envOpen.value) panel.value = 'logs';
    }
  });
  function toggleLogs(): void {
    panel.value = logsOpen.value ? null : 'logs';
  }
  function toggleEnv(): void {
    panel.value = envOpen.value ? null : 'env';
  }
  function closePanel(): void {
    panel.value = null;
  }

  // ── Actions ──────────────────────────────────────────────────────────────
  // The web build has no page of its own: ▶ opens a tab inside the click (a tab opened after the
  // await would be eaten by the popup blocker) and points it at the URL once the preview runs.
  // The watch reads the store, not this pane's `state`, and is not tied to the pane: the tab
  // keeps waiting for its URL when the operator moves on to another session meanwhile.
  const bridge = window.kermanych?.browser;
  function placeholder(restart: boolean): ((ok: boolean) => void) | null {
    if (bridge || opts.device) return null;
    const win = window.open('', '_blank');
    if (!win) return null;
    win.document.write(`<p style="font:14px system-ui;padding:24px;color:#888">${t('agents.preview.loadingText')}</p>`);
    const id = sessionId();
    const before = store.previews[id] ?? null;
    let started = false;
    const point = (s: PreviewState | null): void => {
      if (win.closed) return stop();
      if (s?.phase === 'running' && (s !== before || !restart)) {
        // A preview without a page (the file gained a `device` block meanwhile) has nothing to
        // point the tab at.
        if (s.url) win.location.href = s.url;
        else win.close();
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
  // «Запустити застосунок»: the app exited under a running Mobile preview (decision 11).
  const launchAppAction = useAsyncAction(() => store.launchPreviewApp(sessionId()));
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
    device,
    appExited,
    config,
    configError,
    configPhase,
    configOk,
    status,
    panel,
    logsOpen,
    envOpen,
    logsStep,
    toggleLogs,
    toggleEnv,
    closePanel,
    start,
    startAction,
    restartAction,
    stopAction,
    launchAppAction,
    configureAction,
    configureError,
  };
}

export type SessionPreview = ReturnType<typeof useSessionPreview>;
