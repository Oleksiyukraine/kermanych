// Native sessions (docs/specs/2026-10-05-native-sessions.md): the harness runs as its own
// TUI in a pty; the UI only picks the mode at launch and hosts the session's terminal.
import type { NativeHarness, Session, TerminalInfo } from '@kermanych/core';

// The launcher's «Режим»: Kermanych's managed session, or one of the harnesses' own TUI.
export type LaunchMode = 'managed' | 'omp' | 'claude' | 'codex';
export const LAUNCH_MODES: readonly LaunchMode[] = ['managed', 'omp', 'claude', 'codex'];

// The mode last picked in the launcher, which the next launcher opens with. A device-local
// screen preference like the locale (lib/locale.ts): localStorage, never Supabase, and every
// access guarded — an unreadable or unknown value falls back to `managed`.
const LAUNCH_MODE_KEY = 'kermanych.launcher.mode';

export function readLaunchMode(): LaunchMode {
  try {
    const v = typeof localStorage === 'undefined' ? null : localStorage.getItem(LAUNCH_MODE_KEY);
    return (LAUNCH_MODES as readonly string[]).includes(v ?? '') ? (v as LaunchMode) : 'managed';
  } catch {
    return 'managed';
  }
}

export function writeLaunchMode(mode: LaunchMode): void {
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(LAUNCH_MODE_KEY, mode);
  } catch {
    // storage refused: the pick holds until the launcher closes
  }
}

const HARNESS_MODE: Record<NativeHarness, Exclude<LaunchMode, 'managed'>> = {
  omp: 'omp',
  'claude-code': 'claude',
  codex: 'codex',
};

const MODE_HARNESS: Record<LaunchMode, NativeHarness | undefined> = {
  managed: undefined,
  omp: 'omp',
  claude: 'claude-code',
  codex: 'codex',
};

// The `native` field of `POST /sessions/from-task` and `POST /sessions/chat`; undefined
// launches a managed session.
export function nativeRuntimeFor(mode: LaunchMode): NativeHarness | undefined {
  return MODE_HARNESS[mode];
}

// The command the operator knows the harness by: `claude`, not the runtime id `claude-code`.
export function nativeHarnessName(runtime: NativeHarness): string {
  return HARNESS_MODE[runtime];
}

// The harness a session runs under, in the launcher's own terms: a managed session is
// Kermanych's whatever its `runtime`, a native one is the harness `runtime` names.
export function sessionLaunchMode(s: Pick<Session, 'native' | 'runtime'>): LaunchMode {
  if (!s.native) return 'managed';
  return HARNESS_MODE[s.runtime ?? 'omp'];
}

// A session's pty belongs to its Лог tab; the project panel shows only the project's shells.
export function panelTerminals(list: readonly TerminalInfo[], projectId: string | undefined): TerminalInfo[] {
  return projectId ? list.filter((t) => t.projectId === projectId && !t.sessionId) : [];
}

// claude and codex do not write cost into their transcripts, so a native claude or codex
// session's cost is unknown.
export function sessionCostKnown(s: Pick<Session, 'native' | 'runtime'>): boolean {
  return !(s.native && (s.runtime === 'claude-code' || s.runtime === 'codex'));
}
