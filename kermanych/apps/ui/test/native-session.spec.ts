import { describe, expect, it } from 'vitest';
import type { TerminalInfo } from '@kermanych/core';
import { nativeRuntimeFor, panelTerminals, sessionCostKnown, sessionLaunchMode } from '../src/lib/native-session';

describe('nativeRuntimeFor', () => {
  it('maps the launcher mode to from-task `native`', () => {
    expect(nativeRuntimeFor('managed')).toBeUndefined();
    expect(nativeRuntimeFor('omp')).toBe('omp');
    expect(nativeRuntimeFor('claude')).toBe('claude-code');
  });
});

describe('sessionLaunchMode', () => {
  it('names the harness that runs the session', () => {
    expect(sessionLaunchMode({ native: true, runtime: 'claude-code' })).toBe('claude');
    expect(sessionLaunchMode({ native: true, runtime: 'omp' })).toBe('omp');
    // A native row written before `runtime` was stamped ran the default harness.
    expect(sessionLaunchMode({ native: true })).toBe('omp');
  });

  it('is Kermanych for a managed session, whatever runtime it drives', () => {
    expect(sessionLaunchMode({ runtime: 'claude-code' })).toBe('managed');
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
  it('is unknown only for a native claude session', () => {
    expect(sessionCostKnown({ native: true, runtime: 'claude-code' })).toBe(false);
    expect(sessionCostKnown({ native: true, runtime: 'omp' })).toBe(true);
    expect(sessionCostKnown({ runtime: 'claude-code' })).toBe(true);
  });
});
