// Native sessions (docs/specs/2026-10-05-native-sessions.md): the harness runs as its own
// TUI in a pty; the UI only picks the mode at launch and hosts the session's terminal.
import { providerHarness, type AgentProvider, type NativeHarness, type Session, type TerminalInfo } from '@kermanych/core';

// The launcher's «Режим»: Kermanych's managed session, or one of the harnesses' own TUI.
export type LaunchMode = 'managed' | 'omp' | 'claude' | 'codex';
export const LAUNCH_MODES: readonly LaunchMode[] = ['managed', 'omp', 'claude', 'codex'];

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

// The mode a launch takes when the operator does not pick one, and the mode the launcher and
// the «Чат» chip open with (docs/specs/2026-11-05-remove-managed-claude-code.md, decision 4):
// the provider's — omp is «Керманич», claude and codex their own TUI; unset is «Керманич». A
// card that continues a «Синергія» prototype is always «Керманич»: the «Синергія» page renders only
// a managed session (docs/specs/2026-11-09-merge-design-into-synergy.md, decision 5).
export function defaultLaunchMode(provider: AgentProvider | null | undefined, opts: { synergy?: boolean } = {}): LaunchMode {
  if (opts.synergy) return 'managed';
  const harness = providerHarness(provider);
  return harness ? HARNESS_MODE[harness] : 'managed';
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

// The label of the Сесія tab's engine-id row: the harness whose `--resume` the id feeds. A
// managed session's row shows a Claude Code conversation id, as does a native claude one.
const ENGINE_ID_LABEL: Record<LaunchMode, string> = {
  managed: 'agents.session.engineId',
  claude: 'agents.session.engineId',
  omp: 'agents.native.engineIdOmp',
  codex: 'agents.native.engineIdCodex',
};

export function engineIdLabelKey(s: Pick<Session, 'native' | 'runtime'>): string {
  return ENGINE_ID_LABEL[sessionLaunchMode(s)];
}
