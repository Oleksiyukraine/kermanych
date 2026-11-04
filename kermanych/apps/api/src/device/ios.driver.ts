// apps/api/src/device/ios.driver.ts
// The iOS Simulator (docs/specs/2026-11-03-mobile-device-preview.md, decision 3): `xcrun simctl`
// for the device itself, and one serve-sim helper per booted device for the screen (MJPEG), live
// input (its WebSocket HID protocol) and the accessibility tree (`/ax`).
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import type { DeviceBase, DeviceButton, DeviceElement, DeviceOrientation, DeviceRuntime, DeviceToolStatus, SessionDevice } from "@kermanych/core";
import type { BootedDevice, DeviceDriver, DeviceLog, FrameSink } from "./device.driver";
import {
  HID_GUI,
  HID_KEYS,
  HID_SHIFT,
  MjpegParser,
  axToElements,
  hidForChar,
  jpegSize,
  parseSimctlBases,
  parseSimctlClones,
  splitTyping,
  type AxNode,
  type CloneOnDisk,
  type SimctlList,
} from "./device-parse";
import { ToolError, abortError, abortableSleep, freePort, lastLines, onLines, run, runText, stopGroup } from "./device-proc";

const BOOT_MS = 3 * 60_000;
const HELPER_READY_MS = 30_000;

// serve-sim's WebSocket tags (its device-session.ts: `[tag][JSON]` binary frames).
const WS_TOUCH = 0x03;
const WS_BUTTON = 0x04;
const WS_KEY = 0x06;
const WS_ROTATE = 0x07;
const WS_SCROLL = 0x0b;

// Consumer-page HID usages of the volume buttons, which serve-sim presses through `buttonHid`.
const HID_VOLUME_UP = 0xe9;
const HID_VOLUME_DOWN = 0xea;

// serve-sim waits this long between key messages of its own `type` command.
const KEY_GAP_MS = 4;

function simctl(args: string[], opts: Parameters<typeof run>[2] = {}) {
  return run("xcrun", ["simctl", ...args], { timeoutMs: 60_000, ...opts });
}

async function simctlList(): Promise<SimctlList> {
  return JSON.parse((await simctl(["list", "-j", "devices"])).stdout.toString("utf8")) as SimctlList;
}

// The serve-sim CLI: KERMANYCH_SERVE_SIM (an Xcode update broke the pinned one, decision 3), else
// the bundled package. In the dmg the package sits in app.asar.unpacked (quasar.config.ts): its
// native addon and helper binaries must be real files, so the CLI runs from there too.
export function serveSimPath(): string | null {
  const override = process.env.KERMANYCH_SERVE_SIM?.trim();
  if (override) return existsSync(override) ? override : null;
  try {
    const cli = join(dirname(require.resolve("serve-sim/middleware")), "serve-sim.js").replace(/([\\/])app\.asar([\\/])/, "$1app.asar.unpacked$2");
    return existsSync(cli) ? cli : null;
  } catch {
    return null;
  }
}

// A `.js` CLI runs on this process's Node (Electron's, as Node, in the desktop app); anything else
// is an executable of its own.
function serveSimCommand(cli: string, args: string[]): { cmd: string; args: string[]; env: NodeJS.ProcessEnv } {
  const env = { ...process.env, ELECTRON_RUN_AS_NODE: "1" };
  return /\.[cm]?js$/.test(cli) ? { cmd: process.execPath, args: [cli, ...args], env } : { cmd: cli, args, env };
}

export class IosDriver implements DeviceDriver {
  readonly platform = "ios" as const;

  async tools(): Promise<DeviceToolStatus> {
    if (process.platform !== "darwin") return { ok: false, reason: "iOS-симулятор працює лише на macOS" };
    try {
      await run("xcode-select", ["-p"], { timeoutMs: 10_000 });
    } catch {
      return { ok: false, reason: "Xcode не знайдено: встановіть Xcode з App Store і виберіть його: sudo xcode-select -s /Applications/Xcode.app" };
    }
    try {
      await simctl(["list", "-j", "runtimes"], { timeoutMs: 30_000 });
    } catch {
      return { ok: false, reason: "xcrun simctl не працює: встановіть повний Xcode (не лише Command Line Tools) і виберіть його: sudo xcode-select -s /Applications/Xcode.app" };
    }
    if (process.arch !== "arm64") return { ok: false, reason: "iOS-симулятор у Kermanych працює лише на Mac з Apple Silicon: serve-sim постачається тільки для arm64" };
    if (!serveSimPath()) {
      return { ok: false, reason: process.env.KERMANYCH_SERVE_SIM ? `serve-sim не знайдено за KERMANYCH_SERVE_SIM=${process.env.KERMANYCH_SERVE_SIM}` : "serve-sim не знайдено: перевстановіть Kermanych або вкажіть шлях до serve-sim у KERMANYCH_SERVE_SIM" };
    }
    return { ok: true };
  }

  async bases(): Promise<DeviceBase[]> {
    const out = await simctl(["list", "-j", "devices", "available"]);
    return parseSimctlBases(JSON.parse(out.stdout.toString("utf8")) as SimctlList);
  }

  async clones(): Promise<CloneOnDisk[]> {
    return parseSimctlClones(await simctlList()).map((c) => ({ platform: "ios", id: c.id, name: c.name, running: c.booted }));
  }

  async exists(id: string): Promise<boolean> {
    return Object.values((await simctlList()).devices).some((ds) => ds.some((d) => d.udid === id));
  }

  async clone(base: DeviceBase, name: string, log: DeviceLog, signal: AbortSignal): Promise<string> {
    const list = await simctlList();
    const all = Object.values(list.devices).flat();
    const src = all.find((d) => d.udid === base.id);
    if (!src) throw new Error(`Симулятор ${base.name} (${base.id}) не знайдено: виберіть інший пристрій`);
    // CoreSimulator cannot clone a booted device (decision 4, edge cases).
    if (src.state && src.state !== "Shutdown") throw new Error(`Закрийте ${base.name}: симулятор запущений, і Kermanych не може зробити його копію`);
    // A clone of this name not recorded anywhere is a start cut short: simctl allows duplicate
    // names, so it would linger beside the new one.
    for (const stray of all.filter((d) => d.name === name)) {
      log(`deleting the unfinished clone ${stray.udid}`);
      await this.delete(stray.udid);
    }
    log(`cloning ${base.name} (${base.os}) as ${name}`);
    const udid = (await simctl(["clone", base.id, name], { signal, timeoutMs: 5 * 60_000 })).stdout.toString("utf8").trim();
    if (!/^[0-9A-F-]{36}$/i.test(udid)) throw new Error(`simctl clone printed no device id: ${udid}`);
    return udid;
  }

  async boot(device: SessionDevice, log: DeviceLog, signal: AbortSignal): Promise<BootedDevice> {
    const udid = device.id;
    const state = Object.values((await simctlList()).devices).flat().find((d) => d.udid === udid)?.state;
    if (state && state !== "Shutdown") {
      log(`the clone was left running (${state}): shutting it down first`);
      await simctl(["shutdown", udid], { allowFail: true });
    }
    const started = Date.now();
    log(`booting ${device.baseName} (${udid})`);
    // `boot` inside the try: an abort or a failure at any point leaves no simulator running.
    try {
      await simctl(["boot", udid], { signal });
      await simctl(["bootstatus", udid, "-b"], { signal, timeoutMs: BOOT_MS });
      log(`booted in ${((Date.now() - started) / 1000).toFixed(1)} s`);
      const helper = await Helper.start(udid, log, signal);
      const booted = new IosDevice(device, helper, log);
      await booted.measure(signal);
      return booted;
    } catch (err) {
      await simctl(["shutdown", udid], { allowFail: true });
      throw err;
    }
  }

  async halt(id: string): Promise<void> {
    await simctl(["shutdown", id], { allowFail: true });
  }

  async delete(id: string): Promise<void> {
    await simctl(["shutdown", id], { allowFail: true });
    await simctl(["delete", id], { allowFail: true });
    // serve-sim keeps one log per device it ever streamed.
    await rm(join(tmpdir(), "serve-sim", `server-${id}.log`), { force: true });
  }
}

// One `serve-sim --no-preview -p <port> <udid>` per booted device: a foreground CLI this process
// owns (not `--detach`), which runs the helper as its child and takes it down with it.
class Helper {
  private exitCb: ((code: number | null) => void) | undefined;

  private constructor(
    readonly udid: string,
    readonly base: string,
    private child: ChildProcess,
  ) {
    child.once("exit", (code) => this.exitCb?.(code));
  }

  static async start(udid: string, log: DeviceLog, signal: AbortSignal): Promise<Helper> {
    if (signal.aborted) throw abortError(signal);
    const cli = serveSimPath();
    if (!cli) throw new Error("serve-sim не знайдено: перевстановіть Kermanych або вкажіть шлях до serve-sim у KERMANYCH_SERVE_SIM");
    // A helper of an earlier api still holds the device: `--no-preview` would reuse it and exit at
    // once, leaving no process of ours to own the stream.
    if (existsSync(join(tmpdir(), "serve-sim", `server-${udid}.json`))) {
      const k = serveSimCommand(cli, ["--kill", udid]);
      await run(k.cmd, k.args, { env: k.env, allowFail: true, timeoutMs: 15_000 });
    }
    const port = await freePort();
    const c = serveSimCommand(cli, ["--no-preview", "-q", "-p", String(port), udid]);
    const child = spawn(c.cmd, c.args, { env: c.env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    const { promise, resolve, reject } = Promise.withResolvers<string>();
    const tail: string[] = [];
    onLines(child, (line) => {
      try {
        const j = JSON.parse(line) as { url?: unknown; device?: unknown };
        if (typeof j.url === "string" && j.device === udid) return resolve(`${j.url}/helper/${udid}`);
      } catch {
        /* not the JSON line */
      }
      tail.push(line);
      if (tail.length > 10) tail.shift();
      log(`[serve-sim] ${line}`);
    });
    child.once("exit", (code) => reject(new Error(`serve-sim exited (code ${code}) before streaming${tail.length ? `: ${lastLines(tail.join("\n"), 3)}` : ""}`)));
    child.once("error", (e) => reject(new Error(`serve-sim: ${e.message}`)));
    const timer = setTimeout(() => reject(new Error(`serve-sim did not start in ${HELPER_READY_MS / 1000} s`)), HELPER_READY_MS);
    const onAbort = () => reject(abortError(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      const base = await promise;
      log(`serve-sim streams on ${base}`);
      return new Helper(udid, base, child);
    } catch (err) {
      await stopGroup(child, 2000);
      throw err;
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
    }
  }

  get alive(): boolean {
    return this.child.exitCode === null && this.child.signalCode === null;
  }

  onExit(cb: (code: number | null) => void): void {
    if (!this.alive) cb(this.child.exitCode);
    else this.exitCb = cb;
  }

  async stop(): Promise<void> {
    this.exitCb = undefined;
    await stopGroup(this.child, 3000);
  }
}

class IosDevice implements BootedDevice {
  readonly runtime: DeviceRuntime;
  readonly exited: Promise<string>;
  private resolveExit!: (reason: string) => void;
  private stopping = false;
  private ws: WebSocket | null = null;
  private wsOpen: Promise<WebSocket> | null = null;
  private restarts = 0;

  constructor(
    private device: SessionDevice,
    private helper: Helper,
    private log: DeviceLog,
  ) {
    this.runtime = { platform: "ios", serial: device.id, name: device.baseName, screen: { width: 0, height: 0 } };
    const { promise, resolve } = Promise.withResolvers<string>();
    this.exited = promise;
    this.resolveExit = resolve;
    this.watchHelper();
  }

  // The coordinate space of the tree and the agent's tools: the application's frame of the
  // accessibility tree, in points. The tree is there a moment after boot, not at once.
  async measure(signal: AbortSignal): Promise<void> {
    const deadline = Date.now() + 30_000;
    let last = "";
    while (Date.now() < deadline) {
      try {
        const roots = await this.ax();
        const f = roots.find((r) => (r.frame?.width ?? 0) > 1)?.frame;
        if (f?.width && f.height) {
          this.runtime.screen = { width: Math.round(f.width), height: Math.round(f.height) };
          return;
        }
      } catch (err) {
        last = (err as Error).message;
      }
      await abortableSleep(500, signal);
    }
    throw new Error(`the simulator's accessibility tree did not come up in 30 s${last ? `: ${last}` : ""}`);
  }

  // serve-sim ends with the simulator (`--exit-on-simulator-shutdown`). A helper that dies while
  // the simulator still runs is restarted: the device is fine, only its stream went.
  private watchHelper(): void {
    this.helper.onExit(async (code) => {
      this.ws = null;
      this.wsOpen = null;
      if (this.stopping) return;
      const state = Object.values((await simctlList().catch(() => ({ devices: {} }) as SimctlList)).devices)
        .flat()
        .find((d) => d.udid === this.device.id)?.state;
      if (state !== "Booted") return this.resolveExit(state ? `the simulator shut down (${state})` : "the simulator was deleted");
      if (++this.restarts > 3) return this.resolveExit(`serve-sim keeps exiting (code ${code})`);
      this.log(`serve-sim exited (code ${code}) while the simulator runs: restarting it`);
      try {
        this.helper = await Helper.start(this.device.id, this.log, new AbortController().signal);
        if (this.stopping) return void this.helper.stop();
        this.watchHelper();
        for (const s of this.streams) s.restart();
      } catch (err) {
        this.resolveExit(`serve-sim could not be restarted: ${(err as Error).message}`);
      }
    });
  }

  async shutdown(): Promise<void> {
    this.stopping = true;
    for (const s of [...this.streams]) s.stop();
    this.ws?.close();
    await this.helper.stop();
    await simctl(["shutdown", this.device.id], { allowFail: true, timeoutMs: 60_000 });
    this.resolveExit("shut down by Kermanych");
  }

  private async ax(): Promise<AxNode[]> {
    const res = await fetch(`${this.helper.base}/ax`, { signal: AbortSignal.timeout(15_000) });
    const body = await res.text();
    if (!res.ok) throw new Error(`the accessibility tree is unavailable (${res.status}): ${body.slice(0, 200)}`);
    return JSON.parse(body) as AxNode[];
  }

  async screenshot(): Promise<Buffer> {
    const file = join(tmpdir(), `kermanych-shot-${randomUUID()}.png`);
    try {
      await simctl(["io", this.device.id, "screenshot", "--type=png", file], { timeoutMs: 30_000 });
      return await readFile(file);
    } finally {
      await rm(file, { force: true });
    }
  }

  async tree(): Promise<DeviceElement[]> {
    return axToElements(await this.ax());
  }

  // ── Input over the helper's WebSocket ──────────────────────────────────────

  private socket(): Promise<WebSocket> {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) return Promise.resolve(this.ws);
    if (this.wsOpen) return this.wsOpen;
    const { promise, resolve, reject } = Promise.withResolvers<WebSocket>();
    const ws = new WebSocket(`${this.helper.base.replace(/^http/, "ws")}/ws`);
    ws.binaryType = "arraybuffer";
    ws.onopen = () => {
      this.ws = ws;
      resolve(ws);
    };
    ws.onerror = () => reject(new Error("serve-sim input channel is unavailable"));
    ws.onclose = () => {
      if (this.ws === ws) this.ws = null;
      if (this.wsOpen === promise) this.wsOpen = null;
    };
    this.wsOpen = promise;
    promise.catch(() => (this.wsOpen = null));
    return promise;
  }

  private async send(tag: number, body: unknown): Promise<void> {
    const ws = await this.socket();
    ws.send(Buffer.concat([Buffer.from([tag]), Buffer.from(JSON.stringify(body))]));
  }

  private frac(x: number, y: number): { x: number; y: number } {
    const { width, height } = this.runtime.screen;
    return { x: clamp01(x / width), y: clamp01(y / height) };
  }

  async touch(phase: "begin" | "move" | "end", x: number, y: number): Promise<void> {
    await this.send(WS_TOUCH, { type: phase, ...this.frac(x, y) });
  }

  async scroll(x: number, y: number, dx: number, dy: number): Promise<void> {
    const { width, height } = this.runtime.screen;
    await this.send(WS_SCROLL, { dx: dx / width, dy: dy / height, ...this.frac(x, y) });
  }

  private async keyStroke(usage: number, modifier?: number): Promise<void> {
    if (modifier) await this.send(WS_KEY, { type: "down", usage: modifier });
    await this.send(WS_KEY, { type: "down", usage });
    await sleep(KEY_GAP_MS);
    await this.send(WS_KEY, { type: "up", usage });
    if (modifier) await this.send(WS_KEY, { type: "up", usage: modifier });
    await sleep(KEY_GAP_MS);
  }

  async typeText(text: string): Promise<void> {
    for (const part of splitTyping(text, (ch) => hidForChar(ch) !== null)) {
      if (part.kind === "keys") {
        for (const ch of part.text) {
          const k = hidForChar(ch)!;
          await this.keyStroke(k.usage, k.shift ? HID_SHIFT : undefined);
        }
      } else {
        // Decision 9: the simulator's pasteboard, then Cmd+V in the focused field.
        await simctl(["pbcopy", this.device.id], { input: part.text, timeoutMs: 15_000 });
        await this.keyStroke(hidForChar("v")!.usage, HID_GUI);
        // The paste lands asynchronously; the next keys must not overtake it.
        await sleep(150);
      }
    }
  }

  async key(key: string): Promise<void> {
    const usage = HID_KEYS[key];
    if (usage === undefined) throw new Error(`unknown key "${key}"`);
    await this.keyStroke(usage);
  }

  async button(button: DeviceButton): Promise<void> {
    if (button === "home" || button === "lock") return this.send(WS_BUTTON, { button });
    if (button === "enter") return this.keyStroke(HID_KEYS.Enter!);
    if (button === "volume_up" || button === "volume_down") {
      return this.send(WS_BUTTON, { button, page: 0x0c, usage: button === "volume_up" ? HID_VOLUME_UP : HID_VOLUME_DOWN, phase: "press" });
    }
    throw new Error(`an iOS simulator has no ${button} button`);
  }

  async rotate(orientation: DeviceOrientation): Promise<void> {
    await this.send(WS_ROTATE, { orientation: orientation === "portrait" ? "portrait" : "landscape_left" });
    const { width, height } = this.runtime.screen;
    const landscape = orientation === "landscape";
    if (landscape !== width > height) this.runtime.screen = { width: height, height: width };
  }

  async openUrl(url: string): Promise<void> {
    await simctl(["openurl", this.device.id, url], { timeoutMs: 30_000 });
  }

  // ── The app ────────────────────────────────────────────────────────────────

  async launch(app: string): Promise<void> {
    await simctl(["launch", this.device.id, app], { timeoutMs: 60_000 });
  }

  async terminate(app: string): Promise<void> {
    try {
      await simctl(["terminate", this.device.id, app], { timeoutMs: 30_000 });
    } catch (err) {
      // Not running is what terminate wants.
      if (!(err instanceof ToolError && /found nothing to terminate/.test(err.stderr))) throw err;
    }
  }

  // launchd lists a running app as `<pid>\t<status>\tUIKitApplication:<bundle id>[…]`; an exited
  // one is gone or has `-` for its pid.
  async appRunning(app: string): Promise<boolean> {
    const out = await runText("xcrun", ["simctl", "spawn", this.device.id, "launchctl", "list"], { timeoutMs: 15_000 });
    const needle = `UIKitApplication:${app}[`;
    return out.split("\n").some((l) => l.includes(needle) && /^\d+\s/.test(l));
  }

  // `log stream` of the app's process: its executable name is the bundle's CFBundleExecutable.
  // Before the app is installed there is no bundle, so the name is looked up again until found.
  appLogs(app: string, onLine: (line: string) => void): () => void {
    let stopped = false;
    let child: ChildProcess | null = null;
    const startStream = async () => {
      let exe: string | null = null;
      while (!stopped && !exe) {
        exe = await this.executable(app).catch(() => null);
        if (!exe) await sleep(3000);
      }
      if (stopped || !exe) return;
      const predicate = `process == "${exe.replace(/["\\]/g, "\\$&")}"`;
      child = spawn("xcrun", ["simctl", "spawn", this.device.id, "log", "stream", "--style", "compact", "--predicate", predicate], { stdio: ["ignore", "pipe", "pipe"] });
      onLines(child, (line) => {
        if (!line.startsWith("Filtering the log data") && !line.startsWith("Timestamp ")) onLine(line);
      });
      child.once("exit", () => {
        child = null;
        if (!stopped && !this.stopping) setTimeout(() => void startStream(), 1000);
      });
    };
    void startStream();
    return () => {
      stopped = true;
      child?.kill("SIGTERM");
    };
  }

  private async executable(app: string): Promise<string> {
    const dir = (await runText("xcrun", ["simctl", "get_app_container", this.device.id, app], { timeoutMs: 15_000 })).trim();
    return (await runText("plutil", ["-extract", "CFBundleExecutable", "raw", "-o", "-", join(dir, "Info.plist")], { timeoutMs: 15_000 })).trim();
  }

  // ── The screen: one MJPEG reader of the helper per stream ──────────────────

  private streams = new Set<MjpegReader>();

  stream(_size: { width: number; height: number }, onFrame: FrameSink): () => void {
    // serve-sim encodes at the simulator's own size; its frames are passed through as they are.
    const reader = new MjpegReader(() => `${this.helper.base}/stream.mjpeg`, onFrame, this.log);
    this.streams.add(reader);
    reader.restart();
    return () => {
      this.streams.delete(reader);
      reader.stop();
    };
  }
}

class MjpegReader {
  private ctl: AbortController | null = null;
  private stopped = false;

  constructor(
    private url: () => string,
    private onFrame: FrameSink,
    private log: DeviceLog,
  ) {}

  restart(): void {
    this.ctl?.abort();
    if (this.stopped) return;
    const ctl = new AbortController();
    this.ctl = ctl;
    void this.read(ctl).catch((err: unknown) => {
      if (ctl.signal.aborted || this.stopped) return;
      this.log(`the screen stream broke: ${(err as Error).message}`);
      setTimeout(() => this.ctl === ctl && this.restart(), 1000);
    });
  }

  stop(): void {
    this.stopped = true;
    this.ctl?.abort();
  }

  private async read(ctl: AbortController): Promise<void> {
    const res = await fetch(this.url(), { signal: ctl.signal });
    if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
    const parser = new MjpegParser();
    let size = { width: 0, height: 0 };
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      for (const jpg of parser.push(Buffer.from(value))) {
        size = jpegSize(jpg) ?? size;
        this.onFrame("jpeg", size.width, size.height, jpg);
      }
    }
    throw new Error("the stream ended");
  }
}

function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v));
}
