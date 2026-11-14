// Local dictation's model manager and phrase path (docs/specs/2026-11-14-local-voice-dictation.md,
// decisions 5, 9, 11): the download runs against a local fake server with a tiny manifest, the
// engine is a scripted fake — no real process, no network.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash, randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { STT_UNLOAD_MS, type SttModel } from "@kermanych/core";
import { LocalSttService } from "../src/voice/local-stt.service";
import type { SttPhrase, SttRunnerFactory } from "../src/voice/stt-engine";
import { CodedError } from "../src/management/coded-error";

const FILES: Record<string, Buffer> = { "a.bin": randomBytes(300_000), "b.bin": randomBytes(40_000) };
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

// How the fake server misbehaves on the next request for a file: cut the connection after N
// bytes, or send N bytes and then hang until the client goes away.
type Trouble = { cut?: number; stall?: number };
let trouble: Record<string, Trouble> = {};
let ignoreRange = false;
let requests: { path: string; range?: string }[] = [];
let server: Server;
let base: string;

beforeAll(async () => {
  server = createServer((req, res) => {
    const path = req.url ?? "/";
    requests.push({ path, range: req.headers.range });
    // Hugging Face answers its /resolve/ URLs with a redirect to the CDN.
    if (path.startsWith("/resolve/")) {
      res.writeHead(302, { location: `/files/${path.slice("/resolve/".length)}` });
      return res.end();
    }
    const name = path.slice("/files/".length);
    const body = FILES[name];
    if (!body) {
      res.writeHead(404);
      return res.end();
    }
    const m = /^bytes=(\d+)-$/.exec(req.headers.range ?? "");
    const from = m && !ignoreRange ? Number(m[1]) : 0;
    const rest = body.subarray(from);
    res.writeHead(from ? 206 : 200, {
      "content-length": rest.length,
      ...(from ? { "content-range": `bytes ${from}-${body.length - 1}/${body.length}` } : {}),
    });
    const t = trouble[name];
    delete trouble[name];
    if (t?.cut !== undefined) {
      res.write(rest.subarray(0, t.cut));
      setTimeout(() => res.socket?.destroy(), 100);
    } else if (t?.stall !== undefined) {
      res.write(rest.subarray(0, t.stall));
    } else res.end(rest);
  });
  const listening = Promise.withResolvers<void>();
  server.listen(0, "127.0.0.1", listening.resolve);
  await listening.promise;
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => {
  server.closeAllConnections();
  server.close();
});

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "kermanych-stt-"));
  trouble = {};
  ignoreRange = false;
  requests = [];
});

afterEach(() => {
  vi.useRealTimers();
  rmSync(root, { recursive: true, force: true });
});

function manifest(over: Partial<Record<string, string>> = {}): SttModel {
  return {
    engine: "whisper",
    id: "test-model",
    files: Object.entries(FILES).map(([name, bytes]) => ({ name, url: `${base}/resolve/${name}`, bytes: bytes.length, sha256: over[name] ?? sha(bytes) })),
  };
}

function service(opts: { model?: SttModel; engines?: SttRunnerFactory } = {}): LocalSttService {
  return new LocalSttService({ root, env: {}, platform: "darwin", model: opts.model ?? manifest(), engines: opts.engines });
}

const dir = () => join(root, "test-model");

async function settled(svc: LocalSttService) {
  await vi.waitFor(() => expect(svc.status().state).not.toBe("downloading"), { timeout: 5_000 });
  return svc.status();
}

async function codeOf(p: Promise<unknown> | (() => unknown)): Promise<string | undefined> {
  try {
    await (typeof p === "function" ? p() : p);
  } catch (e) {
    return e instanceof CodedError ? e.code : `not coded: ${(e as Error).message}`;
  }
  return undefined;
}

describe("LocalSttService — model download", () => {
  it("downloads every file through the redirect, verifies it, and reports ready", async () => {
    const svc = service();
    const total = FILES["a.bin"].length + FILES["b.bin"].length;
    expect(svc.status()).toEqual({ engine: "whisper", totalBytes: total, state: "absent" });
    expect(svc.download().state).toBe("downloading");
    expect(await settled(svc)).toEqual({ engine: "whisper", totalBytes: total, state: "ready" });
    for (const [name, bytes] of Object.entries(FILES)) {
      expect(readFileSync(join(dir(), name)).equals(bytes)).toBe(true);
      expect(existsSync(join(dir(), `${name}.part`))).toBe(false);
    }
    expect(requests.map((r) => r.path)).toEqual(["/resolve/a.bin", "/files/a.bin", "/resolve/b.bin", "/files/b.bin"]);
    // Ready: a second download asks nothing.
    expect(svc.download().state).toBe("ready");
    expect(requests).toHaveLength(4);
  });

  it("continues an interrupted file from the bytes on disk with a Range request", async () => {
    const svc = service();
    trouble["a.bin"] = { cut: 120_000 };
    svc.download();
    const failed = await settled(svc);
    expect(failed.state).toBe("absent");
    expect(failed.error).toMatch(/перервалося/);
    const kept = statSync(join(dir(), "a.bin.part")).size;
    expect(kept).toBeGreaterThan(0);
    expect(kept).toBeLessThan(FILES["a.bin"].length);

    requests = [];
    expect(svc.download().error).toBeUndefined();
    expect((await settled(svc)).state).toBe("ready");
    expect(requests.find((r) => r.path === "/files/a.bin")?.range).toBe(`bytes=${kept}-`);
    expect(readFileSync(join(dir(), "a.bin")).equals(FILES["a.bin"])).toBe(true);
  });

  it("starts the part over when the server ignores the Range", async () => {
    const svc = service();
    trouble["a.bin"] = { cut: 50_000 };
    svc.download();
    await settled(svc);
    ignoreRange = true;
    svc.download();
    expect((await settled(svc)).state).toBe("ready");
    expect(readFileSync(join(dir(), "a.bin")).equals(FILES["a.bin"])).toBe(true);
  });

  it("deletes a part whose sha256 does not match and names the failure", async () => {
    const svc = service({ model: manifest({ "b.bin": "0".repeat(64) }) });
    svc.download();
    const s = await settled(svc);
    expect(s.state).toBe("absent");
    expect(s.error).toMatch(/b\.bin.*контрольна сума/);
    expect(existsSync(join(dir(), "b.bin.part"))).toBe(false);
    expect(existsSync(join(dir(), "b.bin"))).toBe(false);
    // The file that matched stays verified.
    expect(readFileSync(join(dir(), "a.bin")).equals(FILES["a.bin"])).toBe(true);
  });

  it("reports progress while downloading, and a cancel keeps the part for the next download", async () => {
    const svc = service();
    trouble["a.bin"] = { stall: 100_000 };
    svc.download();
    await vi.waitFor(() => expect(svc.status().receivedBytes).toBe(100_000), { timeout: 5_000 });
    expect(svc.status().state).toBe("downloading");
    // Idempotent while one runs: no second request.
    svc.download();
    expect(requests.filter((r) => r.path === "/files/a.bin")).toHaveLength(1);

    const cancelled = await svc.cancelDownload();
    expect(cancelled.state).toBe("absent");
    expect(cancelled.error).toBeUndefined();
    expect(statSync(join(dir(), "a.bin.part")).size).toBe(100_000);

    svc.download();
    expect((await settled(svc)).state).toBe("ready");
    expect(requests.filter((r) => r.path === "/files/a.bin").at(-1)?.range).toBe("bytes=100000-");
  });

  it("remove deletes the files and unloads the engine", async () => {
    const { factory, calls } = fakeEngine(() => "привіт");
    const svc = service({ engines: factory });
    svc.download();
    await settled(svc);
    expect(await svc.transcribe(wav(), "uk")).toBe("привіт");
    expect((await svc.remove()).state).toBe("absent");
    expect(existsSync(dir())).toBe(false);
    expect(calls.unload).toBe(1);
  });
});

// ── the phrase path ──

function wav({ rate = 16_000, channels = 1, bits = 16, samples = [0, 100, -100, 0] } = {}): string {
  const data = Buffer.alloc(samples.length * 2);
  samples.forEach((s, i) => data.writeInt16LE(s, i * 2));
  const h = Buffer.alloc(44);
  h.write("RIFF", 0, "ascii");
  h.writeUInt32LE(36 + data.length, 4);
  h.write("WAVE", 8, "ascii");
  h.write("fmt ", 12, "ascii");
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(channels, 22);
  h.writeUInt32LE(rate, 24);
  h.writeUInt32LE((rate * channels * bits) / 8, 28);
  h.writeUInt16LE((channels * bits) / 8, 32);
  h.writeUInt16LE(bits, 34);
  h.write("data", 36, "ascii");
  h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]).toString("base64");
}

function fakeEngine(say: (p: SttPhrase) => string | Promise<string>) {
  const calls = { load: 0, unload: 0, transcribe: 0 };
  const factory: SttRunnerFactory = () => ({
    load: async () => {
      calls.load++;
    },
    transcribe: async (p) => {
      calls.transcribe++;
      return say(p);
    },
    unload: async () => {
      calls.unload++;
    },
  });
  return { factory, calls };
}

// A model "on disk" without downloading: every manifest file at its final name and size.
function installed(engines: SttRunnerFactory): LocalSttService {
  mkdirSync(dir(), { recursive: true });
  for (const [name, bytes] of Object.entries(FILES)) writeFileSync(join(dir(), name), bytes);
  return service({ engines });
}

describe("LocalSttService — transcribe", () => {
  it("refuses what is not a 16 kHz mono 16-bit WAV, or an unknown language, before the engine", async () => {
    const { factory, calls } = fakeEngine(() => "x");
    const svc = installed(factory);
    expect(await codeOf(svc.transcribe("%%%%", "uk"))).toBe("stt_audio_invalid");
    expect(await codeOf(svc.transcribe(undefined, "uk"))).toBe("stt_audio_invalid");
    expect(await codeOf(svc.transcribe(Buffer.from("hello world!").toString("base64"), "uk"))).toBe("stt_audio_invalid");
    expect(await codeOf(svc.transcribe(wav({ rate: 44_100 }), "uk"))).toBe("stt_audio_invalid");
    expect(await codeOf(svc.transcribe(wav({ channels: 2 }), "uk"))).toBe("stt_audio_invalid");
    expect(await codeOf(svc.transcribe(wav({ samples: [] }), "uk"))).toBe("stt_audio_invalid");
    expect(await codeOf(svc.transcribe(wav(), "xx"))).toBe("stt_audio_invalid");
    expect(calls.load).toBe(0);
  });

  it("refuses a phrase and a warm-up while the model is not downloaded", async () => {
    const { factory, calls } = fakeEngine(() => "x");
    const svc = service({ engines: factory });
    expect(await codeOf(svc.transcribe(wav(), "uk"))).toBe("stt_model_missing");
    expect(await codeOf(() => svc.warm())).toBe("stt_model_missing");
    expect(calls.load).toBe(0);
  });

  it("trims the text and drops a phrase that is only a recogniser's invention", async () => {
    const said = ["  Зроби кнопку синьою.  ", " Дякую за перегляд! ", ""];
    const { factory } = fakeEngine(() => said.shift()!);
    const svc = installed(factory);
    expect(await svc.transcribe(wav(), "uk")).toBe("Зроби кнопку синьою.");
    expect(await svc.transcribe(wav(), "uk")).toBe("");
    expect(await svc.transcribe(wav(), "uk")).toBe("");
  });

  it("recognises one phrase at a time, in arrival order", async () => {
    let running = 0;
    let most = 0;
    const order: number[] = [];
    const { factory, calls } = fakeEngine(async (p) => {
      running++;
      most = Math.max(most, running);
      const n = p.pcm.readInt16LE(0);
      // The first phrase is the slowest: it must still come first.
      await sleep(n === 1 ? 30 : 1);
      order.push(n);
      running--;
      return `фраза ${n}`;
    });
    const svc = installed(factory);
    const out = await Promise.all([1, 2, 3].map((n) => svc.transcribe(wav({ samples: [n] }), "uk")));
    expect(out).toEqual(["фраза 1", "фраза 2", "фраза 3"]);
    expect(order).toEqual([1, 2, 3]);
    expect(most).toBe(1);
    expect(calls.load).toBe(1);
  });

  it("warm loads the engine once, ahead of the first phrase", async () => {
    const { factory, calls } = fakeEngine(() => "так");
    const svc = installed(factory);
    svc.warm();
    svc.warm();
    expect(calls.load).toBe(1);
    expect(await svc.transcribe(wav(), "uk")).toBe("так");
    expect(calls.load).toBe(1);
  });

  it("names an engine failure and starts the engine afresh for the next phrase", async () => {
    let fail = true;
    const { factory, calls } = fakeEngine(() => {
      if (fail) throw new Error("whisper-server відповів HTTP 500");
      return "далі";
    });
    const svc = installed(factory);
    const err = await svc.transcribe(wav(), "uk").catch((e: CodedError) => e);
    expect(err).toBeInstanceOf(CodedError);
    expect((err as CodedError).code).toBe("stt_engine_failed");
    expect((err as CodedError).params).toEqual({ reason: "whisper-server відповів HTTP 500" });
    expect(calls.unload).toBe(1);
    fail = false;
    expect(await svc.transcribe(wav(), "uk")).toBe("далі");
    expect(calls.load).toBe(2);
  });

  it("unloads the engine after STT_UNLOAD_MS without a phrase; each phrase restarts the wait", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { factory, calls } = fakeEngine(() => "раз");
    const svc = installed(factory);
    await svc.transcribe(wav(), "uk");
    vi.advanceTimersByTime(STT_UNLOAD_MS / 2);
    await svc.transcribe(wav(), "uk");
    vi.advanceTimersByTime(STT_UNLOAD_MS - 1);
    expect(calls.unload).toBe(0);
    vi.advanceTimersByTime(1);
    expect(calls.unload).toBe(1);
    await svc.transcribe(wav(), "uk");
    expect(calls.load).toBe(2);
  });

  it("onModuleDestroy releases a loaded engine", async () => {
    const { factory, calls } = fakeEngine(() => "раз");
    const svc = installed(factory);
    await svc.transcribe(wav(), "uk");
    await svc.onModuleDestroy();
    expect(calls.unload).toBe(1);
  });
});
