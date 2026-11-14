// apps/api/src/voice/local-stt.service.ts
// Local voice dictation (docs/specs/2026-11-14-local-voice-dictation.md): the recognition model
// on this machine and the engine that runs it. The platform picks the engine (decision 4); the
// model is downloaded on demand into ~/.kermanych/models/ with resume and a sha256 check
// (decision 5); the engine loads when 🎤 is pressed and is released after STT_UNLOAD_MS without a
// phrase (decision 9); a phrase whose whole text is a known Whisper invention comes back empty
// (decision 11). Nothing here talks to OpenAI.
import { Injectable, Optional, type OnModuleDestroy } from "@nestjs/common";
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import {
  STT_MAX_WAV_BYTES,
  STT_MODELS,
  STT_SAMPLE_RATE,
  STT_UNLOAD_MS,
  isDictationLanguage,
  isInventedPhrase,
  sttEngineFor,
  sttModelBytes,
  type SttEngine,
  type SttModel,
  type SttModelFile,
  type SttModelStatus,
} from "@kermanych/core";
import { CodedError } from "../management/coded-error";
import { SherpaParakeetEngine } from "./sherpa-parakeet.engine";
import type { SttPhrase, SttRunner, SttRunnerFactory } from "./stt-engine";
import { WhisperCppEngine } from "./whisper-cpp.engine";

type Fetch = (url: string, init: RequestInit) => Promise<Response>;

export type LocalSttOptions = {
  /** The models root; each model gets its own folder `STT_MODELS[engine].id` inside. */
  root?: string;
  fetch?: Fetch;
  platform?: string;
  env?: NodeJS.ProcessEnv;
  /** The manifest to download: specs hand in a tiny one instead of the 874 MB model. */
  model?: SttModel;
  engines?: SttRunnerFactory;
};

// Beside ~/.kermanych/resources and ~/.kermanych/children (runtime/child-ledger.ts), under the
// same override a test or a preview api sets.
export function sttModelsRoot(env: NodeJS.ProcessEnv = process.env): string {
  return join(env.KERMANYCH_SKILLS_HOME ?? join(homedir(), ".kermanych"), "models");
}

// Decision 4: the platform decides. KERMANYCH_STT_ENGINE overrides it for a developer and for
// the decision's fallback (Parakeet on macOS when whisper-server cannot ship).
export function sttEngineOf(platform: string, env: NodeJS.ProcessEnv): SttEngine {
  const forced = env.KERMANYCH_STT_ENGINE?.trim();
  return forced === "whisper" || forced === "parakeet" ? forced : sttEngineFor(platform);
}

const realEngines: SttRunnerFactory = (engine, dir) =>
  engine === "whisper" ? new WhisperCppEngine(join(dir, STT_MODELS.whisper.files[0].name)) : new SherpaParakeetEngine(dir);

// A base64 string longer than this cannot decode to a WAV within STT_MAX_WAV_BYTES.
const MAX_BASE64 = Math.ceil(STT_MAX_WAV_BYTES / 3) * 4;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

@Injectable()
export class LocalSttService implements OnModuleDestroy {
  readonly model: SttModel;
  private readonly dir: string;
  private readonly fetchFn: Fetch;
  private readonly engines: SttRunnerFactory;

  // The download running now. Its AbortController is the cancel; `done` settles once nothing
  // more is written, so a cancel or a delete never races a write.
  private run?: { abort: AbortController; done: Promise<void> };
  // The last download's failure, until the next attempt.
  private error?: string;
  private loaded?: { runner: SttRunner; ready: Promise<SttRunner> };
  // Phrases are recognised one at a time, in the order they arrived: the window keeps them in
  // speaking order anyway, and one engine on a machine shared with agents is not oversubscribed.
  private queue: Promise<unknown> = Promise.resolve();
  private busy = 0;
  private idle?: NodeJS.Timeout;

  // Test seams: specs hand in a root, a fetch, a manifest and an engine factory. @Optional so
  // Nest builds the real ones.
  constructor(@Optional() opts: LocalSttOptions = {}) {
    const env = opts.env ?? process.env;
    this.model = opts.model ?? STT_MODELS[sttEngineOf(opts.platform ?? process.platform, env)];
    this.dir = join(opts.root ?? sttModelsRoot(env), this.model.id);
    this.fetchFn = opts.fetch ?? ((url, init) => fetch(url, init));
    this.engines = opts.engines ?? realEngines;
  }

  async onModuleDestroy(): Promise<void> {
    this.run?.abort.abort();
    await this.run?.done;
    await this.unload();
  }

  // A file counts as there only under its final name, which it gets only after its sha256
  // matched; so «ready» needs no re-hash of a gigabyte on every poll.
  status(): SttModelStatus {
    const base = { engine: this.model.engine, totalBytes: sttModelBytes(this.model) };
    const error = this.error ? { error: this.error } : {};
    if (this.run) {
      const receivedBytes = this.model.files.reduce((sum, f) => sum + this.onDisk(f), 0);
      return { ...base, state: "downloading", receivedBytes, ...error };
    }
    if (this.model.files.every((f) => this.complete(f))) return { ...base, state: "ready" };
    return { ...base, state: "absent", ...error };
  }

  // Starts the download, or continues it from the bytes already on disk. Idempotent while one runs.
  download(): SttModelStatus {
    if (this.run || this.status().state === "ready") return this.status();
    const abort = new AbortController();
    this.error = undefined;
    const done = this.fetchAll(abort.signal)
      .catch((err: unknown) => {
        // A cancel is not a failure: its parts stay for the next download to continue.
        if (!abort.signal.aborted) this.error = (err as Error).message;
      })
      .finally(() => {
        if (this.run?.abort === abort) this.run = undefined;
      });
    this.run = { abort, done };
    return this.status();
  }

  async cancelDownload(): Promise<SttModelStatus> {
    const run = this.run;
    run?.abort.abort();
    await run?.done;
    return this.status();
  }

  async remove(): Promise<SttModelStatus> {
    await this.cancelDownload();
    await this.unload();
    rmSync(this.dir, { recursive: true, force: true });
    this.error = undefined;
    return this.status();
  }

  // 🎤 was pressed: the model loads while the first phrase is spoken (decision 9). Not awaited;
  // a load failure reaches the operator through the phrase that needed it.
  warm(): void {
    this.requireModel();
    this.ensureLoaded().catch(() => {});
    if (!this.busy) this.armIdle();
  }

  // One phrase → its text; "" when there was nothing but an invention of the recogniser.
  async transcribe(audio: unknown, language: unknown): Promise<string> {
    if (!isDictationLanguage(language)) throw new CodedError("stt_audio_invalid", "Невідома мова диктування.");
    const phrase: SttPhrase = { ...parseWav(decodeBase64(audio)), language };
    this.requireModel();
    this.busy++;
    clearTimeout(this.idle);
    const turn = this.queue.then(() => this.recognise(phrase));
    this.queue = turn.catch(() => {});
    try {
      return await turn;
    } finally {
      if (--this.busy === 0) this.armIdle();
    }
  }

  private async recognise(phrase: SttPhrase): Promise<string> {
    let text: string;
    try {
      const runner = await this.ensureLoaded();
      text = await runner.transcribe(phrase);
    } catch (err) {
      // The next phrase starts the engine afresh instead of hitting a dead one again.
      await this.unload();
      const reason = (err as Error).message;
      throw new CodedError("stt_engine_failed", `Локальне розпізнавання не спрацювало: ${reason}`, { reason });
    }
    text = text.trim();
    return isInventedPhrase(text) ? "" : text;
  }

  private ensureLoaded(): Promise<SttRunner> {
    if (!this.loaded) {
      const runner = this.engines(this.model.engine, this.dir);
      const entry = { runner, ready: runner.load().then(() => runner) };
      this.loaded = entry;
      entry.ready.catch(() => {
        if (this.loaded === entry) this.loaded = undefined;
        void runner.unload().catch(() => {});
      });
    }
    return this.loaded.ready;
  }

  private armIdle(): void {
    clearTimeout(this.idle);
    this.idle = setTimeout(() => void this.unload(), STT_UNLOAD_MS);
    this.idle.unref();
  }

  private async unload(): Promise<void> {
    clearTimeout(this.idle);
    const loaded = this.loaded;
    this.loaded = undefined;
    await loaded?.runner.unload().catch(() => {});
  }

  private requireModel(): void {
    if (this.status().state !== "ready")
      throw new CodedError("stt_model_missing", "Модель розпізнавання не завантажена: Налаштування → «Голос» → «Локальне розпізнавання».");
  }

  private async fetchAll(signal: AbortSignal): Promise<void> {
    mkdirSync(this.dir, { recursive: true });
    for (const file of this.model.files) {
      signal.throwIfAborted();
      await this.fetchFile(file, signal);
    }
  }

  // One file into `<name>.part`, continuing from the part's size with an HTTP Range; renamed to
  // its final name only once its size and sha256 match the manifest. The hash runs over the
  // stream as it lands, after re-reading the bytes an earlier attempt left.
  private async fetchFile(file: SttModelFile, signal: AbortSignal): Promise<void> {
    const path = join(this.dir, file.name);
    const part = `${path}.part`;
    if (this.complete(file)) return;
    rmSync(path, { force: true });
    let offset = sizeOf(part);
    if (offset > file.bytes) {
      rmSync(part, { force: true });
      offset = 0;
    }
    let hash = createHash("sha256");
    if (offset > 0) for await (const chunk of createReadStream(part, { signal })) hash.update(chunk as Buffer);
    if (offset < file.bytes) {
      let res: Response;
      try {
        res = await this.fetchFn(file.url, { headers: offset ? { range: `bytes=${offset}-` } : {}, redirect: "follow", signal });
      } catch (err) {
        throw signal.aborted ? err : interrupted(file);
      }
      // 206: the rest from `offset`. 200: the server ignored the Range, so the part starts over.
      const append = offset > 0 && res.status === 206;
      if (!(res.status === 200 || append) || !res.body) {
        await res.body?.cancel().catch(() => {});
        throw new Error(`Сервер моделі відповів HTTP ${res.status} на ${file.name}.`);
      }
      if (!append) hash = createHash("sha256");
      const tap = new Transform({
        transform(chunk: Buffer, _enc, done) {
          hash.update(chunk);
          done(null, chunk);
        },
      });
      try {
        // The dom lib's ReadableStream and Node's web stream are one object under two type names.
        await pipeline(Readable.fromWeb(res.body as WebReadableStream<Uint8Array>), tap, createWriteStream(part, { flags: append ? "a" : "w" }), { signal });
      } catch (err) {
        throw signal.aborted ? err : interrupted(file);
      }
    }
    const size = sizeOf(part);
    if (size < file.bytes) throw interrupted(file);
    if (size !== file.bytes || hash.digest("hex") !== file.sha256) {
      rmSync(part, { force: true });
      throw new Error(`Файл моделі ${file.name} пошкоджений (контрольна сума не збігається) — завантажте ще раз.`);
    }
    renameSync(part, path);
  }

  private complete(file: SttModelFile): boolean {
    return sizeOf(join(this.dir, file.name)) === file.bytes;
  }

  // Bytes of this file on disk: the verified file, else its part.
  private onDisk(file: SttModelFile): number {
    return this.complete(file) ? file.bytes : sizeOf(join(this.dir, `${file.name}.part`));
  }
}

function sizeOf(path: string): number {
  return statSync(path, { throwIfNoEntry: false })?.size ?? 0;
}

function interrupted(file: SttModelFile): Error {
  return new Error(`Завантаження ${file.name} перервалося (мережа) — натисніть «Завантажити», щоб продовжити з того ж місця.`);
}

function invalidAudio(): CodedError {
  return new CodedError("stt_audio_invalid", "Фраза має бути WAV 16 кГц, моно, 16 біт, не довша за дві хвилини.");
}

function decodeBase64(audio: unknown): Buffer {
  if (typeof audio !== "string" || audio.length > MAX_BASE64 || audio.length % 4 !== 0 || !BASE64.test(audio)) throw invalidAudio();
  return Buffer.from(audio, "base64");
}

// RIFF/WAVE with a PCM `fmt ` (format 1, mono, 16 kHz, 16-bit) before a non-empty `data` chunk
// that fits in the file: exactly what the window's capture writes, nothing an engine would have
// to convert.
function parseWav(wav: Buffer): { wav: Buffer; pcm: Buffer } {
  if (wav.length < 12 || wav.length > STT_MAX_WAV_BYTES || wav.toString("ascii", 0, 4) !== "RIFF" || wav.toString("ascii", 8, 12) !== "WAVE")
    throw invalidAudio();
  let pcmFormat = false;
  for (let at = 12; at + 8 <= wav.length; ) {
    const id = wav.toString("ascii", at, at + 4);
    const size = wav.readUInt32LE(at + 4);
    const body = at + 8;
    if (body + size > wav.length) break;
    if (id === "fmt ") {
      pcmFormat =
        size >= 16 &&
        wav.readUInt16LE(body) === 1 &&
        wav.readUInt16LE(body + 2) === 1 &&
        wav.readUInt32LE(body + 4) === STT_SAMPLE_RATE &&
        wav.readUInt16LE(body + 14) === 16;
      if (!pcmFormat) break;
    } else if (id === "data") {
      if (pcmFormat && size > 0 && size % 2 === 0) return { wav, pcm: wav.subarray(body, body + size) };
      break;
    }
    at = body + size + (size & 1);
  }
  throw invalidAudio();
}
