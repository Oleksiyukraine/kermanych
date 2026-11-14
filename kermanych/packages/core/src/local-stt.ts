// The local recogniser behind voice dictation (docs/specs/2026-11-14-local-voice-dictation.md):
// which engine runs on which platform (decision 4), the model files it downloads on demand
// (decision 5), and the shapes the api and the ui exchange about it.

export type SttEngine = "whisper" | "parakeet";

export type SttModelFile = { name: string; url: string; bytes: number; sha256: string };

export type SttModel = {
  engine: SttEngine;
  /** The folder under ~/.kermanych/models/ the files land in. */
  id: string;
  files: readonly SttModelFile[];
};

const PARAKEET_HF = "https://huggingface.co/csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8/resolve/main";

export const STT_MODELS: Record<SttEngine, SttModel> = {
  // whisper.cpp large-v3-turbo, q8_0: the comparison's best on long free speech, Metal on macOS.
  whisper: {
    engine: "whisper",
    id: "whisper-large-v3-turbo-q8_0",
    files: [
      {
        name: "ggml-large-v3-turbo-q8_0.bin",
        url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo-q8_0.bin",
        bytes: 874_188_075,
        sha256: "317eb69c11673c9de1e1f0d459b253999804ec71ac4c23c17ecf5fbe24e259a1",
      },
    ],
  },
  // NVIDIA Parakeet TDT 0.6B v3 (25 European languages incl. Ukrainian), int8, via sherpa-onnx.
  parakeet: {
    engine: "parakeet",
    id: "parakeet-tdt-0.6b-v3-int8",
    files: [
      { name: "encoder.int8.onnx", url: `${PARAKEET_HF}/encoder.int8.onnx`, bytes: 652_282_294, sha256: "1afbe69c1ffdabee94755f42e4daf1d93549131a3da11356bda84fcef0f2c479" },
      { name: "decoder.int8.onnx", url: `${PARAKEET_HF}/decoder.int8.onnx`, bytes: 11_845_274, sha256: "0222a86147299d4dee90edf95b6d13827edb42ad8b7c9cf0b2582f030937c0b5" },
      { name: "joiner.int8.onnx", url: `${PARAKEET_HF}/joiner.int8.onnx`, bytes: 6_355_277, sha256: "cbd02f3696e9944970111fb439d9c3fd365a80374565f13f2b9c7007d253fc98" },
      { name: "tokens.txt", url: `${PARAKEET_HF}/tokens.txt`, bytes: 93_939, sha256: "d58544679ea4bc6ac563d1f545eb7d474bd6cfa467f0a6e2c1dc1c7d37e3c35d" },
    ],
  },
};

export function sttModelBytes(model: SttModel): number {
  return model.files.reduce((sum, f) => sum + f.bytes, 0);
}

/** Decision 4: the platform decides — Whisper on macOS (Metal), Parakeet elsewhere. */
export function sttEngineFor(platform: string): SttEngine {
  return platform === "darwin" ? "whisper" : "parakeet";
}

/** What `GET /api/voice/model` answers. */
export type SttModelStatus = {
  engine: SttEngine;
  /** All files in total, for the «Завантажити (874 МБ)» label. */
  totalBytes: number;
  state: "absent" | "downloading" | "ready";
  /** While downloading: bytes on disk so far, across all files. */
  receivedBytes?: number;
  /** The last download's failure, until the next attempt. */
  error?: string;
};

// Decision 9: the loaded model (~1 GB of RAM) is released after this long without a phrase.
export const STT_UNLOAD_MS = 600_000;

// One phrase's WAV (16 kHz mono 16-bit) is at most two minutes: anything larger is not one.
export const STT_MAX_WAV_BYTES = 44 + 16_000 * 2 * 120;
export const STT_SAMPLE_RATE = 16_000;
