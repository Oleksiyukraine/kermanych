// apps/api/test/fake-device.ts
// A fake DeviceApi (apps/api/src/device/device.contract.ts) for the specs of its consumers: the
// preview, the agent tools and the supervisor never boot a real simulator
// (docs/plans/2026-11-03-mobile-device-preview.md: only the device slice does). It keeps the
// little state those consumers observe — the booted runtime, the app's liveness, the choice,
// the pause — and records the lifecycle calls in `calls`, in order.
import { existsSync, rmSync } from "node:fs";
import { Subject } from "rxjs";
import { vi } from "vitest";
import type { DeviceBase, DeviceChoice, DeviceElement, DevicePlatform, DeviceRuntime, DeviceToolStatus, SessionDevice } from "@kermanych/core";
import type { DeviceApi, DeviceExit } from "../src/device/device.contract";

export const IOS_BASE: DeviceBase = { platform: "ios", id: "IOS-BASE-UDID", name: "iPhone 16", os: "iOS 18.3" };
export const ANDROID_BASE: DeviceBase = { platform: "android", id: "Pixel_8", name: "Pixel 8", os: "Android 14" };

export type FakeDeviceOptions = {
  bases?: DeviceBase[];
  tools?: Record<DevicePlatform, DeviceToolStatus>;
  // The app also counts as running while this file exists: a real `"device": true` service
  // (a child process of the spec) touches it, the way `flutter run` starts the app.
  appMarker?: () => string | undefined;
};

export function fakeDevice(opts: FakeDeviceOptions = {}) {
  const bases = opts.bases ?? [IOS_BASE, ANDROID_BASE];
  const tools = opts.tools ?? { ios: { ok: true as const }, android: { ok: true as const } };
  const exits$ = new Subject<DeviceExit>();
  const calls: string[] = [];
  const runtimes = new Map<string, DeviceRuntime>();
  const choices = new Map<string, DeviceChoice>();
  const paused = new Set<string>();
  const clones = new Map<string, SessionDevice>();
  // `${sessionId} ${app}` → running.
  const apps = new Map<string, boolean>();
  const logListeners = new Map<string, (line: string) => void>();
  let tree: DeviceElement[] = [];

  const running = (sessionId: string, app: string): boolean => {
    const marker = opts.appMarker?.();
    return apps.get(`${sessionId} ${app}`) === true || (marker !== undefined && existsSync(marker));
  };

  const device = {
    exits$,
    tools: vi.fn(async () => tools),
    bases: vi.fn(async () => bases),
    choice: vi.fn((projectId: string): DeviceChoice => choices.get(projectId) ?? {}),
    setChoice: vi.fn((projectId: string, choice: DeviceChoice): DeviceChoice => {
      choices.set(projectId, choice);
      return choice;
    }),
    // The session's clone when its platform is configured, else the project's choice, else the
    // first base of the first configured platform — the real service's order.
    info: vi.fn(async (sessionId: string, projectId: string, platforms: DevicePlatform[]) => {
      const choice = choices.get(projectId) ?? {};
      const usable = platforms.filter((p) => tools[p].ok);
      const clone = clones.get(sessionId) ?? null;
      if (clone && usable.includes(clone.platform)) {
        const base = bases.find((b) => b.id === clone.base) ?? { platform: clone.platform, id: clone.base, name: clone.baseName, os: "" };
        return { tools, bases, choice, platforms, next: { platform: clone.platform, base }, clone, paused: false };
      }
      const platform = choice.platform && usable.includes(choice.platform) ? choice.platform : usable[0];
      const base = platform ? (bases.find((b) => b.platform === platform && b.id === choice[platform]) ?? bases.find((b) => b.platform === platform)) : undefined;
      return { tools, bases, choice, platforms, next: platform && base ? { platform, base } : null, clone, paused: false };
    }),
    clone: vi.fn((sessionId: string) => clones.get(sessionId) ?? null),
    ensure: vi.fn(async (sessionId: string, base: DeviceBase, log: (line: string) => void, _signal?: AbortSignal): Promise<DeviceRuntime> => {
      calls.push(`ensure ${base.id}`);
      log(`booting ${base.name}`);
      const runtime: DeviceRuntime = {
        platform: base.platform,
        serial: base.platform === "ios" ? "SIM-UDID-1" : "emulator-5584",
        name: base.name,
        screen: base.platform === "ios" ? { width: 393, height: 852 } : { width: 1080, height: 2400 },
      };
      runtimes.set(sessionId, runtime);
      clones.set(sessionId, { platform: base.platform, base: base.id, baseName: base.name, id: `kermanych-${sessionId}` });
      return runtime;
    }),
    runtime: vi.fn((sessionId: string) => runtimes.get(sessionId) ?? null),
    shutdown: vi.fn(async (sessionId: string) => {
      calls.push("shutdown");
      runtimes.delete(sessionId);
    }),
    remove: vi.fn(async (sessionId: string) => {
      calls.push("remove");
      runtimes.delete(sessionId);
      clones.delete(sessionId);
    }),
    launch: vi.fn(async (sessionId: string, app: string) => {
      calls.push(`launch ${app}`);
      apps.set(`${sessionId} ${app}`, true);
    }),
    // Kills the app however it was started, a device service's included.
    terminate: vi.fn(async (sessionId: string, app: string) => {
      calls.push(`terminate ${app}`);
      apps.set(`${sessionId} ${app}`, false);
      const marker = opts.appMarker?.();
      if (marker !== undefined) rmSync(marker, { force: true });
    }),
    appRunning: vi.fn(async (sessionId: string, app: string) => running(sessionId, app)),
    appLogs: vi.fn((sessionId: string, _app: string, onLine: (line: string) => void) => {
      logListeners.set(sessionId, onLine);
      return () => {
        if (logListeners.get(sessionId) === onLine) logListeners.delete(sessionId);
      };
    }),
    screenshot: vi.fn(async () => Buffer.from("iVBORw0K", "base64")),
    tree: vi.fn(async () => tree),
    tap: vi.fn(async (_sessionId: string, _x: number, _y: number) => {}),
    swipe: vi.fn(async (_sessionId: string, _from: { x: number; y: number }, _to: { x: number; y: number }, _ms: number) => {}),
    type: vi.fn(async (_sessionId: string, _text: string) => {}),
    press: vi.fn(async () => {}),
    openUrl: vi.fn(async () => {}),
    rotate: vi.fn(async () => {}),
    watch: vi.fn(() => () => {}),
    input: vi.fn(async () => {}),
    pick: vi.fn(async () => {
      throw new Error("not in this fake");
    }),
    paused: vi.fn((sessionId: string) => paused.has(sessionId)),
    setPaused: vi.fn((sessionId: string, on: boolean) => {
      if (on) paused.add(sessionId);
      else paused.delete(sessionId);
    }),
  } satisfies DeviceApi;

  return {
    device,
    calls,
    // The app exits or comes back by itself (a crash, the operator's relaunch).
    setApp: (sessionId: string, app: string, on: boolean) => apps.set(`${sessionId} ${app}`, on),
    // A line of the app's own log, as `log stream` / logcat would give it.
    appLog: (sessionId: string, line: string) => logListeners.get(sessionId)?.(line),
    setTree: (next: DeviceElement[]) => (tree = next),
    boot: (sessionId: string, runtime: DeviceRuntime) => runtimes.set(sessionId, runtime),
    // A clone an earlier api run made (its base may be gone from `bases` since).
    setClone: (sessionId: string, clone: SessionDevice) => clones.set(sessionId, clone),
  };
}

// A tree node with defaults, for the specs' trees.
export function el(type: string, label: string | null, frame: [number, number, number, number], more: Partial<DeviceElement> = {}): DeviceElement {
  return { type, label, id: null, value: null, frame: { x: frame[0], y: frame[1], width: frame[2], height: frame[3] }, enabled: true, children: [], ...more };
}
