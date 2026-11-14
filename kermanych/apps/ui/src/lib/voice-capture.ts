// apps/ui/src/lib/voice-capture.ts
// The microphone for local dictation (docs/specs/2026-11-14-local-voice-dictation.md,
// decision 10): 16 kHz mono PCM through an AudioWorklet, plus its loudness, with no WebRTC and no
// server in between — the phrases go to the local recogniser as WAV files (lib/wav.ts).
//
// Kept apart from stores/dictation.ts so the store's logic can be tested with a scripted capture:
// nothing here decides anything, it only moves samples.
import { STT_SAMPLE_RATE } from '@kermanych/core';
import { levelOf } from './voice-gate';
import captureWorkletUrl from './voice-capture.worklet.ts?worker&url';

export interface VoiceCapture {
  /** The microphone's loudness in the latest ~100 ms block, 0…1 (`levelOf`'s scale). */
  level(): number;
  /** Drains the samples captured since the last call, at `STT_SAMPLE_RATE`. */
  take(): Float32Array;
  /** Stops the microphone and the audio graph. */
  close(): void;
}

export type OpenCapture = () => Promise<VoiceCapture>;

export const openCapture: OpenCapture = async () => {
  let mic: MediaStream | undefined;
  let ctx: AudioContext | undefined;
  const teardown = () => {
    mic?.getTracks().forEach((track) => track.stop());
    void ctx?.close().catch(() => {});
  };

  let blocks: Float32Array[] = [];
  let latest = 0;
  let closed = false;
  try {
    // The desktop app asks macOS first, as lib/voice-connection.ts does: Chromium alone gets a
    // silent refusal once the operator said no in System Settings.
    if (window.kermanych?.voice && !(await window.kermanych.voice.requestMic()))
      throw new DOMException('microphone refused in System Settings', 'NotAllowedError');
    mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    // The context runs at the recogniser's rate, so Chromium resamples the microphone for us.
    ctx = new AudioContext({ sampleRate: STT_SAMPLE_RATE });
    await ctx.audioWorklet.addModule(captureWorkletUrl);
    // No outputs: a sink the graph pulls on its own, nothing is played back.
    const tap = new AudioWorkletNode(ctx, 'kermanych-voice-capture', { numberOfOutputs: 0 });
    tap.port.onmessage = ({ data }: MessageEvent<Float32Array>) => {
      if (closed) return;
      blocks.push(data);
      latest = levelOf(data);
    };
    ctx.createMediaStreamSource(mic).connect(tap);
  } catch (e) {
    teardown();
    throw e;
  }

  return {
    level: () => latest,
    take() {
      const out = new Float32Array(blocks.reduce((n, b) => n + b.length, 0));
      let at = 0;
      for (const b of blocks) {
        out.set(b, at);
        at += b.length;
      }
      blocks = [];
      return out;
    },
    close() {
      closed = true;
      blocks = [];
      teardown();
    },
  };
};
