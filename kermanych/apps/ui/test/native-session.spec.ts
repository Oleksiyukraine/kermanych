import { describe, expect, it } from 'vitest';
import type { TerminalInfo } from '@kermanych/core';
import { defaultLaunchMode, engineIdLabelKey, nativeRuntimeFor, panelTerminals, sessionCostKnown, sessionLaunchMode } from '../src/lib/native-session';

describe('nativeRuntimeFor', () => {
  it('maps the launcher mode to from-task `native`', () => {
    expect(nativeRuntimeFor('managed')).toBeUndefined();
    expect(nativeRuntimeFor('omp')).toBe('omp');
    expect(nativeRuntimeFor('claude')).toBe('claude-code');
    expect(nativeRuntimeFor('codex')).toBe('codex');
  });
});

describe('defaultLaunchMode', () => {
  it('follows the provider for an ordinary card', () => {
    expect(defaultLaunchMode('omp')).toBe('managed');
    expect(defaultLaunchMode('claude-code')).toBe('claude');
    expect(defaultLaunchMode('codex')).toBe('codex');
    expect(defaultLaunchMode(null)).toBe('managed');
    expect(defaultLaunchMode(undefined)).toBe('managed');
    expect(defaultLaunchMode('claude-code', { synergy: false })).toBe('claude');
  });

  it('is «Керманич» for a card that continues a Синергія prototype whatever the provider', () => {
    for (const provider of ['omp', 'claude-code', 'codex', null, undefined] as const) {
      expect(defaultLaunchMode(provider, { synergy: true })).toBe('managed');
    }
  });
});

describe('sessionLaunchMode', () => {
  it('names the harness that runs the session', () => {
    expect(sessionLaunchMode({ native: true, runtime: 'claude-code' })).toBe('claude');
    expect(sessionLaunchMode({ native: true, runtime: 'omp' })).toBe('omp');
    expect(sessionLaunchMode({ native: true, runtime: 'codex' })).toBe('codex');
    // A native row written before `runtime` was stamped ran the default harness.
    expect(sessionLaunchMode({ native: true })).toBe('omp');
  });

  it('is Kermanych for a managed session', () => {
    expect(sessionLaunchMode({ runtime: 'omp' })).toBe('managed');
    expect(sessionLaunchMode({ native: false, runtime: 'omp' })).toBe('managed');
  });
});

describe('panelTerminals', () => {
  const term = (id: string, projectId: string, sessionId?: string) =>
    ({ id, projectId, shell: 'zsh', cwd: '/', ...(sessionId ? { sessionId } : {}) }) as unknown as TerminalInfo;
  const list = [term('a', 'p1'), term('s', 'p1', 'sess'), term('b', 'p2')];

  it("lists only the project's own shells, never a session's pty", () => {
    expect(panelTerminals(list, 'p1').map((t) => t.id)).toEqual(['a']);
  });

  it('is empty without a project', () => {
    expect(panelTerminals(list, undefined)).toEqual([]);
  });
});

describe('sessionCostKnown', () => {
  it('is unknown only for a native claude or codex session', () => {
    expect(sessionCostKnown({ native: true, runtime: 'codex' })).toBe(false);
    expect(sessionCostKnown({ native: true, runtime: 'claude-code' })).toBe(false);
    expect(sessionCostKnown({ native: true, runtime: 'omp' })).toBe(true);
    expect(sessionCostKnown({ runtime: 'omp' })).toBe(true);
  });
});

describe('engineIdLabelKey', () => {
  it('names the harness whose session the engine id row shows', () => {
    expect(engineIdLabelKey({ native: true, runtime: 'omp' })).toBe('agents.native.engineIdOmp');
    // A native row written before `runtime` was stamped ran omp.
    expect(engineIdLabelKey({ native: true })).toBe('agents.native.engineIdOmp');
    expect(engineIdLabelKey({ native: true, runtime: 'codex' })).toBe('agents.native.engineIdCodex');
    expect(engineIdLabelKey({ native: true, runtime: 'claude-code' })).toBe('agents.session.engineId');
  });

  it('keeps the Claude Code label for a managed session', () => {
    expect(engineIdLabelKey({ runtime: 'claude-code' })).toBe('agents.session.engineId');
  });
});
