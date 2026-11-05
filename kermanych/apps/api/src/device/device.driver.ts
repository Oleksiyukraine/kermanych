// apps/api/src/device/device.driver.ts
// One driver per platform behind one interface (docs/specs/2026-11-03-mobile-device-preview.md,
// «Where the code lives»): the machine's tooling and base devices, the clones, and a booted
// device. DeviceService owns the sessions, the registry records and the operator's watchers; a
// driver knows only devices.
import type {
  DeviceBase,
  DeviceButton,
  DeviceElement,
  DeviceOrientation,
  DevicePlatform,
  DeviceRuntime,
  DeviceToolStatus,
  SessionDevice,
} from "@kermanych/core";
import type { CloneOnDisk } from "./device-parse";

export type DeviceLog = (line: string) => void;

export type FrameSink = (kind: "jpeg" | "rgb888", width: number, height: number, data: Buffer) => void;

export interface DeviceDriver {
  readonly platform: DevicePlatform;
  tools(): Promise<DeviceToolStatus>;
  // The base devices, clones excluded.
  bases(): Promise<DeviceBase[]>;
  // Every `kermanych-*` device of this platform on the machine (the orphan sweep, remove()).
  clones(): Promise<CloneOnDisk[]>;
  exists(id: string): Promise<boolean>;
  // Copies `base` as `name`; resolves with the clone's id. Rejects when the base is running.
  clone(base: DeviceBase, name: string, log: DeviceLog, signal: AbortSignal): Promise<string>;
  // Boots the clone headless and waits until it has booted. A clone left running by an earlier
  // api is shut down first, so the booted device is always this process's own.
  boot(device: SessionDevice, log: DeviceLog, signal: AbortSignal): Promise<BootedDevice>;
  // Shuts the clone down (if running) and deletes it.
  delete(id: string): Promise<void>;
  // Shuts down a clone this process did not boot (the sweep after an api that died).
  halt(id: string): Promise<void>;
}

export interface BootedDevice {
  readonly runtime: DeviceRuntime;
  // Resolves with a reason once the device is gone, by any hand. DeviceService tells
  // Kermanych's own shutdown from an exit.
  readonly exited: Promise<string>;
  shutdown(): Promise<void>;

  screenshot(): Promise<Buffer>;
  tree(): Promise<DeviceElement[]>;
  // Points in `runtime.screen` units.
  touch(phase: "begin" | "move" | "end", x: number, y: number): Promise<void>;
  // A wheel step at (x, y); dx/dy in screen units, positive = the content moves up/left.
  scroll(x: number, y: number, dx: number, dy: number): Promise<void>;
  // ASCII as keys, anything else through the device clipboard and a paste (decision 9). A
  // `secret` (a tester credential) empties the clipboard after a paste.
  typeText(text: string, opts?: { secret?: boolean }): Promise<void>;
  // A non-text key of DeviceInput `key` ("Enter", "Backspace", "ArrowLeft", …).
  key(key: string): Promise<void>;
  // Only buttons of DEVICE_PLATFORM_BUTTONS[platform]; DeviceService refuses the others.
  button(button: DeviceButton): Promise<void>;
  rotate(orientation: DeviceOrientation): Promise<void>;
  openUrl(url: string): Promise<void>;

  launch(app: string): Promise<void>;
  terminate(app: string): Promise<void>;
  appRunning(app: string): Promise<boolean>;
  // Drops the app's data so its next start is a first one (the tester's clean start): `pm clear`
  // on Android; on iOS the app is uninstalled and the keychain reset — the preview reinstalls it.
  clearApp(app: string): Promise<void>;
  appLogs(app: string, onLine: (line: string) => void): () => void;

  // The device's screen, frames no bigger than `size` where the driver can scale. One upstream
  // per call; DeviceService keeps one per device and restarts it when the size changes.
  stream(size: { width: number; height: number }, onFrame: FrameSink): () => void;
}
