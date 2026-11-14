// apps/api/src/voice/sherpa-parakeet.engine.ts
// Parakeet on Linux (docs/specs/2026-11-14-local-voice-dictation.md, decision 4): NVIDIA
// Parakeet TDT 0.6B v3 (int8) through sherpa-onnx's N-API addon. Recognition is CPU-bound for
// hundreds of milliseconds per phrase, so the recogniser lives in a worker thread and the api's
// event loop never blocks on it (decision 9). The language is not passed: Parakeet detects it,
// and it takes no prompt (decision 12).
import { createRequire } from "node:module";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { STT_SAMPLE_RATE } from "@kermanych/core";
import type { SttPhrase, SttRunner } from "./stt-engine";

// The worker's whole program. Inline (`eval`) rather than a file beside this one: the api ships
// inside the app's asar, and the addon is required by the absolute path resolved here, so the
// worker needs nothing of the api's own layout.
const WORKER_SOURCE = `
const { parentPort, workerData } = require("node:worker_threads");
const sherpa = require(workerData.module);
const recognizer = new sherpa.OfflineRecognizer(workerData.config);
parentPort.postMessage({ ready: true });
parentPort.on("message", ({ id, samples }) => {
  try {
    const stream = recognizer.createStream();
    stream.acceptWaveform({ samples, sampleRate: workerData.sampleRate });
    recognizer.decode(stream);
    parentPort.postMessage({ id, text: recognizer.getResult(stream).text });
  } catch (err) {
    parentPort.postMessage({ id, error: String((err && err.message) || err) });
  }
});
`;

type Reply = { ready?: true; id?: number; text?: string; error?: string };
type Pending = { resolve: (text: string) => void; reject: (err: Error) => void };

export class SherpaParakeetEngine implements SttRunner {
  private worker?: Worker;
  private nextId = 0;
  private readonly pending = new Map<number, Pending>();
  // Rejects the load still in progress (a no-op once it resolved): a crash or an unload mid-load.
  private rejectLoad?: (err: Error) => void;

  constructor(private readonly modelDir: string) {}

  load(): Promise<void> {
    // Resolved only now: a platform without the addon's prebuild fails when Parakeet is used,
    // never when the api starts.
    let module: string;
    try {
      // A worker thread may not get Electron's asar redirect for fs and dlopen, so it requires
      // the real files: the packaged app unpacks sherpa-onnx-* beside the asar (quasar.config.ts
      // asarUnpack). Outside the packaged app the path has no `app.asar` and stays as it is.
      module = createRequire(__filename)
        .resolve("sherpa-onnx-node")
        .replace(/([\\/])app\.asar([\\/])/, "$1app.asar.unpacked$2");
    } catch {
      return Promise.reject(new Error("sherpa-onnx-node недоступний у цій збірці."));
    }
    const config = {
      featConfig: { sampleRate: STT_SAMPLE_RATE, featureDim: 80 },
      modelConfig: {
        transducer: {
          encoder: join(this.modelDir, "encoder.int8.onnx"),
          decoder: join(this.modelDir, "decoder.int8.onnx"),
          joiner: join(this.modelDir, "joiner.int8.onnx"),
        },
        tokens: join(this.modelDir, "tokens.txt"),
        modelType: "nemo_transducer",
        numThreads: 4,
        provider: "cpu",
        debug: 0,
      },
    };
    const worker = new Worker(WORKER_SOURCE, { eval: true, workerData: { module, config, sampleRate: STT_SAMPLE_RATE } });
    this.worker = worker;
    const { promise: ready, resolve, reject } = Promise.withResolvers<void>();
    this.rejectLoad = reject;
    worker.on("message", (m: Reply) => {
      if (m.ready) return resolve();
      if (m.id === undefined) return;
      const p = this.pending.get(m.id);
      this.pending.delete(m.id);
      if (m.error !== undefined) p?.reject(new Error(`sherpa-onnx: ${m.error}`));
      else p?.resolve(m.text ?? "");
    });
    // A throw while loading (a missing addon, a broken model file) and a crash later both end
    // here: the load and every phrase still waiting fail with the reason.
    worker.once("error", (err) => this.fail(worker, `sherpa-onnx: ${err.message}`));
    worker.once("exit", (code) => this.fail(worker, `sherpa-onnx завершився (код ${code}).`));
    return ready;
  }

  transcribe(phrase: SttPhrase): Promise<string> {
    const worker = this.worker;
    if (!worker) return Promise.reject(new Error("Модель Parakeet не завантажена."));
    // Moved to the worker, not copied: a two-minute phrase is ~8 MB of floats.
    const buffer = new ArrayBuffer((phrase.pcm.length >> 1) * 4);
    const samples = new Float32Array(buffer);
    for (let i = 0; i < samples.length; i++) samples[i] = phrase.pcm.readInt16LE(i * 2) / 32768;
    const id = this.nextId++;
    const { promise, resolve, reject } = Promise.withResolvers<string>();
    this.pending.set(id, { resolve: (text) => resolve(text.replaceAll("<unk>", "")), reject });
    worker.postMessage({ id, samples }, [buffer]);
    return promise;
  }

  async unload(): Promise<void> {
    const worker = this.worker;
    if (!worker) return;
    this.fail(worker, "Модель Parakeet вивантажено.");
    await worker.terminate();
  }

  private fail(worker: Worker, reason: string): void {
    if (this.worker !== worker) return;
    this.worker = undefined;
    const err = new Error(reason);
    this.rejectLoad?.(err);
    this.rejectLoad = undefined;
    for (const p of this.pending.values()) p.reject(err);
    this.pending.clear();
  }
}
