// apps/ui/src/lib/voice-gate.ts
// The voice conversation's noise gate (docs/specs/2026-11-04-voice-background-noise.md,
// decision 4): GPT-Live hears the microphone only while it is louder than a threshold. A voice
// close to the microphone is louder than a TV across the room or the neighbours. Pure: the audio
// worklet (voice-gate.worklet.ts) runs it on every audio block; it imports nothing else, so the
// worklet bundle stays this file.

/** The loudness of a block of samples, 0…1: RMS scaled so that normal speech fills most of it. */
export function levelOf(samples: Float32Array): number {
  let sum = 0;
  for (const s of samples) sum += s * s;
  return Math.min(1, Math.sqrt(sum / (samples.length || 1)) * 6);
}

/** The thresholds the operator picks from, on `levelOf`'s scale; `off` passes everything. */
export const VOICE_GATE_LEVELS = { off: 0, low: 0.04, medium: 0.08, high: 0.15 } as const;
export type VoiceGateLevel = keyof typeof VOICE_GATE_LEVELS;
export const DEFAULT_VOICE_GATE: VoiceGateLevel = 'medium';

export function isVoiceGateLevel(v: unknown): v is VoiceGateLevel {
  return typeof v === 'string' && Object.hasOwn(VOICE_GATE_LEVELS, v);
}

// Once open, the gate stays open while the level is above this share of the threshold — the soft
// end of a word — and for GATE_HOLD_MS after it fell below, so pauses between words are not cut.
export const GATE_KEEP_SHARE = 0.6;
export const GATE_HOLD_MS = 500;
// How fast the gain follows: opening must not swallow the first syllable, closing must not click.
export const GATE_ATTACK_MS = 5;
export const GATE_RELEASE_MS = 80;

export type GateState = { open: boolean; lastLoudAt: number; gain: number };

export const GATE_START: GateState = { open: false, lastLoudAt: Number.NEGATIVE_INFINITY, gain: 0 };

/** One block of `dtMs` ending at `now`: whether the gate is open and the gain at the block's end. */
export function gateStep(state: GateState, level: number, now: number, dtMs: number, threshold: number): GateState {
  if (threshold <= 0) return { open: true, lastLoudAt: now, gain: 1 };
  const loud = level >= (state.open ? threshold * GATE_KEEP_SHARE : threshold);
  const lastLoudAt = loud ? now : state.lastLoudAt;
  const open = loud || (state.open && now - lastLoudAt < GATE_HOLD_MS);
  const gain = open
    ? Math.min(1, state.gain + dtMs / GATE_ATTACK_MS)
    : Math.max(0, state.gain - dtMs / GATE_RELEASE_MS);
  return { open, lastLoudAt, gain };
}
