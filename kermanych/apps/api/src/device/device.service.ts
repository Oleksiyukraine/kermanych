// apps/api/src/device/device.service.ts
// The session's virtual device (docs/specs/2026-11-03-mobile-device-preview.md): a per-session
// copy-on-write clone of an iOS simulator or an Android AVD (decision 4), booted headless for the
// preview's `device` step, streamed to the operator and driven by the agent's `device_*` tools.
//
// The api owns every device (decision 12), so the web build gets the same screen as the desktop
// app. The clone record and the project's choice live in the local registry only (decision 6);
// the pause is in memory (decision 9). Nothing here starts a device by itself: PreviewService
// calls ensure() and shutdown().
import { Injectable, type OnModuleDestroy, type OnModuleInit } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { Observable, Subject } from "rxjs";
import {
  DEVICE_CLONE_PREFIX,
  DEVICE_PLATFORMS,
  DEVICE_PLATFORM_BUTTONS,
  isDevicePlatform,
  type DeviceBase,
  type DeviceButton,
  type DeviceChoice,
  type DeviceElement,
  type DeviceFrame,
  type DeviceInfo,
  type DeviceInput,
  type DeviceOrientation,
  type DevicePick,
  type DevicePlatform,
  type DeviceRuntime,
  type DeviceToolStatus,
  type SessionDevice,
} from "@kermanych/core";
import { RegistryService } from "../registry/registry.service";
import type { DeviceApi, DeviceExit } from "./device.contract";
import type { BootedDevice, DeviceDriver, DeviceLog } from "./device.driver";
import { cloneName, cropRect, nextDevice, pickElement, pngSize, selectOrphans } from "./device-parse";
import { abortError, run } from "./device-proc";
import { IosDriver } from "./ios.driver";
import { AndroidDriver } from "./android.driver";

// A changed toolchain (Xcode installed, the SDK moved) shows within this long.
const TOOLS_TTL_MS = 30_000;
// The pick's crop reaches this far around the element (screen units).
const PICK_MARGIN = 8;
const TAP_HOLD_MS = 50;

type Watcher = { size: { width: number; height: number }; onFrame: (f: DeviceFrame) => void };

type Live = {
  device: SessionDevice;
  booted: BootedDevice;
  stream: { size: { width: number; height: number }; stop: () => void } | null;
};

@Injectable()
export class DeviceService implements DeviceApi, OnModuleInit, OnModuleDestroy {
  // Replaced by specs with fakes; the api never changes them.
  drivers: Record<DevicePlatform, DeviceDriver> = { ios: new IosDriver(), android: new AndroidDriver() };

  private live = new Map<string, Live>();
  // One lifecycle operation per session at a time (ensure, shutdown, remove).
  private ops = new Map<string, Promise<unknown>>();
  // The ensure() in flight per session; shutdown and remove cancel it.
  private inflight = new Map<string, AbortController>();
  private watchers = new Map<string, Set<Watcher>>();
  private pausedSessions = new Set<string>();
  private toolsCache: { at: number; value: Promise<Record<DevicePlatform, DeviceToolStatus>> } | null = null;
  private exits = new Subject<DeviceExit>();
  readonly exits$: Observable<DeviceExit> = this.exits.asObservable();

  constructor(private registry: RegistryService) {}

  // The orphan sweep of decision 4, under PreviewService.sweep's rule: only the api on the
  // machine's own registry. One on a custom KERMANYCH_DB (preview mode, a test) knows none of the
  // real sessions and would delete their clones.
  onModuleInit(): void {
    if (process.env.KERMANYCH_DB) return;
    void this.sweep().catch((err: unknown) => console.warn(`[device] sweep failed: ${(err as Error).message}`));
  }

  // Orphans are deleted. A clone of a live session left running by an api that died is shut
  // down: nothing runs after a relaunch until the operator starts it (decision 11).
  //
  // The sweep runs in the background while the api is already up, so each clone is judged inside
  // its session's own lifecycle queue, from a fresh registry read: a start that is cloning or
  // booting finishes (and records its clone) first, and a start that comes later waits for the
  // verdict instead of racing it.
  async sweep(): Promise<void> {
    const tools = await this.tools();
    const verdicts: Promise<void>[] = [];
    for (const platform of DEVICE_PLATFORMS) {
      if (!tools[platform].ok) continue;
      const driver = this.drivers[platform];
      for (const c of await driver.clones()) {
        const sessionId = c.name.slice(DEVICE_CLONE_PREFIX.length);
        const verdict = this.serialize(sessionId, async () => {
          if (this.live.has(sessionId)) return;
          const known = this.registry.listSessions().some((s) => s.id === sessionId);
          const sessions = new Map(known ? [[sessionId, this.registry.getSessionDevice(sessionId)]] : []);
          if (selectOrphans([c], sessions).length) {
            console.warn(`[device] deleting the orphan clone ${c.name} (${c.id})`);
            await driver.delete(c.id);
          } else if (c.running) {
            console.warn(`[device] shutting down ${c.name}, left running by an earlier api`);
            await driver.halt(c.id);
          }
        });
        verdicts.push(verdict.catch((err: unknown) => console.warn(`[device] sweeping ${c.name} failed: ${(err as Error).message}`)));
      }
    }
    await Promise.all(verdicts);
  }

  // Kermanych quits (decision 11): every device shuts down, the clones stay.
  async onModuleDestroy(): Promise<void> {
    for (const ctl of this.inflight.values()) ctl.abort(new Error("Kermanych is quitting"));
    await Promise.all([...this.live.keys()].map((id) => this.stopLive(id).catch(() => {})));
  }

  // ── This machine ──────────────────────────────────────────────────────────

  tools(): Promise<Record<DevicePlatform, DeviceToolStatus>> {
    if (!this.toolsCache || Date.now() - this.toolsCache.at > TOOLS_TTL_MS) {
      const value = Promise.all(DEVICE_PLATFORMS.map((p) => this.drivers[p].tools().catch((err: unknown) => ({ ok: false as const, reason: (err as Error).message })))).then(
        ([ios, android]) => ({ ios: ios!, android: android! }),
      );
      this.toolsCache = { at: Date.now(), value };
    }
    return this.toolsCache.value;
  }

  async bases(): Promise<DeviceBase[]> {
    const tools = await this.tools();
    const lists = await Promise.all(
      DEVICE_PLATFORMS.map((p) =>
        tools[p].ok
          ? this.drivers[p].bases().catch((err: unknown) => {
              console.warn(`[device] listing ${p} devices failed: ${(err as Error).message}`);
              return [];
            })
          : [],
      ),
    );
    return lists.flat();
  }

  // ── The project's choice ──────────────────────────────────────────────────

  choice(projectId: string): DeviceChoice {
    return this.registry.getDeviceChoice(projectId);
  }

  setChoice(projectId: string, choice: DeviceChoice): DeviceChoice {
    const next: DeviceChoice = {
      ...(isDevicePlatform(choice.platform) ? { platform: choice.platform } : {}),
      ...(typeof choice.ios === "string" && choice.ios ? { ios: choice.ios } : {}),
      ...(typeof choice.android === "string" && choice.android ? { android: choice.android } : {}),
    };
    this.registry.setDeviceChoice(projectId, next);
    return this.registry.getDeviceChoice(projectId);
  }

  async info(sessionId: string, projectId: string, platforms: DevicePlatform[]): Promise<DeviceInfo> {
    const [tools, bases] = await Promise.all([this.tools(), this.bases()]);
    const choice = this.choice(projectId);
    const clone = this.clone(sessionId);
    return { tools, bases, choice, platforms, next: nextDevice(platforms, tools, bases, choice, clone), clone, paused: this.paused(sessionId) };
  }

  // ── The session's clone ───────────────────────────────────────────────────

  clone(sessionId: string): SessionDevice | null {
    return this.live.get(sessionId)?.device ?? this.registry.getSessionDevice(sessionId);
  }

  runtime(sessionId: string): DeviceRuntime | null {
    const r = this.live.get(sessionId)?.booted.runtime;
    return r ? { ...r, screen: { ...r.screen } } : null;
  }

  async ensure(sessionId: string, base: DeviceBase, log: DeviceLog, signal?: AbortSignal): Promise<DeviceRuntime> {
    const same = (l: Live | undefined) => l && l.device.platform === base.platform && l.device.base === base.id;
    const cur = this.live.get(sessionId);
    if (same(cur)) return this.runtime(sessionId)!;
    if (signal?.aborted) throw abortError(signal);
    const ctl = new AbortController();
    const sig = signal ? AbortSignal.any([ctl.signal, signal]) : ctl.signal;
    this.inflight.get(sessionId)?.abort(new Error("a newer start replaced this one"));
    this.inflight.set(sessionId, ctl);
    const op = this.serialize(sessionId, async () => {
      try {
        if (sig.aborted) throw abortError(sig);
        if (same(this.live.get(sessionId))) return this.runtime(sessionId)!;
        await this.stopLive(sessionId);
        return await this.bootClone(sessionId, base, log, sig);
      } finally {
        if (this.inflight.get(sessionId) === ctl) this.inflight.delete(sessionId);
      }
    });
    // ◼ during the boot answers at once; the boot notices the same signal and cleans up behind.
    const { promise: aborted, reject } = Promise.withResolvers<never>();
    const onAbort = () => reject(abortError(sig));
    sig.addEventListener("abort", onAbort, { once: true });
    try {
      return await Promise.race([op, aborted]);
    } finally {
      sig.removeEventListener("abort", onAbort);
      aborted.catch(() => {});
    }
  }

  private async bootClone(sessionId: string, base: DeviceBase, log: DeviceLog, sig: AbortSignal): Promise<DeviceRuntime> {
    const driver = this.drivers[base.platform];
    let rec = this.registry.getSessionDevice(sessionId);
    // Decision 6: another base or platform is a re-clone; the old clone goes first.
    if (rec && (rec.platform !== base.platform || rec.base !== base.id)) {
      log(`the base device changed (${rec.baseName} → ${base.name}): deleting the old clone`);
      await this.drivers[rec.platform].delete(rec.id);
      this.registry.setSessionDevice(sessionId, null);
      rec = null;
    }
    if (rec && !(await driver.exists(rec.id))) {
      log(`the clone ${rec.id} is gone: cloning ${base.name} again`);
      this.registry.setSessionDevice(sessionId, null);
      rec = null;
    }
    if (!rec) {
      const id = await driver.clone(base, cloneName(sessionId), log, sig);
      rec = { platform: base.platform, base: base.id, baseName: base.name, id };
      this.registry.setSessionDevice(sessionId, rec);
    }
    const booted = await driver.boot(rec, log, sig);
    if (sig.aborted) {
      await booted.shutdown().catch(() => {});
      throw abortError(sig);
    }
    const live: Live = { device: rec, booted, stream: null };
    this.live.set(sessionId, live);
    void booted.exited.then((reason) => {
      // Kermanych's own shutdown takes the device out of `live` first.
      if (this.live.get(sessionId) !== live) return;
      this.live.delete(sessionId);
      live.stream?.stop();
      log(`the device went away: ${reason}`);
      this.exits.next({ sessionId, reason });
    });
    this.refreshStream(sessionId);
    return this.runtime(sessionId)!;
  }

  // ◼ and archive. No device and nothing in flight: nothing to do.
  async shutdown(sessionId: string): Promise<void> {
    this.inflight.get(sessionId)?.abort(new Error("the preview was stopped"));
    if (!this.live.has(sessionId) && !this.ops.has(sessionId)) return;
    await this.serialize(sessionId, () => this.stopLive(sessionId));
  }

  // «Завершити» and delete. A session that never had a clone costs one registry read.
  async remove(sessionId: string): Promise<void> {
    this.inflight.get(sessionId)?.abort(new Error("the session is being removed"));
    if (!this.live.has(sessionId) && !this.ops.has(sessionId) && !this.registry.getSessionDevice(sessionId)) return;
    await this.serialize(sessionId, async () => {
      const rec = this.live.get(sessionId)?.device ?? this.registry.getSessionDevice(sessionId);
      await this.stopLive(sessionId);
      if (rec) await this.drivers[rec.platform].delete(rec.id);
      this.registry.setSessionDevice(sessionId, null);
    });
  }

  private async stopLive(sessionId: string): Promise<void> {
    const live = this.live.get(sessionId);
    if (!live) return;
    this.live.delete(sessionId);
    live.stream?.stop();
    live.stream = null;
    await live.booted.shutdown();
  }

  private serialize<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.ops.get(sessionId) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    const settled = next.catch(() => {});
    this.ops.set(sessionId, settled);
    void settled.then(() => {
      if (this.ops.get(sessionId) === settled) this.ops.delete(sessionId);
    });
    return next;
  }

  private booted(sessionId: string): Live {
    const live = this.live.get(sessionId);
    if (!live) throw new Error("no device is running for this session: start the preview first");
    return live;
  }

  // ── The app ───────────────────────────────────────────────────────────────

  async launch(sessionId: string, app: string): Promise<void> {
    return this.booted(sessionId).booted.launch(app);
  }

  async terminate(sessionId: string, app: string): Promise<void> {
    return this.booted(sessionId).booted.terminate(app);
  }

  async appRunning(sessionId: string, app: string): Promise<boolean> {
    return this.booted(sessionId).booted.appRunning(app);
  }

  appLogs(sessionId: string, app: string, onLine: (line: string) => void): () => void {
    return this.booted(sessionId).booted.appLogs(app, onLine);
  }

  // ── Actions ───────────────────────────────────────────────────────────────

  async screenshot(sessionId: string): Promise<Buffer> {
    return this.booted(sessionId).booted.screenshot();
  }

  async tree(sessionId: string): Promise<DeviceElement[]> {
    return this.booted(sessionId).booted.tree();
  }

  async tap(sessionId: string, x: number, y: number): Promise<void> {
    const { booted } = this.booted(sessionId);
    await booted.touch("begin", x, y);
    await sleep(TAP_HOLD_MS);
    await booted.touch("end", x, y);
  }

  // A live drag of ~60 moves a second, the way a finger moves.
  async swipe(sessionId: string, from: { x: number; y: number }, to: { x: number; y: number }, durationMs: number): Promise<void> {
    const { booted } = this.booted(sessionId);
    const steps = Math.max(2, Math.round(durationMs / 16));
    await booted.touch("begin", from.x, from.y);
    for (let i = 1; i <= steps; i++) {
      await sleep(durationMs / steps);
      await booted.touch("move", from.x + ((to.x - from.x) * i) / steps, from.y + ((to.y - from.y) * i) / steps);
    }
    await booted.touch("end", to.x, to.y);
  }

  async type(sessionId: string, text: string): Promise<void> {
    return this.booted(sessionId).booted.typeText(text);
  }

  async press(sessionId: string, button: DeviceButton): Promise<void> {
    const live = this.booted(sessionId);
    if (!DEVICE_PLATFORM_BUTTONS[live.device.platform].includes(button)) {
      throw new Error(`an ${live.device.platform === "ios" ? "iOS" : "Android"} device has no "${button}" button`);
    }
    await live.booted.button(button);
  }

  async openUrl(sessionId: string, url: string): Promise<void> {
    return this.booted(sessionId).booted.openUrl(url);
  }

  async rotate(sessionId: string, orientation: DeviceOrientation): Promise<void> {
    return this.booted(sessionId).booted.rotate(orientation);
  }

  // ── The operator's screen ─────────────────────────────────────────────────

  // A watcher outlives the device: frames resume when the session's device boots again.
  watch(sessionId: string, size: { width: number; height: number }, onFrame: (f: DeviceFrame) => void): () => void {
    const w: Watcher = { size: { width: Math.max(1, Math.round(size.width) || 1), height: Math.max(1, Math.round(size.height) || 1) }, onFrame };
    let set = this.watchers.get(sessionId);
    if (!set) this.watchers.set(sessionId, (set = new Set()));
    set.add(w);
    this.refreshStream(sessionId);
    return () => {
      const s = this.watchers.get(sessionId);
      if (!s?.delete(w)) return;
      if (!s.size) this.watchers.delete(sessionId);
      this.refreshStream(sessionId);
    };
  }

  // One upstream per device, at the largest size any watcher asked for; none without a watcher.
  private refreshStream(sessionId: string): void {
    const live = this.live.get(sessionId);
    if (!live) return;
    const set = this.watchers.get(sessionId);
    if (!set?.size) {
      live.stream?.stop();
      live.stream = null;
      return;
    }
    const size = { width: Math.max(...[...set].map((w) => w.size.width)), height: Math.max(...[...set].map((w) => w.size.height)) };
    // iOS frames come at the simulator's own size: a new size changes nothing upstream.
    if (live.stream && (live.device.platform === "ios" || (live.stream.size.width === size.width && live.stream.size.height === size.height))) return;
    live.stream?.stop();
    const stop = live.booted.stream(size, (kind, width, height, data) => {
      const frame: DeviceFrame = { sessionId, kind, width, height, data };
      for (const w of this.watchers.get(sessionId) ?? []) w.onFrame(frame);
    });
    live.stream = { size, stop };
  }

  async input(sessionId: string, input: DeviceInput): Promise<void> {
    const { booted } = this.booted(sessionId);
    const { width, height } = booted.runtime.screen;
    switch (input.type) {
      case "touch":
        return booted.touch(input.phase, input.x * width, input.y * height);
      case "scroll":
        return booted.scroll(input.x * width, input.y * height, input.dx * width, input.dy * height);
      case "text":
        return booted.typeText(input.text);
      case "key":
        return booted.key(input.key);
      case "button":
        return this.press(sessionId, input.button);
      case "rotate":
        return booted.rotate(input.orientation);
    }
  }

  async pick(sessionId: string, point: { x: number; y: number }): Promise<DevicePick> {
    const { booted } = this.booted(sessionId);
    const screen = { ...booted.runtime.screen };
    const at = { x: point.x * screen.width, y: point.y * screen.height };
    const [tree, png] = await Promise.all([booted.tree().catch(() => [] as DeviceElement[]), booted.screenshot()]);
    const el = pickElement(tree, at, screen);
    const shot = el ? await cropPng(png, cropRect(el.frame, screen, pngSize(png) ?? screen, PICK_MARGIN)) : png;
    return {
      platform: booted.runtime.platform,
      deviceName: booted.runtime.name,
      screen,
      point: { x: Math.round(at.x), y: Math.round(at.y) },
      element: el ? { type: el.type, label: el.label, id: el.id, value: el.value, frame: el.frame, enabled: el.enabled } : null,
      screenshot: { data: shot.toString("base64"), mimeType: "image/png" },
    };
  }

  // ── The operator's «Агент» pause ──────────────────────────────────────────

  paused(sessionId: string): boolean {
    return this.pausedSessions.has(sessionId);
  }

  setPaused(sessionId: string, paused: boolean): void {
    if (paused) this.pausedSessions.add(sessionId);
    else this.pausedSessions.delete(sessionId);
  }
}

// macOS `sips`: the api may run without Electron, so no nativeImage.
async function cropPng(png: Buffer, rect: { x: number; y: number; width: number; height: number }): Promise<Buffer> {
  const id = randomUUID();
  const src = join(tmpdir(), `kermanych-pick-${id}.png`);
  const dst = join(tmpdir(), `kermanych-pick-${id}-crop.png`);
  try {
    await writeFile(src, png);
    await run("sips", ["-c", String(rect.height), String(rect.width), "--cropOffset", String(rect.y), String(rect.x), src, "--out", dst], { timeoutMs: 30_000 });
    return await readFile(dst);
  } catch {
    return png;
  } finally {
    await rm(src, { force: true });
    await rm(dst, { force: true });
  }
}
