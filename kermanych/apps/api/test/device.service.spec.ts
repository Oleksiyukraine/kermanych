// apps/api/test/device.service.spec.ts
// DeviceService's lifecycle (docs/specs/2026-11-03-mobile-device-preview.md, decisions 4, 6, 11)
// over fake drivers: clone → boot → record, re-clone on a base change, the clone kept by ◼, deleted
// by remove, exits told from Kermanych's own shutdown, a start cancelled mid-boot, the screen
// stream at the watchers' largest size, and the orphan sweep.
import { beforeEach, describe, expect, test } from "vitest";
import type { DeviceBase, DeviceButton, DeviceElement, DeviceFrame, DevicePlatform, DeviceRuntime, DeviceToolStatus, SessionDevice } from "@kermanych/core";
import { DeviceService } from "../src/device/device.service";
import type { BootedDevice, DeviceDriver, DeviceLog, FrameSink } from "../src/device/device.driver";
import type { CloneOnDisk } from "../src/device/device-parse";
import { RegistryService } from "../src/registry/registry.service";

class FakeBooted implements BootedDevice {
  readonly runtime: DeviceRuntime;
  readonly exited: Promise<string>;
  exit!: (reason: string) => void;
  shutdowns = 0;
  touches: string[] = [];
  streams: { size: { width: number; height: number }; sink: FrameSink; stopped: boolean }[] = [];
  constructor(device: SessionDevice) {
    this.runtime = { platform: device.platform, serial: `serial-${device.id}`, name: device.baseName, screen: { width: 400, height: 800 } };
    const { promise, resolve } = Promise.withResolvers<string>();
    this.exited = promise;
    this.exit = resolve;
  }
  async shutdown() {
    this.shutdowns++;
    this.exit("shut down by Kermanych");
  }
  async screenshot() {
    return Buffer.from("png");
  }
  async tree(): Promise<DeviceElement[]> {
    return [];
  }
  async touch(phase: string, x: number, y: number) {
    this.touches.push(`${phase} ${Math.round(x)},${Math.round(y)}`);
  }
  async scroll() {}
  async typeText() {}
  async key() {}
  buttons: DeviceButton[] = [];
  async button(b: DeviceButton) {
    this.buttons.push(b);
  }
  async rotate() {}
  async openUrl() {}
  async launch() {}
  async terminate() {}
  async appRunning() {
    return true;
  }
  appLogs() {
    return () => {};
  }
  stream(size: { width: number; height: number }, sink: FrameSink) {
    const s = { size, sink, stopped: false };
    this.streams.push(s);
    return () => void (s.stopped = true);
  }
}

class FakeDriver implements DeviceDriver {
  disk = new Map<string, SessionDevice["base"]>(); // clone id → base id
  running = new Set<string>();
  calls: string[] = [];
  booted: FakeBooted[] = [];
  bootGate: Promise<void> | null = null;
  // Holds a clone on disk but not yet returned (so not yet recorded).
  cloneGate: Promise<void> | null = null;
  baseRunning = false;
  private n = 0;
  constructor(readonly platform: DevicePlatform) {}
  async tools(): Promise<DeviceToolStatus> {
    return { ok: true };
  }
  async bases(): Promise<DeviceBase[]> {
    return [];
  }
  async clones(): Promise<CloneOnDisk[]> {
    return [...this.disk.keys()].map((id) => ({ platform: this.platform, id, name: `kermanych-${id.split("#")[0]}`, running: this.running.has(id) }));
  }
  async exists(id: string) {
    return this.disk.has(id);
  }
  async clone(base: DeviceBase, name: string) {
    if (this.baseRunning) throw new Error(`Закрийте ${base.name}`);
    const id = `${name.slice("kermanych-".length)}#${++this.n}`;
    this.calls.push(`clone ${base.id} → ${id}`);
    this.disk.set(id, base.id);
    if (this.cloneGate) await this.cloneGate;
    return id;
  }
  async boot(device: SessionDevice, _log: DeviceLog, signal: AbortSignal) {
    this.calls.push(`boot ${device.id}`);
    if (this.bootGate) {
      const { promise, reject } = Promise.withResolvers<never>();
      signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      await Promise.race([this.bootGate, promise]);
    }
    const b = new FakeBooted(device);
    this.booted.push(b);
    return b;
  }
  async delete(id: string) {
    this.calls.push(`delete ${id}`);
    this.disk.delete(id);
  }
  async halt(id: string) {
    this.calls.push(`halt ${id}`);
    this.running.delete(id);
  }
}

const iphone: DeviceBase = { platform: "ios", id: "A759", name: "iPhone 16", os: "iOS 18.3" };
const iphone17: DeviceBase = { platform: "ios", id: "F1A1", name: "iPhone 17 Pro", os: "iOS 26.0" };
const tiny: DeviceBase = { platform: "android", id: "TinyApp", name: "TinyApp", os: "Android API 32" };

let reg: RegistryService;
let svc: DeviceService;
let ios: FakeDriver;
let android: FakeDriver;
let S: string;
const log = () => {};

beforeEach(() => {
  reg = new RegistryService(":memory:");
  reg.upsertProject({ id: "P", name: "p", platform: "mobile" });
  S = reg.createSession({ projectId: "P", name: "s", task: "t", worktreePath: "", branch: "b" }).id;
  svc = new DeviceService(reg);
  ios = new FakeDriver("ios");
  android = new FakeDriver("android");
  svc.drivers = { ios, android };
});

describe("ensure", () => {
  test("clones once, records the clone, and returns at once while booted on that base", async () => {
    const rt = await svc.ensure(S, iphone, log);
    expect(rt.platform).toBe("ios");
    const rec = reg.getSessionDevice(S);
    expect(rec).toEqual({ platform: "ios", base: "A759", baseName: "iPhone 16", id: `${S}#1` });
    await svc.ensure(S, iphone, log);
    expect(ios.calls).toEqual([`clone A759 → ${S}#1`, `boot ${S}#1`]);
  });

  test("◼ keeps the clone; the next start boots the same clone", async () => {
    await svc.ensure(S, iphone, log);
    await svc.shutdown(S);
    expect(svc.runtime(S)).toBeNull();
    expect(svc.clone(S)?.id).toBe(`${S}#1`);
    await svc.ensure(S, iphone, log);
    expect(ios.calls).toEqual([`clone A759 → ${S}#1`, `boot ${S}#1`, `boot ${S}#1`]);
    expect(ios.booted[0]!.shutdowns).toBe(1);
  });

  test("another base or platform re-clones: the running device stops, the old clone goes first", async () => {
    await svc.ensure(S, iphone, log);
    await svc.ensure(S, iphone17, log);
    expect(ios.calls).toEqual([`clone A759 → ${S}#1`, `boot ${S}#1`, `delete ${S}#1`, `clone F1A1 → ${S}#2`, `boot ${S}#2`]);
    expect(ios.booted[0]!.shutdowns).toBe(1);
    await svc.ensure(S, tiny, log);
    expect(ios.calls.at(-1)).toBe(`delete ${S}#2`);
    expect(android.calls).toEqual([`clone TinyApp → ${S}#1`, `boot ${S}#1`]);
    expect(reg.getSessionDevice(S)).toMatchObject({ platform: "android", base: "TinyApp" });
  });

  test("a clone deleted behind Kermanych's back is made again", async () => {
    await svc.ensure(S, iphone, log);
    await svc.shutdown(S);
    ios.disk.clear();
    await svc.ensure(S, iphone, log);
    expect(ios.calls.slice(2)).toEqual([`clone A759 → ${S}#2`, `boot ${S}#2`]);
  });

  test("a running base cannot be cloned and nothing is recorded", async () => {
    ios.baseRunning = true;
    await expect(svc.ensure(S, iphone, log)).rejects.toThrow("Закрийте iPhone 16");
    expect(reg.getSessionDevice(S)).toBeNull();
  });

  test("◼ during the boot rejects the start at once and leaves nothing running", async () => {
    ios.bootGate = new Promise(() => {});
    const ctl = new AbortController();
    const start = svc.ensure(S, iphone, log, ctl.signal);
    await new Promise((r) => setTimeout(r, 10));
    ctl.abort(new Error("stopped by the operator"));
    await expect(start).rejects.toThrow("stopped by the operator");
    expect(svc.runtime(S)).toBeNull();
    // shutdown() also cancels a start in flight.
    const second = svc.ensure(S, iphone, log);
    await new Promise((r) => setTimeout(r, 10));
    await svc.shutdown(S);
    await expect(second).rejects.toThrow("the preview was stopped");
    expect(svc.runtime(S)).toBeNull();
  });
});

describe("exits and removal", () => {
  test("a device that goes away by itself is an exit; Kermanych's own shutdown is not", async () => {
    const exits: string[] = [];
    svc.exits$.subscribe((e) => exits.push(`${e.sessionId}: ${e.reason}`));
    await svc.ensure(S, iphone, log);
    await svc.shutdown(S);
    await svc.ensure(S, iphone, log);
    ios.booted[1]!.exit("the simulator shut down (Shutdown)");
    await new Promise((r) => setTimeout(r, 0));
    expect(exits).toEqual([`${S}: the simulator shut down (Shutdown)`]);
    expect(svc.runtime(S)).toBeNull();
    // The clone stays: only the device went.
    expect(svc.clone(S)).not.toBeNull();
  });

  test("remove shuts down, deletes the clone and forgets it; without a clone it does nothing", async () => {
    await svc.remove(S);
    expect(ios.calls).toEqual([]);
    await svc.ensure(S, iphone, log);
    await svc.remove(S);
    expect(ios.booted[0]!.shutdowns).toBe(1);
    expect(ios.calls.at(-1)).toBe(`delete ${S}#1`);
    expect(reg.getSessionDevice(S)).toBeNull();
    expect(svc.clone(S)).toBeNull();
  });

  test("quitting shuts every booted device down and keeps the clones", async () => {
    const S2 = reg.createSession({ projectId: "P", name: "s2", task: "t", worktreePath: "", branch: "b2" }).id;
    await svc.ensure(S, iphone, log);
    await svc.ensure(S2, tiny, log);
    await svc.onModuleDestroy();
    expect(ios.booted[0]!.shutdowns + android.booted[0]!.shutdowns).toBe(2);
    expect(reg.getSessionDevice(S)).not.toBeNull();
    expect(reg.getSessionDevice(S2)).not.toBeNull();
  });
});

describe("actions and the operator's screen", () => {
  test("a button the platform lacks is refused", async () => {
    await svc.ensure(S, iphone, log);
    await expect(svc.press(S, "back")).rejects.toThrow('an iOS device has no "back" button');
    await svc.press(S, "home");
    expect(ios.booted[0]!.buttons).toEqual(["home"]);
  });

  test("operator input is in fractions, mapped to the device's screen", async () => {
    await svc.ensure(S, iphone, log);
    await svc.input(S, { type: "touch", phase: "begin", x: 0.5, y: 0.25 });
    await svc.input(S, { type: "touch", phase: "end", x: 1, y: 1 });
    expect(ios.booted[0]!.touches).toEqual(["begin 200,200", "end 400,800"]);
  });

  test("no device: actions say to start the preview", async () => {
    await expect(svc.tree(S)).rejects.toThrow("start the preview first");
  });

  test("one upstream at the largest watcher size, restarted on Android when it grows, gone without watchers, resumed after a reboot", async () => {
    await svc.ensure(S, tiny, log);
    const dev = android.booted[0]!;
    const a: DeviceFrame[] = [];
    const b: DeviceFrame[] = [];
    const stopA = svc.watch(S, { width: 300, height: 600 }, (f) => a.push(f));
    expect(dev.streams.map((s) => s.size)).toEqual([{ width: 300, height: 600 }]);
    const stopB = svc.watch(S, { width: 540, height: 400 }, (f) => b.push(f));
    expect(dev.streams.map((s) => [s.size, s.stopped])).toEqual([
      [{ width: 300, height: 600 }, true],
      [{ width: 540, height: 600 }, false],
    ]);
    dev.streams[1]!.sink("rgb888", 270, 600, Buffer.alloc(3));
    expect(a.map((f) => f.sessionId)).toEqual([S]);
    expect(b).toHaveLength(1);
    stopB();
    expect(dev.streams.at(-1)!.size).toEqual({ width: 300, height: 600 });
    stopA();
    expect(dev.streams.every((s) => s.stopped)).toBe(true);
    // A watcher outlives the device: the next boot streams to it again.
    svc.watch(S, { width: 100, height: 200 }, () => {});
    await svc.shutdown(S);
    await svc.ensure(S, tiny, log);
    expect(android.booted[1]!.streams.map((s) => s.stopped)).toEqual([false]);
  });

  test("iOS frames come at the simulator's size: a new watcher size does not restart the stream", async () => {
    await svc.ensure(S, iphone, log);
    svc.watch(S, { width: 300, height: 600 }, () => {});
    svc.watch(S, { width: 900, height: 1800 }, () => {});
    expect(ios.booted[0]!.streams).toHaveLength(1);
  });

  test("the pause is per session", () => {
    svc.setPaused(S, true);
    expect(svc.paused(S)).toBe(true);
    expect(svc.paused("other")).toBe(false);
    svc.setPaused(S, false);
    expect(svc.paused(S)).toBe(false);
  });
});

describe("sweep", () => {
  test("a clone being made while the sweep lists clones is judged after its start, not deleted", async () => {
    const { promise: gate, resolve: release } = Promise.withResolvers<void>();
    ios.cloneGate = gate;
    const start = svc.ensure(S, iphone, log);
    await new Promise((r) => setTimeout(r, 0));
    // The clone is on disk and not recorded yet: a sweep reading the registry now would call it
    // an orphan.
    expect(reg.getSessionDevice(S)).toBeNull();
    const sweep = svc.sweep();
    await new Promise((r) => setTimeout(r, 10));
    release();
    await start;
    await sweep;
    expect(ios.calls).toEqual([`clone A759 → ${S}#1`, `boot ${S}#1`]);
    expect(svc.runtime(S)).not.toBeNull();
  });

  test("a start after the sweep began waits for its verdict", async () => {
    const { promise: gate, resolve: release } = Promise.withResolvers<void>();
    const slowDelete = ios.delete.bind(ios);
    ios.delete = async (id: string) => {
      await gate;
      await slowDelete(id);
    };
    // An unrecorded leftover of S itself: the sweep deletes it before S's start clones anew.
    ios.disk.set(`${S}#9`, "A759");
    const sweep = svc.sweep();
    await new Promise((r) => setTimeout(r, 10));
    const start = svc.ensure(S, iphone, log);
    await new Promise((r) => setTimeout(r, 10));
    expect(ios.calls).toEqual([]);
    release();
    await Promise.all([sweep, start]);
    expect(ios.calls).toEqual([`delete ${S}#9`, `clone A759 → ${S}#1`, `boot ${S}#1`]);
    expect([...ios.disk.keys()]).toEqual([`${S}#1`]);
  });

  test("deletes orphans, halts a live session's clone left running, keeps the rest", async () => {
    // S's recorded clone, left running by an api that died.
    reg.setSessionDevice(S, { platform: "ios", base: "A759", baseName: "iPhone 16", id: `${S}#1` });
    ios.disk.set(`${S}#1`, "A759");
    ios.running.add(`${S}#1`);
    // An unrecorded second clone of S, and a clone of a session that no longer exists.
    ios.disk.set(`${S}#7`, "A759");
    ios.disk.set("gone#1", "A759");
    await svc.sweep();
    expect(ios.calls.sort()).toEqual([`delete ${S}#7`, "delete gone#1", `halt ${S}#1`].sort());
    expect([...ios.disk.keys()]).toEqual([`${S}#1`]);
  });
});

describe("info", () => {
  test("the clone, the choice, the pause and the next device", async () => {
    ios.bases = async () => [iphone17, iphone];
    android.bases = async () => [tiny];
    svc.setChoice("P", { platform: "android", android: "TinyApp", ios: 5 as unknown as string });
    let info = await svc.info(S, "P", ["ios", "android"]);
    expect(info.choice).toEqual({ platform: "android", android: "TinyApp" });
    expect(info.bases.map((b) => b.id)).toEqual(["F1A1", "A759", "TinyApp"]);
    expect(info.next).toEqual({ platform: "android", base: tiny });
    expect(info.clone).toBeNull();
    await svc.ensure(S, iphone, log);
    svc.setPaused(S, true);
    info = await svc.info(S, "P", ["ios", "android"]);
    expect(info.next).toEqual({ platform: "ios", base: iphone });
    expect(info.clone).toMatchObject({ platform: "ios", base: "A759" });
    expect(info.paused).toBe(true);
    expect(info.platforms).toEqual(["ios", "android"]);
  });
});
