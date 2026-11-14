// apps/api/src/voice/stt-engine.ts
// One local recogniser behind LocalSttService (docs/specs/2026-11-14-local-voice-dictation.md,
// decision 9): load the model, turn one phrase into text, release the model. The service owns
// when each happens (warm on 🎤, idle unload, one phrase at a time); an engine only knows how.
import type { SttEngine } from "@kermanych/core";

/** One phrase, already validated: a 16 kHz mono 16-bit WAV and its PCM body. */
export type SttPhrase = {
  /** The whole WAV file, header included: what whisper-server takes. */
  wav: Buffer;
  /** The `data` chunk: little-endian signed 16-bit samples, what sherpa-onnx decodes. */
  pcm: Buffer;
  /** Whisper's language code (`isDictationLanguage`); an engine that auto-detects ignores it. */
  language: string;
};

export interface SttRunner {
  /** Loads the model; rejects with an operator-readable reason. */
  load(): Promise<void>;
  /** The raw recognised text; the service trims and filters it. Called only after `load`. */
  transcribe(phrase: SttPhrase): Promise<string>;
  /** Releases the model and whatever runs it; safe mid-load and when already unloaded. */
  unload(): Promise<void>;
}

/** Builds the engine for `engine` over the model files in `modelDir`. */
export type SttRunnerFactory = (engine: SttEngine, modelDir: string) => SttRunner;
