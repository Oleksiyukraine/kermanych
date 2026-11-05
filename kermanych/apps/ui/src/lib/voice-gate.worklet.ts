// apps/ui/src/lib/voice-gate.worklet.ts
// The noise gate on the audio thread (docs/specs/2026-11-04-voice-background-noise.md, decision 4).
// A worklet, not a timer in the window: the window's timers are throttled while Kermanych is in the
// background, and the operator often talks to the agent while looking at another app. Loaded by
// lib/voice-connection.ts with `audioWorklet.addModule`; the decision is lib/voice-gate.ts.
//
// Port: in — `{ threshold }`; out — `{ open }` whenever it changes, for the voice bar.
import { GATE_START, gateStep, levelOf, type GateState } from './voice-gate';

// The AudioWorkletGlobalScope, which the dom lib does not describe.
declare const sampleRate: number;
declare const currentTime: number;
declare function registerProcessor(name: string, ctor: new (options: { processorOptions?: { threshold?: number } }) => object): void;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
  constructor();
}

class VoiceGate extends AudioWorkletProcessor {
  private state: GateState = GATE_START;
  private threshold: number;

  constructor(options: { processorOptions?: { threshold?: number } }) {
    super();
    this.threshold = options.processorOptions?.threshold ?? 0;
    this.port.onmessage = ({ data }: MessageEvent<{ threshold?: number }>) => {
      if (typeof data.threshold === 'number') this.threshold = data.threshold;
    };
  }

  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const input = inputs[0]?.[0];
    const output = outputs[0]?.[0];
    if (!input || !output) return true;
    const before = this.state;
    const dtMs = (input.length / sampleRate) * 1000;
    this.state = gateStep(before, levelOf(input), currentTime * 1000, dtMs, this.threshold);
    // The gain glides across the block, so a change never clicks.
    const step = (this.state.gain - before.gain) / input.length;
    for (let i = 0; i < input.length; i++) output[i] = input[i]! * (before.gain + step * (i + 1));
    if (this.state.open !== before.open) this.port.postMessage({ open: this.state.open });
    return true;
  }
}

registerProcessor('kermanych-voice-gate', VoiceGate);
