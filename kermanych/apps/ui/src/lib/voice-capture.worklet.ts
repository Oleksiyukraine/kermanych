// apps/ui/src/lib/voice-capture.worklet.ts
// Dictation's microphone tap on the audio thread (docs/specs/2026-11-14-local-voice-dictation.md,
// decision 10): the raw PCM the local recogniser transcribes. A worklet, not a ScriptProcessor or a
// timer in the window: those are deprecated or throttled while Kermanych is in the background.
// Loaded by lib/voice-capture.ts with `audioWorklet.addModule`; imports nothing, so the worklet
// bundle stays this file.
//
// Port: out — a Float32Array of ~100 ms of samples at the context's rate, transferred.

// The AudioWorkletGlobalScope, which the dom lib does not describe.
declare const sampleRate: number;
declare function registerProcessor(name: string, ctor: new () => object): void;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
  constructor();
}

class VoiceCapture extends AudioWorkletProcessor {
  // The render quantum is 128 samples; posting each would be ~125 messages a second.
  // Kept apart from `block`: transferring a block detaches its buffer, and a detached
  // Float32Array reads length 0 — sizing the next block from it would spin `process` forever
  // on the audio thread and hang the whole window.
  private readonly size = Math.round(sampleRate / 10);
  private block = new Float32Array(this.size);
  private filled = 0;

  process(inputs: Float32Array[][]): boolean {
    const input = inputs[0]?.[0];
    if (!input) return true;
    let from = 0;
    while (from < input.length) {
      const n = Math.min(input.length - from, this.size - this.filled);
      this.block.set(input.subarray(from, from + n), this.filled);
      this.filled += n;
      from += n;
      if (this.filled === this.size) {
        this.port.postMessage(this.block, [this.block.buffer]);
        this.block = new Float32Array(this.size);
        this.filled = 0;
      }
    }
    return true;
  }
}

registerProcessor('kermanych-voice-capture', VoiceCapture);
