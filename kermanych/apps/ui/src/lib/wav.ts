// apps/ui/src/lib/wav.ts
// A dictated phrase as the file the local recogniser reads
// (docs/specs/2026-11-14-local-voice-dictation.md, decision 10): 16-bit PCM mono WAV, sent as
// base64 in `POST /api/voice/transcribe`. Pure, apart from lib/voice-capture.ts, so the dictation
// store's tests run the real encoding.

/** A mono 16-bit PCM WAV of `samples` (−1…1, clipped) at `rate`. */
export function encodeWav(samples: Float32Array, rate: number): ArrayBuffer {
  const out = new ArrayBuffer(44 + samples.length * 2);
  const v = new DataView(out);
  const ascii = (at: number, s: string) => {
    for (let i = 0; i < s.length; i++) v.setUint8(at + i, s.charCodeAt(i));
  };
  ascii(0, 'RIFF');
  v.setUint32(4, 36 + samples.length * 2, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  v.setUint32(16, 16, true); // fmt chunk size
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, 1, true); // mono
  v.setUint32(24, rate, true);
  v.setUint32(28, rate * 2, true); // bytes per second
  v.setUint16(32, 2, true); // block align
  v.setUint16(34, 16, true); // bits per sample
  ascii(36, 'data');
  v.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]!));
    v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return out;
}

export function toBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let bin = '';
  // In slices: spreading a whole phrase into one call overflows the argument limit.
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
