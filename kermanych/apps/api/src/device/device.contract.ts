// apps/api/src/device/device.contract.ts
// What the rest of the api may ask of the session's device
// (docs/specs/2026-11-03-mobile-device-preview.md). DeviceService implements it and is provided
// under DEVICE_API, so PreviewService, BrowserMcpService and the supervisor depend on this
// interface only and their specs can pass a fake.
//
// Coordinates are `DeviceRuntime.screen` units (points on iOS, pixels on Android) unless a name
// says `fraction` (0..1 of the screen, the operator's input).
import type { Observable } from "rxjs";
import type {
  DeviceBase,
  DeviceButton,
  DeviceChoice,
  DeviceElement,
  DeviceFrame,
  DeviceInfo,
  DeviceInput,
  DeviceOrientation,
  DevicePick,
  DevicePlatform,
  DeviceRuntime,
  DeviceToolStatus,
  SessionDevice,
} from "@kermanych/core";

export const DEVICE_API = Symbol("DEVICE_API");

// The device process (simulator or emulator) went away while booted, not by Kermanych's hand.
export type DeviceExit = { sessionId: string; reason: string };

export interface DeviceApi {
  // ── This machine ──────────────────────────────────────────────────────────
  tools(): Promise<Record<DevicePlatform, DeviceToolStatus>>;
  // Every base device of the available platforms, iOS first; clones (`kermanych-*`) excluded.
  bases(): Promise<DeviceBase[]>;

  // ── The project's choice (local registry, never the cloud) ────────────────
  choice(projectId: string): DeviceChoice;
  setChoice(projectId: string, choice: DeviceChoice): DeviceChoice;

  // GET /sessions/:id/device. `platforms` are the ones the session's preview file configures.
  // `next` is the session's clone base when the clone exists and its platform is configured,
  // else the project's choice, else the default, of a configured and available platform.
  info(sessionId: string, projectId: string, platforms: DevicePlatform[]): Promise<DeviceInfo>;

  // ── The session's clone ───────────────────────────────────────────────────
  clone(sessionId: string): SessionDevice | null;
  // Clone `base` if the session has no clone, or has one of another base (the old one is
  // deleted first: decision 6), then boot it and wait until it has booted (limit 3 min).
  // Already booted on that base → returns at once. `log` receives progress lines for the
  // preview's `device` step. Rejects with a message the operator can act on ("закрийте …").
  ensure(sessionId: string, base: DeviceBase, log: (line: string) => void, signal?: AbortSignal): Promise<DeviceRuntime>;
  // Booted device of the session, or null.
  runtime(sessionId: string): DeviceRuntime | null;
  // ◼ and archive: shut the device down, keep the clone.
  shutdown(sessionId: string): Promise<void>;
  // «Завершити» and delete: shut down and delete the clone.
  remove(sessionId: string): Promise<void>;
  readonly exits$: Observable<DeviceExit>;

  // ── The app (bundle id / package from the preview file) ───────────────────
  launch(sessionId: string, app: string): Promise<void>;
  terminate(sessionId: string, app: string): Promise<void>;
  appRunning(sessionId: string, app: string): Promise<boolean>;
  // The tester's clean start (docs/specs/2026-11-04-tester-mobile-device.md, decision 1): the
  // app's data goes (`pm clear`; iOS: uninstall and a keychain reset).
  clearApp(sessionId: string, app: string): Promise<void>;
  // Follows the app's log (iOS `log stream` of its process, Android `logcat --pid`, re-attached
  // when the pid changes). Returns the stop function.
  appLogs(sessionId: string, app: string, onLine: (line: string) => void): () => void;

  // ── Actions (agent tools; the operator's go through input()) ──────────────
  screenshot(sessionId: string): Promise<Buffer>; // PNG
  tree(sessionId: string): Promise<DeviceElement[]>;
  tap(sessionId: string, x: number, y: number): Promise<void>;
  swipe(sessionId: string, from: { x: number; y: number }, to: { x: number; y: number }, durationMs: number): Promise<void>;
  // Focused field. Non-ASCII goes through the device clipboard and a paste (decision 9); a
  // `secret` empties the clipboard afterwards.
  type(sessionId: string, text: string, opts?: { secret?: boolean }): Promise<void>;
  press(sessionId: string, button: DeviceButton): Promise<void>;
  openUrl(sessionId: string, url: string): Promise<void>;
  rotate(sessionId: string, orientation: DeviceOrientation): Promise<void>;

  // ── The operator's screen ─────────────────────────────────────────────────
  // Streams frames no bigger than `size` (pixels) while subscribed. Returns the unsubscribe.
  watch(sessionId: string, size: { width: number; height: number }, onFrame: (f: DeviceFrame) => void): () => void;
  input(sessionId: string, input: DeviceInput): Promise<void>;
  // «◎ Вказати» at a fraction of the screen.
  pick(sessionId: string, point: { x: number; y: number }): Promise<DevicePick>;

  // ── The operator's «Агент» pause (decision 9) ─────────────────────────────
  paused(sessionId: string): boolean;
  setPaused(sessionId: string, paused: boolean): void;
}
