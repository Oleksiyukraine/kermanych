import { describe, expect, it } from 'vitest';
import { GATE_ATTACK_MS, GATE_HOLD_MS, GATE_KEEP_SHARE, GATE_START, gateStep, levelOf, type GateState } from '../src/lib/voice-gate';

// The voice conversation's noise gate (docs/specs/2026-11-04-voice-background-noise.md, decision 4):
// GPT-Live hears the microphone only while it is louder than the threshold.
const T = 0.08;
const BLOCK_MS = 128 / 48;

// Runs blocks of one level for `ms`, starting at `from`.
function run(state: GateState, level: number, from: number, ms: number): GateState {
  let s = state;
  for (let t = from + BLOCK_MS; t <= from + ms; t += BLOCK_MS) s = gateStep(s, level, t, BLOCK_MS, T);
  return s;
}

describe('gateStep', () => {
  it('stays shut for background quieter than the threshold', () => {
    const s = run(GATE_START, T * 0.9, 0, 2000);
    expect(s).toMatchObject({ open: false, gain: 0 });
  });

  it('opens fully within the attack time for a voice above it', () => {
    const s = run(GATE_START, T * 2, 0, GATE_ATTACK_MS + BLOCK_MS);
    expect(s).toMatchObject({ open: true, gain: 1 });
  });

  it('holds through a short pause and the soft end of a word, then closes', () => {
    const speaking = run(GATE_START, T * 2, 0, 200);
    expect(run(speaking, T * GATE_KEEP_SHARE, 200, 2000).open).toBe(true);
    const paused = run(speaking, 0, 200, GATE_HOLD_MS - 2 * BLOCK_MS);
    expect(paused).toMatchObject({ open: true, gain: 1 });
    const closed = run(paused, 0, 200 + GATE_HOLD_MS - 2 * BLOCK_MS, 300);
    expect(closed).toMatchObject({ open: false, gain: 0 });
  });

  it('passes everything when the threshold is off', () => {
    expect(gateStep(GATE_START, 0, 1, BLOCK_MS, 0)).toMatchObject({ open: true, gain: 1 });
  });
});

describe('levelOf', () => {
  it('reads silence as 0 and a full-scale signal as 1', () => {
    expect(levelOf(new Float32Array(128))).toBe(0);
    expect(levelOf(new Float32Array(128).fill(0.5))).toBe(1);
  });
});
