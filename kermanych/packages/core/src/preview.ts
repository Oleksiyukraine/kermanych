// The live preview of a session (docs/specs/2026-11-03-session-browser-preview.md). The repository
// says how to run its app in `.kermanych/preview.json`, read from the session directory (the
// worktree, or the main checkout of an in-place session), so the commands travel with the branch
// whose code they build. Shared by the api, which runs it, and the ui, which shows its state.
//
// A Mobile project adds a `device` block (docs/specs/2026-11-03-mobile-device-preview.md,
// decision 5): Kermanych boots the session's device before `setup`, and the repository's commands
// build and install the app on it.
import type { DevicePlatform, DeviceRuntime } from "./device";

export const PREVIEW_CONFIG_PATH = ".kermanych/preview.json";

// The step name of the optional `setup` command in the state and the logs. No service may take it.
export const PREVIEW_SETUP_STEP = "setup";
// The device's own step: clone and boot while starting, then the app's log. No service may take it.
export const PREVIEW_DEVICE_STEP = "device";
// The platform's `install` command. No service may take it.
export const PREVIEW_INSTALL_STEP = "install";

// A per-session temp directory Kermanych creates before `setup` and deletes with the session.
export const PREVIEW_DIR_VAR = "PREVIEW_DIR";
// The booted device, for every step of a preview with a `device` block.
export const PREVIEW_DEVICE_VARS = ["DEVICE_ID", "DEVICE_PLATFORM", "ANDROID_SERIAL"] as const;

export type PreviewServiceDef = {
  name: string;
  command: string;
  // Raw values: `${VAR}` is expanded by expandPreviewEnv at start, when the ports are known.
  env: Record<string, string>;
  // The one service whose page the session browser opens (web).
  open: boolean;
  // The service that installs and launches the app itself and keeps running (`flutter run`):
  // ready once the app's process runs on the device, not by its port.
  device: boolean;
};

// One platform of the `device` block. `app` is the bundle id or package; `install` builds and
// installs it and must exit 0, after which Kermanych launches `app`.
export type PreviewDeviceTarget = { app: string; install?: string };

export type PreviewConfig = {
  setup?: string;
  services: PreviewServiceDef[];
  device?: Partial<Record<DevicePlatform, PreviewDeviceTarget>>;
};

export type PreviewConfigRead = { ok: true; config: PreviewConfig } | { ok: false; error: string };

const SERVICE_NAME_RE = /^[a-z][a-z0-9-]*$/;
const RESERVED_STEPS = [PREVIEW_SETUP_STEP, PREVIEW_DEVICE_STEP, PREVIEW_INSTALL_STEP];
const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
// A bundle id (`com.acme.app`) or an Android package (`com.acme.app`, `grano.app.com`).
const APP_ID_RE = /^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)+$/;
const VAR_REF_RE = /\$\{([^}]*)\}/g;
const TOP_KEYS: Record<string, true> = { setup: true, services: true, device: true };
const SERVICE_KEYS: Record<string, true> = { name: true, command: true, env: true, open: true, device: true };
const DEVICE_KEYS: Record<string, true> = { ios: true, android: true };
const TARGET_KEYS: Record<string, true> = { app: true, install: true };

// The variable that carries a service's port to every step: `web-app` → `PORT_WEB_APP`.
export function previewPortVar(service: string): string {
  return `PORT_${service.toUpperCase().replace(/-/g, "_")}`;
}

// The platforms a config's `device` block names, iOS first.
export function previewPlatforms(config: PreviewConfig): DevicePlatform[] {
  return (["ios", "android"] as const).filter((p) => config.device?.[p] !== undefined);
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// Parse and validate the file's text. The error names the field (`services[1].command: …`), since
// it is shown to the operator in the preview row and handed to the agent to fix the file.
export function parsePreviewConfig(text: string): PreviewConfigRead {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    return { ok: false, error: `not valid JSON: ${(e as Error).message}` };
  }
  if (!isObject(raw)) return { ok: false, error: "the file must hold a JSON object" };
  for (const k of Object.keys(raw)) if (!Object.hasOwn(TOP_KEYS, k)) return { ok: false, error: `${k}: unknown field` };

  let setup: string | undefined;
  if (raw.setup !== undefined) {
    if (typeof raw.setup !== "string" || !raw.setup.trim()) return { ok: false, error: "setup: must be a non-empty string" };
    setup = raw.setup;
  }

  let device: PreviewConfig["device"];
  if (raw.device !== undefined) {
    if (!isObject(raw.device)) return { ok: false, error: "device: must be an object with ios and/or android" };
    device = {};
    for (const [p, t] of Object.entries(raw.device)) {
      const at = `device.${p}`;
      if (!Object.hasOwn(DEVICE_KEYS, p)) return { ok: false, error: `${at}: unknown platform (ios or android)` };
      if (!isObject(t)) return { ok: false, error: `${at}: must be an object` };
      for (const k of Object.keys(t)) if (!Object.hasOwn(TARGET_KEYS, k)) return { ok: false, error: `${at}.${k}: unknown field` };
      if (typeof t.app !== "string" || !APP_ID_RE.test(t.app)) {
        return { ok: false, error: `${at}.app: must be the bundle id or package, like "com.acme.app"` };
      }
      const target: PreviewDeviceTarget = { app: t.app };
      if (t.install !== undefined) {
        if (typeof t.install !== "string" || !t.install.trim()) return { ok: false, error: `${at}.install: must be a non-empty string` };
        target.install = t.install;
      }
      device[p as DevicePlatform] = target;
    }
    if (!device.ios && !device.android) return { ok: false, error: "device: needs ios and/or android" };
  }

  // A mobile app may need no service at all (a native build: setup + install).
  if (raw.services === undefined && device) raw.services = [];
  if (!Array.isArray(raw.services) || (raw.services.length === 0 && !device)) {
    return { ok: false, error: "services: must be a non-empty array" };
  }
  const services: PreviewServiceDef[] = [];
  const names = new Set<string>();
  for (const [i, s] of raw.services.entries()) {
    const at = `services[${i}]`;
    if (!isObject(s)) return { ok: false, error: `${at}: must be an object` };
    for (const k of Object.keys(s)) if (!Object.hasOwn(SERVICE_KEYS, k)) return { ok: false, error: `${at}.${k}: unknown field` };
    if (typeof s.name !== "string" || !SERVICE_NAME_RE.test(s.name)) {
      return { ok: false, error: `${at}.name: must match ${SERVICE_NAME_RE.source}` };
    }
    if (RESERVED_STEPS.includes(s.name)) return { ok: false, error: `${at}.name: "${s.name}" is the name of Kermanych's own step` };
    if (names.has(s.name)) return { ok: false, error: `${at}.name: "${s.name}" is used twice` };
    names.add(s.name);
    if (typeof s.command !== "string" || !s.command.trim()) return { ok: false, error: `${at}.command: must be a non-empty string` };
    const env: Record<string, string> = {};
    if (s.env !== undefined) {
      if (!isObject(s.env)) return { ok: false, error: `${at}.env: must be an object of strings` };
      for (const [k, v] of Object.entries(s.env)) {
        if (!ENV_KEY_RE.test(k)) return { ok: false, error: `${at}.env.${k}: not a valid variable name` };
        if (typeof v !== "string") return { ok: false, error: `${at}.env.${k}: must be a string` };
        env[k] = v;
      }
    }
    if (s.open !== undefined && typeof s.open !== "boolean") return { ok: false, error: `${at}.open: must be true or false` };
    if (s.device !== undefined && typeof s.device !== "boolean") return { ok: false, error: `${at}.device: must be true or false` };
    services.push({ name: s.name, command: s.command, env, open: s.open === true, device: s.device === true });
  }

  const open = services.filter((s) => s.open);
  if (device) {
    // A Mobile project has no browser: there is no page to open.
    if (open.length) return { ok: false, error: `services: "open" is for a web page; with a "device" block no service opens one` };
    const onDevice = services.filter((s) => s.device);
    if (onDevice.length > 1) return { ok: false, error: `services: at most one service can have "device": true (found ${onDevice.length})` };
    const installs = previewPlatforms({ services, device }).filter((p) => device[p]!.install !== undefined);
    if (onDevice.length && installs.length) {
      return {
        ok: false,
        error: `services: "${onDevice[0]!.name}" installs the app ("device": true), so device.${installs[0]}.install must go: choose one`,
      };
    }
  } else {
    const onDevice = services.findIndex((s) => s.device);
    if (onDevice >= 0) return { ok: false, error: `services[${onDevice}].device: needs a "device" block naming the app` };
    if (open.length !== 1) {
      return { ok: false, error: `services: exactly one service needs "open": true (found ${open.length})` };
    }
  }

  // Kermanych's variables are the only ones `${…}` expands, and they are reserved: a service that
  // set PORT itself would point the readiness check at the wrong port.
  const known = new Set([
    "PORT",
    PREVIEW_DIR_VAR,
    ...services.map((s) => previewPortVar(s.name)),
    ...(device ? PREVIEW_DEVICE_VARS : []),
  ]);
  for (const [i, s] of services.entries()) {
    for (const [k, v] of Object.entries(s.env)) {
      if (known.has(k)) return { ok: false, error: `services[${i}].env.${k}: set by Kermanych, cannot be overridden` };
      for (const m of v.matchAll(VAR_REF_RE)) {
        if (!known.has(m[1]!)) {
          return { ok: false, error: `services[${i}].env.${k}: unknown variable \${${m[1]}} (known: ${[...known].join(", ")})` };
        }
      }
    }
  }
  const config: PreviewConfig = setup === undefined ? { services } : { setup, services };
  if (device) config.device = device;
  return { ok: true, config };
}

// Expand `${VAR}` in one env value. parsePreviewConfig has already refused unknown names.
export function expandPreviewEnv(value: string, vars: Record<string, string>): string {
  return value.replace(VAR_REF_RE, (whole, name: string) => vars[name] ?? whole);
}

export type PreviewPort = { name: string; port: number };

// Owned by the api (PreviewService), pushed to the ui on every change. `null` (no entry) means the
// preview has not been started since the api started.
//
// A preview with a `device` block carries `device` from the moment the device has booted (so the
// screen shows while `setup` and `install` run) and has no `url`: a Mobile project has no page.
// `app` says whether the app's process runs (decision 11): its exit is not a crash of the preview.
export type PreviewState =
  // `step` is `device`, `setup`, a service being waited for, or `install`.
  | { phase: "starting"; step: string; services: PreviewPort[]; device?: DeviceRuntime }
  | { phase: "running"; url: string | null; services: PreviewPort[]; device?: DeviceRuntime; app?: "running" | "exited" }
  | { phase: "stopped" }
  // A step exited after the preview was running; the others were stopped with it.
  | { phase: "crashed"; step: string; code: number | null; signal: string | null }
  // The start did not get to running: a step exited, timed out, or could not be spawned.
  | { phase: "failed"; step: string; error: string };

// `platforms`: what the `device` block configures (empty for a web preview).
export type PreviewConfigStatus =
  | { kind: "ok"; services: string[]; platforms: DevicePlatform[] }
  | { kind: "missing" }
  | { kind: "invalid"; error: string };

// GET /sessions/:id/preview.
export type PreviewInfo = { state: PreviewState | null; config: PreviewConfigStatus };

// GET /sessions/:id/preview/logs?step=&since=. `seq` grows for the life of the api, `run` counts
// starts: a client whose `run` changed clears what it shows. `steps` lists the steps of this run
// that have a log, in start order.
export type PreviewLogLine = { seq: number; text: string };
export type PreviewLogs = { run: number; steps: string[]; lines: PreviewLogLine[]; next: number };
