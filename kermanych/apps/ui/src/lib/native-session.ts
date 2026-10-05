// Native sessions (docs/specs/2026-10-05-native-sessions.md): the harness runs as its own
// TUI in a pty; the UI only picks the mode at launch and hosts the session's terminal.
import type { AgentRuntimeKind, Session, TerminalInfo } from '@kermanych/core';

// The launcher's «Режим»: Kermanych's managed session, or one of the harnesses' own TUI.
export type LaunchMode = 'managed' | 'omp' | 'claude';
export const LAUNCH_MODES: readonly LaunchMode[] = ['managed', 'omp', 'claude'];

// The `native` field of `POST /sessions/from-task`; undefined launches a managed session.
export function nativeRuntimeFor(mode: LaunchMode): AgentRuntimeKind | undefined {
  if (mode === 'omp') return 'omp';
  if (mode === 'claude') return 'claude-code';
  return undefined;
}

// The command the operator knows the harness by: `claude`, not the runtime id `claude-code`.
export function nativeHarnessName(runtime: AgentRuntimeKind): string {
  return runtime === 'claude-code' ? 'claude' : runtime;
}

// A session's pty belongs to its Лог tab; the project panel shows only the project's shells.
export function panelTerminals(list: readonly TerminalInfo[], projectId: string | undefined): TerminalInfo[] {
  return projectId ? list.filter((t) => t.projectId === projectId && !t.sessionId) : [];
}

// claude does not write cost into its transcript, so a native claude session's cost is unknown.
export function sessionCostKnown(s: Pick<Session, 'native' | 'runtime'>): boolean {
  return !(s.native && s.runtime === 'claude-code');
}
