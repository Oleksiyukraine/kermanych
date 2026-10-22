import { describe, expect, it } from 'vitest';
import type { MachineAlert, MachineResources, ResourceLimits } from '@kermanych/core';
import { parseLimitCount, resourcesDraft, resourcesUpdate } from '../src/lib/settings';
import { machineAlertView, memorySize } from '../src/lib/machine-alert';
import { slotWaitLabel } from '../src/lib/slot-wait';

const profile: ResourceLimits = {
  agents: 5,
  subagents: 6,
  background: true,
  testWorkers: 4,
  lowerPriority: true,
  watchdog: true,
  watchdogAction: 'kill',
};

function machine(over: Partial<MachineResources> = {}): MachineResources {
  return {
    hardware: { ramBytes: 48 * 1024 ** 3, cores: 14, perfCores: 10, platform: 'darwin' },
    tier: 'strong',
    profile,
    overrides: { agents: 2 },
    effective: { ...profile, agents: 2 },
    decision: 'declined',
    askConsent: false,
    pressure: 1,
    watchdogSupported: true,
    overriddenBy: {},
    running: 0,
    waiting: 0,
    ...over,
  };
}

// Echoes the key and its params, so assertions read which message was picked and with what.
const t = (key: string, named?: Record<string, unknown>) => (named ? `${key} ${JSON.stringify(named)}` : key);

describe('resources draft', () => {
  it('shows the saved effective values and the stored decision as the switch', () => {
    expect(resourcesDraft(machine())).toEqual({ ...profile, agents: 2, applied: false });
  });

  it('«Налаштувати» offers the bare profile with the switch on', () => {
    expect(resourcesDraft(machine(), true)).toEqual({ ...profile, applied: true });
  });

  it('saves only values that differ from the profile as overrides', () => {
    const draft = { ...profile, applied: true, subagents: 2, background: false };
    expect(resourcesUpdate(draft, profile)).toEqual({
      decision: 'applied',
      overrides: { subagents: 2, background: false },
    });
  });

  it('a draft equal to the profile clears every override', () => {
    expect(resourcesUpdate({ ...profile, applied: false }, profile)).toEqual({ decision: 'declined', overrides: null });
  });

  it('count fields clamp to 1..64 and ignore text that is not a number yet', () => {
    expect(parseLimitCount('0')).toBe(1);
    expect(parseLimitCount('100')).toBe(64);
    expect(parseLimitCount('7')).toBe(7);
    expect(parseLimitCount('')).toBeNull();
  });
});

describe('machine alert view', () => {
  const base: MachineAlert = {
    id: 'a',
    level: 'warn',
    sessionId: 's1',
    sessionName: 'fix-login',
    command: 'npm test',
    pid: 42,
    rssBytes: 9 * 1024 ** 3,
    killed: false,
    at: 0,
  };

  it('a warn naming a session offers to stop its command', () => {
    const v = machineAlertView(base, t);
    expect(v.message).toContain('machineAlert.heavy');
    expect(v.message).toContain('9.0 GB');
    expect(v).toMatchObject({ kind: 'info', killable: true });
  });

  it('pressure not from an agent names nobody and offers nothing', () => {
    const v = machineAlertView({ id: 'b', level: 'warn', killed: false, at: 0 }, t);
    expect(v).toEqual({ message: 'machineAlert.notAgents', kind: 'info', killable: false });
  });

  it('a critical kill reports what the watchdog stopped, as an error', () => {
    const v = machineAlertView({ ...base, level: 'critical', killed: true }, t);
    expect(v.message).toContain('machineAlert.killed');
    expect(v).toMatchObject({ kind: 'error', killable: false });
  });

  it('a warn-level kill is the operator’s own stop: a plain confirmation', () => {
    const v = machineAlertView({ ...base, killed: true }, t);
    expect(v.message).toContain('machineAlert.stopped');
    expect(v).toMatchObject({ kind: 'info', killable: false });
  });

  it('critical without a kill keeps the warn wording at error severity', () => {
    const v = machineAlertView({ ...base, level: 'critical' }, t);
    expect(v.message).toContain('machineAlert.heavy');
    expect(v).toMatchObject({ kind: 'error', killable: true });
  });

  it('sizes below a gigabyte read in megabytes', () => {
    expect(memorySize(512 * 1024 ** 2)).toBe('512 MB');
  });
});

describe('slot wait label', () => {
  it('is absent for a session not waiting for a slot', () => {
    expect(slotWaitLabel({}, t)).toBeUndefined();
  });

  it('names the queue position only when someone is ahead', () => {
    expect(slotWaitLabel({ slotWait: { position: 1, running: 2, limit: 2 } }, t)).not.toContain('position');
    expect(slotWaitLabel({ slotWait: { position: 3, running: 2, limit: 2 } }, t)).toContain('agents.slotWait.position');
  });
});
