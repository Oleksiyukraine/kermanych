// The session's virtual device (docs/specs/2026-11-03-mobile-device-preview.md): a per-session
// copy of an iOS Simulator or an Android Virtual Device, booted headless by the api, streamed
// into the «Пристрій» tab and driven by the operator and the agent. Shared by the api, which owns
// the devices, and the ui, which shows them.

export const DEVICE_PLATFORMS = ["ios", "android"] as const;
export type DevicePlatform = (typeof DEVICE_PLATFORMS)[number];

export function isDevicePlatform(v: unknown): v is DevicePlatform {
  return typeof v === "string" && (DEVICE_PLATFORMS as readonly string[]).includes(v);
}

// The prefix of every clone Kermanych makes (simulator name, AVD name): `kermanych-<sessionId>`.
// The orphan sweep deletes only names with this prefix.
export const DEVICE_CLONE_PREFIX = "kermanych-";

// A device on this machine a session's clone can be made from (decision 6). `id` is the
// simulator UDID or the AVD name; `os` is shown next to the name ("iOS 18.3", "Android 13").
export type DeviceBase = { platform: DevicePlatform; id: string; name: string; os: string };

// Whether this machine can run a platform: the tooling of decision 3 was found. `reason` says what
// is missing and what to install ("Xcode не знайдено: встановіть Xcode з App Store").
export type DeviceToolStatus = { ok: true } | { ok: false; reason: string };

// The project's choice on this machine (decision 6), stored in the local registry only. A missing
// key falls back to the default: the first iPhone of the newest runtime, the first AVD by name.
export type DeviceChoice = { platform?: DevicePlatform; ios?: string; android?: string };

// A session's clone (decision 4): what it was made from and what it is called. `id` is the
// clone's simulator UDID or AVD name.
export type SessionDevice = { platform: DevicePlatform; base: string; baseName: string; id: string };

// The booted device of a running preview. `serial` is the simulator UDID or `emulator-<port>`, the
// value of DEVICE_ID. `screen` is the coordinate space of the tree, the agent's tools and picks:
// points on iOS, pixels on Android.
export type DeviceRuntime = { platform: DevicePlatform; serial: string; name: string; screen: { width: number; height: number } };

// GET /sessions/:id/device.
export type DeviceInfo = {
  tools: Record<DevicePlatform, DeviceToolStatus>;
  // Every base device of the available platforms, iOS first.
  bases: DeviceBase[];
  choice: DeviceChoice;
  // The platforms `.kermanych/preview.json` configures (empty without a valid `device` block).
  platforms: DevicePlatform[];
  // What a start would use now: the choice, else the default, of a configured and available
  // platform. null when none is.
  next: { platform: DevicePlatform; base: DeviceBase } | null;
  clone: SessionDevice | null;
  // The operator's «Агент» pause (decision 9): `device_*` and preview start/stop are refused.
  paused: boolean;
};

export const DEVICE_BUTTONS = ["home", "back", "recents", "lock", "enter", "volume_up", "volume_down"] as const;
export type DeviceButton = (typeof DEVICE_BUTTONS)[number];

// Buttons a platform has: an iOS simulator has no Back or Recents.
export const DEVICE_PLATFORM_BUTTONS: Record<DevicePlatform, readonly DeviceButton[]> = {
  ios: ["home", "lock", "enter", "volume_up", "volume_down"],
  android: ["home", "back", "recents", "lock", "enter", "volume_up", "volume_down"],
};

export type DeviceOrientation = "portrait" | "landscape";

export type DeviceRect = { x: number; y: number; width: number; height: number };

// One node of the accessibility tree, in `DeviceRuntime.screen` coordinates. iOS: serve-sim's
// tree; Android: `uiautomator dump` (`class` → type, `text`/`content-desc` → label,
// `resource-id` → id).
export type DeviceElement = {
  type: string;
  label: string | null;
  id: string | null;
  value: string | null;
  frame: DeviceRect;
  enabled: boolean;
  children: DeviceElement[];
};

// The operator's input from the screen (decision 9), sent on the `/device` socket. Points are
// fractions 0..1 of the screen, so the client never needs the device's own size.
export type DeviceInput =
  | { type: "touch"; phase: "begin" | "move" | "end"; x: number; y: number }
  // A wheel step: dx/dy are fractions of the screen to scroll by (positive = content moves up/left).
  | { type: "scroll"; x: number; y: number; dx: number; dy: number }
  // Typed text: ASCII as keys, anything else through the device clipboard and a paste.
  | { type: "text"; text: string }
  // A non-text key: "Enter", "Backspace", "Tab", "Escape", "ArrowLeft"/"Right"/"Up"/"Down".
  | { type: "key"; key: string }
  | { type: "button"; button: DeviceButton }
  | { type: "rotate"; orientation: DeviceOrientation };

// The `/device` socket.io namespace (same bearer as REST, as `/terminal`):
//   client → server (ack): watch {sessionId, width, height} → DeviceWatchReply
//   client → server:       unwatch {sessionId} · input {sessionId, input: DeviceInput}
//   server → client:       frame DeviceFrame — only to sockets watching that session
// `width`/`height` of watch are the pane's pixel size: a driver that can scale (Android) sends
// frames no bigger than that. A device is streamed only while some socket watches it.
export type DeviceWatchReply = { ok: true; runtime: DeviceRuntime } | { ok: false; error: string };
export type DeviceFrame = { sessionId: string; kind: "jpeg" | "rgb888"; width: number; height: number; data: ArrayBuffer | Uint8Array };

// POST /sessions/:id/device/pick {x, y} (fractions of the screen), for «◎ Вказати».
// `screenshot` is a PNG crop around the element (the whole screen when there is none).
export type DevicePick = {
  platform: DevicePlatform;
  deviceName: string;
  screen: { width: number; height: number };
  point: { x: number; y: number };
  element: Omit<DeviceElement, "children"> | null;
  screenshot: { data: string; mimeType: "image/png" };
  // The pick held Shift: the operator wants to keep picking.
  more?: boolean;
};
