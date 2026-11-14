// apps/api/src/voice/whisper-cpp.engine.ts
// Whisper on macOS (docs/specs/2026-11-14-local-voice-dictation.md, decision 4): whisper.cpp's
// `whisper-server` as a child process on a free 127.0.0.1 port, holding the model in memory
// (Metal) between phrases (decision 9). It runs without `--vad`: whisper.cpp's Silero VAD cut
// quiet speech in the comparison, and the service filters Whisper's inventions instead
// (decision 11).
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { connect } from "node:net";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { DICTATION_PROMPT } from "@kermanych/core";
import { freePort, lastLines, onLines, stopGroup } from "../device/device-proc";
import { childLedger } from "../runtime/child-ledger";
import type { SttPhrase, SttRunner } from "./stt-engine";

// Loading the q8 turbo model takes a few seconds on Apple silicon; a minute means it is stuck.
const READY_MS = 60_000;
const POLL_MS = 200;
// A whisper-server that ignores SIGTERM this long is killed.
const STOP_GRACE_MS = 2_000;
// What of the server's own output is kept for a failure's reason.
const KEEP_LINES = 20;

// Where the binary is: an explicit path wins (a developer's own build), then the one the `.dmg`
// ships in its resources, then the one apps/ui/scripts/build-whisper-server.sh built into the
// monorepo's `.whisper-build/` (a dev run uses the same binary the release ships), then whatever
// `whisper-server` is on PATH (Homebrew's whisper-cpp).
export function whisperServerPath(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.KERMANYCH_WHISPER_SERVER?.trim();
  if (explicit) return explicit;
  // Electron adds `process.resourcesPath`; the api is typed against plain Node.
  const resources = "resourcesPath" in process && typeof process.resourcesPath === "string" ? process.resourcesPath : undefined;
  if (process.versions.electron && resources) {
    const shipped = join(resources, "bin", "whisper-server");
    if (existsSync(shipped)) return shipped;
  }
  // This file runs from apps/api/src/voice (specs) or apps/api/dist/voice (dev): four levels
  // below the monorepo root either way. Inside the packaged app the path simply does not exist.
  const built = join(__dirname, "..", "..", "..", "..", ".whisper-build", "bin", "whisper-server");
  if (existsSync(built)) return built;
  return "whisper-server";
}

export class WhisperCppEngine implements SttRunner {
  private child?: ChildProcess;
  private port = 0;
  private output: string[] = [];

  constructor(
    private readonly modelPath: string,
    private readonly bin: string = whisperServerPath(),
  ) {}

  async load(): Promise<void> {
    this.port = await freePort();
    this.output = [];
    // `detached`: the server leads its own process group, so a stop reaches all of it and the
    // child ledger can sweep it after a crash of this api, like an omp child or a preview step.
    const child = spawn(this.bin, ["-m", this.modelPath, "--host", "127.0.0.1", "--port", String(this.port), "-t", "4"], {
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.child = child;
    const pid = child.pid;
    if (pid !== undefined) {
      childLedger()?.add(pid, "whisper-server");
      child.once("exit", () => childLedger()?.remove(pid));
    }
    onLines(child, (line) => {
      this.output.push(line);
      if (this.output.length > KEEP_LINES) this.output.shift();
    });
    let failure: string | undefined;
    child.once("error", (err: NodeJS.ErrnoException) => {
      failure =
        err.code === "ENOENT"
          ? `whisper-server не знайдено (${this.bin}): задайте KERMANYCH_WHISPER_SERVER або встановіть whisper-cpp.`
          : `whisper-server не запустився: ${err.message}`;
    });
    child.once("exit", (code, signal) => {
      failure ??= `whisper-server завершився (${signal ?? `код ${code}`})${this.said()}`;
    });
    const deadline = Date.now() + READY_MS;
    for (;;) {
      if (failure) throw new Error(failure);
      if (this.child !== child) throw new Error("whisper-server зупинено під час завантаження моделі.");
      if (await accepts(this.port)) return;
      if (Date.now() > deadline) {
        await this.unload();
        throw new Error(`whisper-server не завантажив модель за ${READY_MS / 1000} с${this.said()}`);
      }
      await sleep(POLL_MS);
    }
  }

  async transcribe(phrase: SttPhrase): Promise<string> {
    const child = this.child;
    if (!child || child.exitCode !== null || child.signalCode !== null) throw new Error(`whisper-server не працює${this.said()}`);
    const form = new FormData();
    // A view, not a copy: the phrase's Buffer is backed by a plain ArrayBuffer.
    form.set("file", new Blob([new Uint8Array(phrase.wav.buffer as ArrayBuffer, phrase.wav.byteOffset, phrase.wav.byteLength)], { type: "audio/wav" }), "phrase.wav");
    form.set("response_format", "json");
    form.set("temperature", "0");
    form.set("language", phrase.language);
    form.set("prompt", DICTATION_PROMPT);
    const r = await fetch(`http://127.0.0.1:${this.port}/inference`, { method: "POST", body: form });
    const out = (await r.json().catch(() => ({}))) as { text?: unknown; error?: unknown };
    if (!r.ok || typeof out.text !== "string")
      throw new Error(`whisper-server відповів HTTP ${r.status}${typeof out.error === "string" ? `: ${out.error}` : ""}`);
    return out.text;
  }

  async unload(): Promise<void> {
    const child = this.child;
    this.child = undefined;
    if (child) await stopGroup(child, STOP_GRACE_MS);
  }

  private said(): string {
    const tail = lastLines(this.output.join("\n"), 3);
    return tail ? `: ${tail}` : "";
  }
}

function accepts(port: number): Promise<boolean> {
  const { promise, resolve } = Promise.withResolvers<boolean>();
  const socket = connect({ port, host: "127.0.0.1" });
  socket.once("connect", () => {
    socket.destroy();
    resolve(true);
  });
  socket.once("error", () => resolve(false));
  return promise;
}
