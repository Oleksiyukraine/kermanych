// apps/api/src/device/android.driver.ts
// The Android Emulator (docs/specs/2026-11-03-mobile-device-preview.md, decision 3): the
// emulator's own gRPC API for the screen and input, `adb` for the shell, the UI tree and logcat.
// The `.proto` files are the installed emulator's (`emulator/lib/`), so they always match it.
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { cp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import { DEVICE_CLONE_PREFIX, type DeviceBase, type DeviceButton, type DeviceElement, type DeviceOrientation, type DeviceRuntime, type DeviceToolStatus, type SessionDevice } from "@kermanych/core";
import type { BootedDevice, DeviceDriver, DeviceLog, FrameSink } from "./device.driver";
import { avdOs, avdRunning, avdTopIni, displayToPanel, parseDisplayRotation, parseIni, parseListAvds, parseUiautomator, parseWmSize, rewriteAvdText, splitTyping, type CloneOnDisk } from "./device-parse";
import { abortError, abortableSleep, freePort, lastLines, onLines, portFree, run, runText, stopGroup } from "./device-proc";

const BOOT_MS = 3 * 60_000;
// `adb emu kill` saves the quick-boot snapshot before the process ends.
const SHUTDOWN_MS = 60_000;

// Decision «Android ports»: an even console port in 5554–5584, so `adb` finds the emulator itself.
const CONSOLE_PORTS = Array.from({ length: 16 }, (_, i) => 5554 + i * 2);
// Ports handed out by this process and not yet taken by their emulator.
const reservedPorts = new Set<number>();

// Android keycodes (android.view.KeyEvent) of the hardware buttons.
const KEYCODES: Record<DeviceButton, number> = { home: 3, back: 4, recents: 187, lock: 26, enter: 66, volume_up: 24, volume_down: 25 };
const KEYCODE_PASTE = 279;

// DeviceInput `key` names are the W3C key values the emulator's sendKey understands as they are.
const W3C_KEYS = new Set(["Enter", "Backspace", "Tab", "Escape", "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Delete"]);

// The SDK of decision 3: ANDROID_HOME, then ANDROID_SDK_ROOT, then the Android Studio default.
export function androidSdk(): string | null {
  for (const dir of [process.env.ANDROID_HOME, process.env.ANDROID_SDK_ROOT, join(homedir(), "Library", "Android", "sdk")]) {
    if (dir?.trim() && existsSync(dir)) return dir;
  }
  return null;
}

// Where the emulator keeps AVDs, as it resolves it itself.
export function avdHome(): string {
  if (process.env.ANDROID_AVD_HOME?.trim()) return process.env.ANDROID_AVD_HOME;
  if (process.env.ANDROID_USER_HOME?.trim()) return join(process.env.ANDROID_USER_HOME, "avd");
  return join(homedir(), ".android", "avd");
}

type Sdk = { emulator: string; adb: string; protoDir: string };

function sdkTools(sdk: string): Sdk {
  return { emulator: join(sdk, "emulator", "emulator"), adb: join(sdk, "platform-tools", "adb"), protoDir: join(sdk, "emulator", "lib") };
}

// The subset of the EmulatorController service the driver calls. The client is built at runtime
// from the SDK's .proto, so its methods are not known to the compiler.
type Unary<Req> = (req: Req, md: grpc.Metadata, cb: (err: grpc.ServiceError | null) => void) => void;
type GrpcImage = { format?: { width?: number; height?: number; rotation?: { rotation?: number } }; image: Buffer };
interface EmulatorClient extends grpc.Client {
  sendTouch: Unary<{ touches: { x: number; y: number; identifier: number; pressure: number }[] }>;
  sendKey: Unary<{ eventType: number; key: string }>;
  setClipboard: Unary<{ text: string }>;
  streamScreenshot(req: { format: number; width: number; height: number }, md: grpc.Metadata): grpc.ClientReadableStream<GrpcImage>;
  getScreenshot(req: { format: number; width: number; height: number }, md: grpc.Metadata, cb: (err: grpc.ServiceError | null, img?: GrpcImage) => void): void;
}
type EmulatorClientCtor = new (address: string, creds: grpc.ChannelCredentials, options: grpc.ClientOptions) => EmulatorClient;

const controllers = new Map<string, EmulatorClientCtor>();

function controllerCtor(protoDir: string): EmulatorClientCtor {
  let ctor = controllers.get(protoDir);
  if (!ctor) {
    const def = protoLoader.loadSync("emulator_controller.proto", { includeDirs: [protoDir], keepCase: true, longs: Number, enums: Number, defaults: true });
    const pkg = grpc.loadPackageDefinition(def) as unknown as { android: { emulation: { control: { EmulatorController: EmulatorClientCtor } } } };
    ctor = pkg.android.emulation.control.EmulatorController;
    controllers.set(protoDir, ctor);
  }
  return ctor;
}

const KEY_PRESS = 2; // KeyboardEvent.KeyEventType.keypress
const IMG_RGB888 = 2; // ImageFormat.ImgFormat.RGB888

export class AndroidDriver implements DeviceDriver {
  readonly platform = "android" as const;

  private sdk(): Sdk {
    const dir = androidSdk();
    if (!dir) throw new Error("Android SDK не знайдено: встановіть Android Studio і задайте ANDROID_HOME");
    return sdkTools(dir);
  }

  async tools(): Promise<DeviceToolStatus> {
    const dir = androidSdk();
    if (!dir) return { ok: false, reason: "Android SDK не знайдено: встановіть Android Studio (або Android SDK) і задайте ANDROID_HOME, якщо SDK не в ~/Library/Android/sdk" };
    const t = sdkTools(dir);
    if (!existsSync(t.emulator)) return { ok: false, reason: `В Android SDK (${dir}) немає емулятора: встановіть «Android Emulator» у SDK Manager Android Studio` };
    if (!existsSync(t.adb)) return { ok: false, reason: `В Android SDK (${dir}) немає adb: встановіть «Android SDK Platform-Tools» у SDK Manager Android Studio` };
    if (!existsSync(join(t.protoDir, "emulator_controller.proto"))) {
      return { ok: false, reason: `Емулятор у ${dir} застарий (немає emulator/lib/emulator_controller.proto): оновіть «Android Emulator» у SDK Manager Android Studio` };
    }
    return { ok: true };
  }

  private env(): NodeJS.ProcessEnv {
    return { ...process.env, ANDROID_AVD_HOME: avdHome() };
  }

  // The AVD's directory: the `path` of its top-level ini, else `<avdHome>/<name>.avd`.
  private async avdDir(name: string): Promise<string> {
    const top = await readFile(join(avdHome(), `${name}.ini`), "utf8").catch(() => "");
    return parseIni(top).get("path") || join(avdHome(), `${name}.avd`);
  }

  async bases(): Promise<DeviceBase[]> {
    const names = parseListAvds(await runText(this.sdk().emulator, ["-list-avds"], { env: this.env(), timeoutMs: 30_000 }))
      .filter((n) => !n.startsWith(DEVICE_CLONE_PREFIX))
      .sort((a, b) => a.localeCompare(b));
    return Promise.all(
      names.map(async (name) => {
        const top = await readFile(join(avdHome(), `${name}.ini`), "utf8").catch(() => "");
        const config = await readFile(join(await this.avdDir(name), "config.ini"), "utf8").catch(() => "");
        return { platform: "android" as const, id: name, name: parseIni(config).get("avd.ini.displayname") || name.replace(/_/g, " "), os: avdOs(config, top) };
      }),
    );
  }

  async clones(): Promise<CloneOnDisk[]> {
    const entries = await readdir(avdHome()).catch(() => [] as string[]);
    const names = new Set(entries.filter((e) => e.startsWith(DEVICE_CLONE_PREFIX)).map((e) => e.replace(/\.(avd|ini)$/, "")));
    const ps = await psArgs();
    return [...names].map((name) => ({ platform: "android", id: name, name, running: avdRunning(ps, name) }));
  }

  async exists(id: string): Promise<boolean> {
    return existsSync(join(avdHome(), `${id}.ini`)) && existsSync(await this.avdDir(id));
  }

  async clone(base: DeviceBase, name: string, log: DeviceLog, signal: AbortSignal): Promise<string> {
    const home = avdHome();
    const src = await this.avdDir(base.id);
    if (!existsSync(src)) throw new Error(`AVD ${base.name} не знайдено: виберіть інший пристрій`);
    // A running emulator holds the AVD's images (decision 4, edge cases).
    if (avdRunning(await psArgs(), base.id)) throw new Error(`Закрийте AVD ${base.name}: він запущений (наприклад, в Android Studio), і Kermanych не може зробити його копію`);
    const dst = join(home, `${name}.avd`);
    await this.delete(name);
    log(`cloning ${base.name} (${base.os}) as ${name}`);
    try {
      // APFS clonefile: the copy shares blocks with the base until it diverges.
      await run("cp", ["-c", "-R", src, dst], { signal, timeoutMs: 10 * 60_000 });
    } catch (err) {
      if (signal.aborted) throw err;
      log(`cp -c (copy-on-write) failed, copying in full: ${(err as Error).message}`);
      await rm(dst, { recursive: true, force: true });
      await cp(src, dst, { recursive: true });
    }
    try {
      await pointAvdAt(dst, src, base.id, name);
      const target = parseIni(await readFile(join(home, `${base.id}.ini`), "utf8").catch(() => "")).get("target");
      await writeFile(join(home, `${name}.ini`), avdTopIni(dst, home, target));
    } catch (err) {
      await this.delete(name);
      throw err;
    }
    return name;
  }

  async boot(device: SessionDevice, log: DeviceLog, signal: AbortSignal): Promise<BootedDevice> {
    const sdk = this.sdk();
    const name = device.id;
    if (avdRunning(await psArgs(), name)) {
      log("the clone was left running: stopping it first");
      await killAvd(name);
    }
    const grpcPort = await freePort();
    // From here the console port is reserved; the `finally` below gives it back.
    const consolePort = await pickConsolePort(sdk.adb);
    const serial = `emulator-${consolePort}`;
    const started = Date.now();
    log(`booting ${device.baseName} as ${serial} (gRPC ${grpcPort})`);
    // `-grpc-use-token`: the gRPC port listens on every interface, so it takes the console token.
    const child = spawn(
      sdk.emulator,
      ["-avd", name, "-no-window", "-no-audio", "-no-boot-anim", "-grpc", String(grpcPort), "-grpc-use-token", "-port", String(consolePort)],
      { env: this.env(), detached: true, stdio: ["ignore", "pipe", "pipe"] },
    );
    const tail: string[] = [];
    let advertised: string | null = null;
    onLines(child, (line) => {
      tail.push(line);
      if (tail.length > 20) tail.shift();
      const m = /Advertising in: (.+\.ini)/.exec(line);
      if (m) advertised = m[1]!.trim();
      log(`[emulator] ${line}`);
    });
    const { promise: exitedEarly, reject: failEarly } = Promise.withResolvers<never>();
    exitedEarly.catch(() => {});
    const onExit = (code: number | null) => failEarly(new Error(`the emulator exited (code ${code}) while booting: ${lastLines(tail.join("\n"), 3)}`));
    child.once("exit", onExit);
    child.once("error", (e) => failEarly(new Error(`emulator: ${e.message}`)));
    const adb = (args: string[], opts: Parameters<typeof run>[2] = {}) => run(sdk.adb, ["-s", serial, ...args], { timeoutMs: 30_000, ...opts });
    const deadline = AbortSignal.any([signal, AbortSignal.timeout(BOOT_MS)]);
    try {
      await Promise.race([exitedEarly, adb(["wait-for-device"], { signal: deadline, timeoutMs: BOOT_MS })]);
      for (;;) {
        const r = await Promise.race([exitedEarly, adb(["shell", "getprop", "sys.boot_completed"], { signal: deadline, allowFail: true })]);
        if (r.stdout.toString("utf8").trim() === "1") break;
        await Promise.race([exitedEarly, abortableSleep(1000, deadline)]);
      }
      log(`booted in ${((Date.now() - started) / 1000).toFixed(1)} s`);
      const size = parseWmSize((await adb(["shell", "wm", "size"])).stdout.toString("utf8"));
      if (!size) throw new Error("adb shell wm size printed no size");
      const token = await grpcToken(advertised);
      child.off("exit", onExit);
      const booted = new AndroidDevice(device, child, serial, size, sdk, grpcPort, token, log);
      await booted.refreshRotation();
      return booted;
    } catch (err) {
      child.off("exit", onExit);
      await stopGroup(child, 3000);
      if (signal.aborted) throw abortError(signal);
      if (deadline.aborted) throw new Error(`the emulator did not boot in ${BOOT_MS / 60_000} min`);
      throw err;
    } finally {
      // By now `adb devices` lists the port (or the emulator is gone).
      reservedPorts.delete(consolePort);
    }
  }

  async halt(id: string): Promise<void> {
    await killAvd(id);
  }

  async delete(id: string): Promise<void> {
    if (avdRunning(await psArgs(), id)) await killAvd(id);
    const dir = await this.avdDir(id);
    // Only a clone's own files: never a path outside the AVD home that a hand-edited ini names.
    if (dir.startsWith(avdHome()) && dir.includes(DEVICE_CLONE_PREFIX)) await rm(dir, { recursive: true, force: true });
    await rm(join(avdHome(), `${id}.avd`), { recursive: true, force: true });
    await rm(join(avdHome(), `${id}.ini`), { force: true });
  }
}

// The text files of a copied AVD, pointed at the clone: every `*.ini` (config.ini, the
// emulator's hardware-qemu.ini, the snapshots' hardware.ini) and the last launch's parameters.
// Locks are the running base's, never the clone's.
async function pointAvdAt(dir: string, srcDir: string, base: string, clone: string): Promise<void> {
  for (const entry of await readdir(dir, { recursive: true, withFileTypes: true })) {
    const path = join(entry.parentPath, entry.name);
    if (entry.name.endsWith(".lock")) {
      await rm(path, { recursive: true, force: true });
      continue;
    }
    if (!entry.isFile() || !/\.ini$|^emu-launch-params\.txt$/.test(entry.name)) continue;
    const text = await readFile(path, "utf8");
    const next = rewriteAvdText(text.split(srcDir).join(dir), base, clone);
    if (next !== text) await writeFile(path, next);
  }
}

async function psArgs(): Promise<string> {
  return runText("ps", ["-Ao", "pid=,args="], { timeoutMs: 10_000 }).catch(() => "");
}

async function killAvd(name: string): Promise<void> {
  const pids = (await psArgs())
    .split("\n")
    .filter((l) => avdRunning(l, name))
    .map((l) => Number(l.trim().split(/\s+/)[0]))
    .filter((p) => p > 0);
  for (const sig of ["SIGTERM", "SIGKILL"] as const) {
    for (const pid of pids) {
      try {
        process.kill(pid, sig);
      } catch {
        /* gone */
      }
    }
    if (sig === "SIGTERM") await sleep(3000);
  }
}

async function pickConsolePort(adb: string): Promise<number> {
  const devices = await runText(adb, ["devices"], { timeoutMs: 15_000 }).catch(() => "");
  for (const port of CONSOLE_PORTS) {
    if (reservedPorts.has(port) || devices.includes(`emulator-${port}`)) continue;
    // Reserved before the checks await: a second boot in this process must not probe the same port.
    reservedPorts.add(port);
    if ((await portFree(port)) && (await portFree(port + 1))) return port;
    reservedPorts.delete(port);
  }
  throw new Error("no free emulator port in 5554–5584: too many emulators are running");
}

// The token of `-grpc-use-token`: the advertised discovery file's, else the console token file.
async function grpcToken(advertised: string | null): Promise<string | null> {
  if (advertised) {
    const t = parseIni(await readFile(advertised, "utf8").catch(() => "")).get("grpc.token");
    if (t) return t;
  }
  const t = (await readFile(join(homedir(), ".emulator_console_auth_token"), "utf8").catch(() => "")).trim();
  return t || null;
}

class AndroidDevice implements BootedDevice {
  readonly runtime: DeviceRuntime;
  readonly exited: Promise<string>;
  private stopping = false;
  private client: EmulatorClient;
  private md = new grpc.Metadata();
  // Touches and keys of one device in order: a scroll's drag must not interleave with a tap.
  private queue: Promise<unknown> = Promise.resolve();
  private streams = new Set<() => void>();
  // The guest display's rotation in quarter turns (Surface.ROTATION_*). The tree, screenshots
  // and the agent's coordinates are in the rotated display's space; sendTouch takes the
  // panel's (`panel`, the natural portrait size of `wm size`).
  private rotation = 0;

  constructor(
    device: SessionDevice,
    private child: ChildProcess,
    private serial: string,
    private panel: { width: number; height: number },
    private sdk: Sdk,
    grpcPort: number,
    token: string | null,
    private log: DeviceLog,
  ) {
    this.runtime = { platform: "android", serial, name: device.baseName, screen: { ...panel } };
    const Ctor = controllerCtor(sdk.protoDir);
    this.client = new Ctor(`127.0.0.1:${grpcPort}`, grpc.credentials.createInsecure(), { "grpc.max_receive_message_length": 64 * 1024 * 1024 });
    if (token) this.md.set("authorization", `Bearer ${token}`);
    const { promise, resolve } = Promise.withResolvers<string>();
    this.exited = promise;
    child.once("exit", (code, sig) => {
      this.client.close();
      for (const stop of [...this.streams]) stop();
      resolve(this.stopping ? "shut down by Kermanych" : `the emulator exited (${sig ?? `code ${code}`})`);
    });
  }

  // Reads the display's rotation (an app may turn it by itself; a quick-boot snapshot may have
  // been saved in landscape) and turns `runtime.screen` with it.
  async refreshRotation(): Promise<number> {
    const out = (await this.adb(["shell", "dumpsys", "window", "displays"], { allowFail: true, timeoutMs: 15_000 })).stdout.toString("utf8");
    const r = parseDisplayRotation(out);
    if (r !== null) {
      this.rotation = r;
      this.runtime.screen = r % 2 ? { width: this.panel.height, height: this.panel.width } : { ...this.panel };
    }
    return this.rotation;
  }

  // The emulator's own (skin) rotation: what its screen stream is turned by.
  private skinRotation(): Promise<number> {
    const { promise, resolve, reject } = Promise.withResolvers<number>();
    this.client.getScreenshot({ format: IMG_RGB888, width: 1, height: 1 }, this.md, (err, img) =>
      err ? reject(new Error(`emulator gRPC: ${err.details || err.message}`)) : resolve(img?.format?.rotation?.rotation ?? 0),
    );
    return promise;
  }

  private adb(args: string[], opts: Parameters<typeof run>[2] = {}) {
    return run(this.sdk.adb, ["-s", this.serial, ...args], { timeoutMs: 30_000, ...opts });
  }

  private call<Req>(method: Unary<Req>, req: Req): Promise<void> {
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    method.call(this.client, req, this.md, (err) => (err ? reject(new Error(`emulator gRPC: ${err.details || err.message}`)) : resolve()));
    return promise;
  }

  private inOrder<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.then(fn, fn);
    this.queue = next.catch(() => {});
    return next;
  }

  async shutdown(): Promise<void> {
    this.stopping = true;
    for (const stop of [...this.streams]) stop();
    if (this.child.exitCode === null && this.child.signalCode === null) {
      const { promise: gone, resolve } = Promise.withResolvers<void>();
      this.child.once("exit", () => resolve());
      await this.adb(["emu", "kill"], { allowFail: true, timeoutMs: 15_000 }).catch(() => {});
      const timedOut = await Promise.race([gone.then(() => false), sleep(SHUTDOWN_MS).then(() => true)]);
      if (timedOut) {
        this.log(`the emulator did not stop in ${SHUTDOWN_MS / 1000} s: killing it`);
        await stopGroup(this.child, 3000);
      }
    }
    // The emulator's crash handler and netsimd children of the group.
    await stopGroup(this.child, 1000);
    await this.exited;
  }

  async screenshot(): Promise<Buffer> {
    return (await this.adb(["exec-out", "screencap", "-p"])).stdout;
  }

  // The dump is in the display's current rotation, so the rotation is read with it: the agent's
  // next tap uses the same space as the tree it read.
  async tree(): Promise<DeviceElement[]> {
    const [dump] = await Promise.all([this.adb(["exec-out", "uiautomator", "dump", "/dev/tty"], { timeoutMs: 30_000 }), this.refreshRotation()]);
    const xml = dump.stdout.toString("utf8");
    const end = xml.lastIndexOf("</hierarchy>");
    if (end < 0) throw new Error(`uiautomator dump failed: ${lastLines(xml, 2)}`);
    return parseUiautomator(xml.slice(0, end + "</hierarchy>".length));
  }

  private sendTouch(x: number, y: number, down: boolean): Promise<void> {
    const p = displayToPanel(x, y, this.rotation, this.panel);
    return this.call(this.client.sendTouch, { touches: [{ x: p.x, y: p.y, identifier: 0, pressure: down ? 1 : 0 }] });
  }

  touch(phase: "begin" | "move" | "end", x: number, y: number): Promise<void> {
    return this.inOrder(() => this.sendTouch(x, y, phase !== "end"));
  }

  // A wheel step as a short drag that rests before it lifts, so it scrolls by its distance and
  // does not fling.
  scroll(x: number, y: number, dx: number, dy: number): Promise<void> {
    return this.inOrder(async () => {
      const steps = 4;
      await this.sendTouch(x, y, true);
      for (let i = 1; i <= steps; i++) {
        await sleep(12);
        await this.sendTouch(x - (dx * i) / steps, y - (dy * i) / steps, true);
      }
      await sleep(40);
      await this.sendTouch(x - dx, y - dy, false);
    });
  }

  typeText(text: string, opts: { secret?: boolean } = {}): Promise<void> {
    return this.inOrder(async () => {
      let pasted = false;
      for (const part of splitTyping(text, (ch) => ch === "\n" || (ch >= " " && ch <= "~"))) {
        if (part.kind === "keys") {
          for (const ch of part.text) await this.call(this.client.sendKey, { eventType: KEY_PRESS, key: ch === "\n" ? "Enter" : ch });
        } else {
          // Decision 9: the device clipboard, then KEYCODE_PASTE in the focused field.
          await this.call(this.client.setClipboard, { text: part.text });
          await this.adb(["shell", "input", "keyevent", String(KEYCODE_PASTE)]);
          pasted = true;
        }
      }
      // A credential must not stay on the device's clipboard.
      if (opts.secret && pasted) await this.call(this.client.setClipboard, { text: "" });
    });
  }

  key(key: string): Promise<void> {
    if (!W3C_KEYS.has(key)) return Promise.reject(new Error(`unknown key "${key}"`));
    return this.inOrder(() => this.call(this.client.sendKey, { eventType: KEY_PRESS, key }));
  }

  async button(button: DeviceButton): Promise<void> {
    await this.adb(["shell", "input", "keyevent", String(KEYCODES[button])]);
  }

  // The virtual device itself turns (`emu rotate`, a quarter turn per call, until the emulator's
  // own rotation is the one asked for), so its screen stream turns with it; auto-rotate on lets
  // the guest UI follow, as a phone turned in the hand. The rotation the display ends up in is
  // read back: an app locked to portrait keeps the display, and the coordinates, portrait.
  rotate(orientation: DeviceOrientation): Promise<void> {
    return this.inOrder(async () => {
      const wanted = (r: number) => (orientation === "portrait" ? r === 0 : r % 2 === 1);
      await this.adb(["shell", "settings", "put", "system", "accelerometer_rotation", "1"]);
      for (let i = 0; i < 4 && !wanted(await this.skinRotation()); i++) {
        await this.adb(["emu", "rotate"]);
        await sleep(300);
      }
      const deadline = Date.now() + 3000;
      while ((await this.refreshRotation()) % 2 !== (orientation === "portrait" ? 0 : 1) && Date.now() < deadline) await sleep(250);
    });
  }

  async openUrl(url: string): Promise<void> {
    await this.adb(["shell", "am", "start", "-a", "android.intent.action.VIEW", "-d", shellQuote(url)]);
  }

  async launch(app: string): Promise<void> {
    const out = (await this.adb(["shell", "monkey", "-p", app, "-c", "android.intent.category.LAUNCHER", "1"])).stdout.toString("utf8");
    if (/No activities found|monkey aborted/i.test(out)) throw new Error(`${app} has no launcher activity on the device (is it installed?)`);
  }

  async terminate(app: string): Promise<void> {
    await this.adb(["shell", "am", "force-stop", app]);
  }

  // `pm clear` drops the app's data and runtime permissions; an app not installed yet has none
  // (docs/specs/2026-11-04-tester-mobile-device.md, decision 1).
  async clearApp(app: string): Promise<void> {
    const installed = (await this.adb(["shell", "pm", "path", app], { allowFail: true })).stdout.toString("utf8").trim();
    if (!installed) return;
    const out = (await this.adb(["shell", "pm", "clear", app], { allowFail: true })).stdout.toString("utf8").trim();
    if (!/^Success/m.test(out)) throw new Error(`pm clear ${app} failed${out ? `: ${out}` : ""}`);
  }

  private async pid(app: string): Promise<string | null> {
    const r = await this.adb(["shell", "pidof", app], { allowFail: true, timeoutMs: 15_000 });
    const pid = r.stdout.toString("utf8").trim().split(/\s+/)[0];
    return r.code === 0 && pid ? pid : null;
  }

  async appRunning(app: string): Promise<boolean> {
    return (await this.pid(app)) !== null;
  }

  // `logcat --pid` of the app, re-attached to the new process whenever the pid changes.
  appLogs(app: string, onLine: (line: string) => void): () => void {
    let stopped = false;
    let pid: string | null = null;
    let child: ChildProcess | null = null;
    const poll = async () => {
      while (!stopped && !this.stopping) {
        const next = await this.pid(app).catch(() => null);
        if (next && next !== pid) {
          child?.kill("SIGTERM");
          pid = next;
          child = spawn(this.sdk.adb, ["-s", this.serial, "logcat", "--pid", next, "-v", "threadtime"], { stdio: ["ignore", "pipe", "pipe"] });
          onLines(child, (line) => {
            if (!line.startsWith("--------- beginning of")) onLine(line);
          });
        }
        await sleep(1000);
      }
    };
    void poll();
    return () => {
      stopped = true;
      child?.kill("SIGTERM");
    };
  }

  // gRPC streamScreenshot in RGB888, scaled by the emulator to fit `size` (aspect kept).
  stream(size: { width: number; height: number }, onFrame: FrameSink): () => void {
    let stopped = false;
    let call: grpc.ClientReadableStream<GrpcImage> | null = null;
    const open = () => {
      if (stopped) return;
      call = this.client.streamScreenshot({ format: IMG_RGB888, width: Math.round(size.width), height: Math.round(size.height) }, this.md);
      call.on("data", (img: GrpcImage) => onFrame("rgb888", img.format?.width ?? 0, img.format?.height ?? 0, img.image));
      call.on("error", (err: grpc.ServiceError) => {
        if (stopped || err.code === grpc.status.CANCELLED) return;
        this.log(`the screen stream broke: ${err.details || err.message}`);
        setTimeout(open, 1000);
      });
    };
    open();
    const stop = () => {
      stopped = true;
      this.streams.delete(stop);
      call?.cancel();
    };
    this.streams.add(stop);
    return stop;
  }
}

// `adb shell` joins its arguments into one device shell line.
function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}
