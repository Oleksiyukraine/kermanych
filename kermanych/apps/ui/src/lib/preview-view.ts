// How the live preview of a session reads in the «Браузер» and «Пристрій» tabs
// (docs/specs/2026-11-03-session-browser-preview.md, decision 6;
// docs/specs/2026-11-03-mobile-device-preview.md, decision 11): the status line of the preview
// row, the tab's status mark, and the logs panel's per-step buffer. Pure: no Vue, no i18n
// instance — the row resolves `key` under `agents.preview.status`.
import {
  PREVIEW_DEVICE_STEP,
  PREVIEW_INSTALL_STEP,
  PREVIEW_SETUP_STEP,
  type PreviewConfigStatus,
  type PreviewLogLine,
  type PreviewLogs,
  type PreviewState,
} from '@kermanych/core';

export type PreviewTone = 'idle' | 'busy' | 'ok' | 'error';
export type PreviewStatusView = { key: string; params: Record<string, string | number>; tone: PreviewTone };

// A preview that is starting or running wins over the config: the file may have changed under
// a running preview, and the row must still say what runs. Otherwise a missing or broken file is
// what the operator has to act on next, ahead of how the last run ended. Null until the config
// has been read (the row shows a skeleton, not a guess).
export function previewStatusView(state: PreviewState | null, config: PreviewConfigStatus | undefined): PreviewStatusView | null {
  if (state?.phase === 'starting') {
    if (state.step === PREVIEW_SETUP_STEP) return { key: 'setup', params: {}, tone: 'busy' };
    // Clone + boot (up to 3 min), and the platform's build-and-install command (up to 20 min):
    // the two long waits of a Mobile start, each named for what it is rather than as a service.
    if (state.step === PREVIEW_DEVICE_STEP) return { key: 'device', params: {}, tone: 'busy' };
    if (state.step === PREVIEW_INSTALL_STEP) return { key: 'install', params: {}, tone: 'busy' };
    return { key: 'starting', params: { service: state.step }, tone: 'busy' };
  }
  if (state?.phase === 'running') {
    // The app exited while the device and services keep running (decision 11): not a crash of
    // the preview, but the operator has to act on it, so it reads red.
    if (state.app === 'exited') return { key: 'appExited', params: {}, tone: 'error' };
    return { key: 'running', params: {}, tone: 'ok' };
  }
  if (!config) return null;
  if (config.kind === 'missing') return { key: 'missing', params: {}, tone: 'idle' };
  if (config.kind === 'invalid') return { key: 'invalid', params: { error: config.error }, tone: 'error' };
  if (state?.phase === 'crashed') {
    return state.code !== null
      ? { key: 'crashed', params: { service: state.step, code: state.code }, tone: 'error' }
      : { key: 'crashedSignal', params: { service: state.step, signal: state.signal ?? '?' }, tone: 'error' };
  }
  if (state?.phase === 'failed') return { key: 'failed', params: { step: state.step, error: state.error }, tone: 'error' };
  if (state?.phase === 'stopped') return { key: 'stopped', params: {}, tone: 'idle' };
  return { key: 'idle', params: {}, tone: 'idle' };
}

// The tab's mark: a spinner while starting, green while running, red after a crash, a failed
// start, or an app that exited under a running Mobile preview; nothing when stopped or never
// started.
export function previewTabStatus(state: PreviewState | null | undefined): 'busy' | 'ok' | 'error' | undefined {
  if (state?.phase === 'starting') return 'busy';
  if (state?.phase === 'running') return state.app === 'exited' ? 'error' : 'ok';
  if (state?.phase === 'crashed' || state?.phase === 'failed') return 'error';
  return undefined;
}

// The api keeps the last 2 000 lines per step; the panel never holds more.
export const PREVIEW_LOG_LIMIT = 2_000;

export type PreviewLogBuffer = { run: number; lines: PreviewLogLine[]; next: number };

// Fold one poll answer into a step's buffer. A new `run` (the preview was started again) starts
// the buffer over: the old run's lines belong to a preview that no longer exists.
export function mergePreviewLogs(prev: PreviewLogBuffer | undefined, res: PreviewLogs): PreviewLogBuffer {
  if (!prev || prev.run !== res.run) return { run: res.run, lines: res.lines.slice(-PREVIEW_LOG_LIMIT), next: res.next };
  if (!res.lines.length) return prev.next === res.next ? prev : { ...prev, next: res.next };
  const lines = prev.lines.concat(res.lines);
  return { run: res.run, lines: lines.length > PREVIEW_LOG_LIMIT ? lines.slice(-PREVIEW_LOG_LIMIT) : lines, next: res.next };
}
