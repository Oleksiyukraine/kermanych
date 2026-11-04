// apps/api/src/device/device-parse.ts
// The pure parts of the device drivers (docs/specs/2026-11-03-mobile-device-preview.md): what the
// tools print, turned into the shapes of `@kermanych/core`'s device.ts. No process, no file, so the
// specs can feed them the real outputs.
import { DEVICE_CLONE_PREFIX, type DeviceBase, type DeviceChoice, type DeviceElement, type DeviceInfo, type DevicePlatform, type DeviceRect, type DeviceToolStatus, type SessionDevice } from "@kermanych/core";

// ── iOS: `xcrun simctl list -j devices available` ─────────────────────────────

type SimctlDevice = { udid: string; name: string; state?: string; isAvailable?: boolean };
export type SimctlList = { devices: Record<string, SimctlDevice[]> };

// `com.apple.CoreSimulator.SimRuntime.iOS-18-3` → [18, 3]. watchOS, tvOS, visionOS: null.
function iosRuntimeVersion(runtime: string): number[] | null {
  const m = /SimRuntime\.(?:iOS|iPadOS)-(\d+(?:-\d+)*)$/.exec(runtime);
  return m ? m[1]!.split("-").map(Number) : null;
}

function compareVersions(a: number[], b: number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

// Newest runtime first, simctl's own order inside a runtime (iPhones before iPads). Clones are
// not bases (decision 4): a clone of a clone would outlive the session that owns it.
export function parseSimctlBases(list: SimctlList): DeviceBase[] {
  const runtimes = Object.keys(list.devices ?? {})
    .map((r) => ({ r, v: iosRuntimeVersion(r) }))
    .filter((x): x is { r: string; v: number[] } => x.v !== null)
    .sort((a, b) => compareVersions(b.v, a.v));
  const out: DeviceBase[] = [];
  for (const { r, v } of runtimes) {
    for (const d of list.devices[r] ?? []) {
      if (d.isAvailable === false || d.name.startsWith(DEVICE_CLONE_PREFIX)) continue;
      out.push({ platform: "ios", id: d.udid, name: d.name, os: `iOS ${v.join(".")}` });
    }
  }
  return out;
}

// Every simulator named `kermanych-*`, available or not (an orphan may be on a deleted runtime).
export function parseSimctlClones(list: SimctlList): { id: string; name: string; booted: boolean }[] {
  const out: { id: string; name: string; booted: boolean }[] = [];
  for (const devices of Object.values(list.devices ?? {})) {
    for (const d of devices) if (d.name.startsWith(DEVICE_CLONE_PREFIX)) out.push({ id: d.udid, name: d.name, booted: d.state === "Booted" });
  }
  return out;
}

// Decision 6: the first iPhone of the newest runtime that has one; the first AVD by name.
// `bases` is in parseSimctlBases' order (newest runtime first).
export function defaultBase(platform: DevicePlatform, bases: DeviceBase[]): DeviceBase | null {
  const own = bases.filter((b) => b.platform === platform);
  if (platform === "ios") return own.find((b) => b.name.startsWith("iPhone")) ?? own[0] ?? null;
  return [...own].sort((a, b) => a.id.localeCompare(b.id))[0] ?? null;
}

// DeviceInfo.next: what a start would use now. The session's clone keeps its base while its
// platform is configured and available (a base deleted since the clone was made does not matter,
// decision 4); else the project's choice, else the default — of the chosen platform first, then
// of any other configured and available one.
export function nextDevice(
  platforms: DevicePlatform[],
  tools: Record<DevicePlatform, DeviceToolStatus>,
  bases: DeviceBase[],
  choice: DeviceChoice,
  clone: SessionDevice | null,
): DeviceInfo["next"] {
  const available = platforms.filter((p) => tools[p].ok);
  if (clone && available.includes(clone.platform)) {
    const base = bases.find((b) => b.platform === clone.platform && b.id === clone.base) ?? { platform: clone.platform, id: clone.base, name: clone.baseName, os: "" };
    return { platform: clone.platform, base };
  }
  const order = choice.platform && available.includes(choice.platform) ? [choice.platform, ...available.filter((p) => p !== choice.platform)] : available;
  for (const platform of order) {
    const chosen = choice[platform];
    const base = (chosen ? bases.find((b) => b.platform === platform && b.id === chosen) : undefined) ?? defaultBase(platform, bases);
    if (base) return { platform, base };
  }
  return null;
}

// ── Android: `emulator -list-avds`, the AVD's ini files ───────────────────────

// The emulator prints its own log lines before the names (`INFO    | Storing crashdata in: …`).
// An AVD name is a single token of [A-Za-z0-9._-], which those lines never are.
export function parseListAvds(stdout: string): string[] {
  return stdout
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => /^[A-Za-z0-9._-]+$/.test(l));
}

export function parseIni(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const i = line.indexOf("=");
    if (i <= 0 || line.trimStart().startsWith("#")) continue;
    out.set(line.slice(0, i).trim(), line.slice(i + 1).trim());
  }
  return out;
}

// "Android API 32": the system image of `image.sysdir.1` (`system-images/android-32/…`), else the
// `target` of the AVD's top-level ini.
export function avdOs(configIni: string, topIni: string): string {
  const sysdir = parseIni(configIni).get("image.sysdir.1") ?? "";
  const m = /android-([^/\\]+)/.exec(sysdir) ?? /android-([^/\\\s]+)/.exec(parseIni(topIni).get("target") ?? "");
  return m ? `Android API ${m[1]}` : "Android";
}

// The keys that name the AVD inside its own files: config.ini (AvdId, avd.ini.displayname) and the
// emulator's generated hardware-qemu.ini / snapshot hardware.ini (avd.name, avd.id).
const AVD_NAME_KEYS = new Set(["AvdId", "avd.ini.displayname", "avd.name", "avd.id"]);

// One text file of a copied AVD, pointed at the clone (decision 4): every path through
// `<base>.avd` and every name key. A snapshot whose hardware.ini still named the base would be
// refused and the clone would cold-boot.
export function rewriteAvdText(text: string, base: string, clone: string): string {
  const segment = new RegExp(`([/\\\\])${escapeRe(base)}\\.avd(?=[/\\\\\\s"]|$)`, "gm");
  return text
    .split(/(\r?\n)/)
    .map((line) => {
      const m = /^(\s*)([^=#\s][^=]*?)(\s*=\s*)(.*?)(\s*)$/.exec(line);
      if (m && AVD_NAME_KEYS.has(m[2]!) && m[4] === base) return `${m[1]}${m[2]}${m[3]}${clone}${m[5]}`;
      return line.replace(segment, `$1${clone}.avd`);
    })
    .join("");
}

// `<avdHome>/<name>.ini`, the file `emulator -list-avds` finds an AVD by. `path.rel` is relative to
// the Android user home, so it is written only for the default layout (`<user home>/avd`).
export function avdTopIni(avdDir: string, avdHome: string, target: string | undefined): string {
  const rel = avdHome.endsWith("/avd") && avdDir.startsWith(`${avdHome}/`) ? `avd/${avdDir.slice(avdHome.length + 1)}` : undefined;
  return [
    "avd.ini.encoding=UTF-8",
    `path=${avdDir}`,
    ...(rel ? [`path.rel=${rel}`] : []),
    ...(target ? [`target=${target}`] : []),
    "",
  ].join("\n");
}

// `wm size`: an override (set by `wm size WxH`) wins over the physical size.
export function parseWmSize(stdout: string): { width: number; height: number } | null {
  const pick = (re: RegExp) => {
    const m = re.exec(stdout);
    return m ? { width: Number(m[1]), height: Number(m[2]) } : null;
  };
  return pick(/Override size:\s*(\d+)x(\d+)/) ?? pick(/Physical size:\s*(\d+)x(\d+)/);
}

// `dumpsys window displays`: the default display's `mCurrentRotation=ROTATION_270` → 3 quarter
// turns.
export function parseDisplayRotation(stdout: string): number | null {
  const m = /mCurrentRotation=ROTATION_(0|90|180|270)\b/.exec(stdout) ?? /\bmRotation=([0-3])\b/.exec(stdout);
  if (!m) return null;
  const v = Number(m[1]);
  return v > 3 ? v / 90 : v;
}

// A point of the rotated display (what the tree, screenshots and the agent use) on the panel,
// whose own portrait axes the emulator's sendTouch takes. `rotation` is in quarter turns
// (Surface.ROTATION_*); measured on the emulator: ROTATION_270 puts display (x, y) at panel
// (y, H − x).
export function displayToPanel(x: number, y: number, rotation: number, panel: { width: number; height: number }): { x: number; y: number } {
  const { width: w, height: h } = panel;
  const [px, py] = rotation === 1 ? [w - y, x] : rotation === 2 ? [w - x, h - y] : rotation === 3 ? [y, h - x] : [x, y];
  return { x: Math.round(Math.min(w - 1, Math.max(0, px))), y: Math.round(Math.min(h - 1, Math.max(0, py))) };
}

// A running emulator's command line names its AVD as `-avd <name>` or `@<name>`.
export function avdRunning(psArgs: string, name: string): boolean {
  const re = new RegExp(`(?:^|\\s)(?:-avd\\s+|@)${escapeRe(name)}(?=\\s|$)`, "m");
  return psArgs.split(/\r?\n/).some((l) => /emulator|qemu-system/.test(l) && re.test(l));
}

// ── Trees ────────────────────────────────────────────────────────────────────

// serve-sim's `/ax`: the AXe-shaped tree of the native accessibility bridge, in points.
export type AxNode = {
  type?: string;
  role_description?: string;
  AXLabel?: string | null;
  AXUniqueId?: string | null;
  AXValue?: string | null;
  enabled?: boolean;
  frame?: Partial<DeviceRect>;
  children?: AxNode[];
};

export function axToElements(nodes: AxNode[]): DeviceElement[] {
  return nodes.map((n) => ({
    type: n.type || n.role_description || "Element",
    label: text(n.AXLabel),
    id: text(n.AXUniqueId),
    value: text(n.AXValue),
    frame: { x: n.frame?.x ?? 0, y: n.frame?.y ?? 0, width: n.frame?.width ?? 0, height: n.frame?.height ?? 0 },
    enabled: n.enabled !== false,
    children: axToElements(n.children ?? []),
  }));
}

function text(v: string | null | undefined): string | null {
  return typeof v === "string" && v.trim() ? v : null;
}

// `uiautomator dump` XML (pixels): `class` → type (its simple name), `text` / `content-desc` →
// label, `resource-id` → id, `bounds="[x1,y1][x2,y2]"` → frame.
export function parseUiautomator(xml: string): DeviceElement[] {
  const roots: DeviceElement[] = [];
  const stack: DeviceElement[] = [];
  const tag = /<(\/?)node\b((?:[^>"]|"[^"]*")*?)(\/?)>/g;
  for (const m of xml.matchAll(tag)) {
    if (m[1]) {
      stack.pop();
      continue;
    }
    const a = attrs(m[2]!);
    const b = /\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]/.exec(a.bounds ?? "");
    const [x1, y1, x2, y2] = b ? b.slice(1).map(Number) : [0, 0, 0, 0];
    const cls = a.class ?? "";
    const el: DeviceElement = {
      type: cls.slice(cls.lastIndexOf(".") + 1) || "View",
      label: text(a.text) ?? text(a["content-desc"]),
      id: text(a["resource-id"]),
      value: null,
      frame: { x: x1!, y: y1!, width: x2! - x1!, height: y2! - y1! },
      enabled: a.enabled !== "false",
      children: [],
    };
    (stack.at(-1)?.children ?? roots).push(el);
    if (!m[3]) stack.push(el);
  }
  return roots;
}

function attrs(s: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of s.matchAll(/([\w:.-]+)="([^"]*)"/g)) out[m[1]!] = decodeEntities(m[2]!);
  return out;
}

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (_, e: string) => {
    if (e[0] === "#") return String.fromCodePoint(e[1] === "x" ? parseInt(e.slice(2), 16) : Number(e.slice(1)));
    return ({ amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" } as Record<string, string>)[e]!;
  });
}

// «◎ Вказати» (decision 9): the smallest element whose frame holds the point; on equal area the
// deeper one, since a child that fills its parent is the more specific node. An element that
// covers the whole screen (the application, a window) is no answer: the pick then has no element.
export function pickElement(tree: DeviceElement[], point: { x: number; y: number }, screen: { width: number; height: number }): DeviceElement | null {
  let best: DeviceElement | null = null;
  let bestArea = Infinity;
  let bestDepth = -1;
  const stack: { el: DeviceElement; depth: number }[] = tree.map((el) => ({ el, depth: 0 })).reverse();
  while (stack.length) {
    const { el, depth } = stack.pop()!;
    const f = el.frame;
    const inside = point.x >= f.x && point.x < f.x + f.width && point.y >= f.y && point.y < f.y + f.height;
    const screenSized = f.width >= screen.width - 0.5 && f.height >= screen.height - 0.5;
    if (inside && !screenSized && f.width > 0 && f.height > 0) {
      const area = f.width * f.height;
      if (area < bestArea || (area === bestArea && depth >= bestDepth)) [best, bestArea, bestDepth] = [el, area, depth];
    }
    for (let i = el.children.length - 1; i >= 0; i--) stack.push({ el: el.children[i]!, depth: depth + 1 });
  }
  return best;
}

// The pixel rectangle of a pick's crop: the element's frame (screen units) plus `margin`, scaled
// to the screenshot and clamped to it.
export function cropRect(frame: DeviceRect, screen: { width: number; height: number }, image: { width: number; height: number }, margin: number): DeviceRect {
  const sx = image.width / screen.width;
  const sy = image.height / screen.height;
  const x1 = Math.max(0, Math.floor((frame.x - margin) * sx));
  const y1 = Math.max(0, Math.floor((frame.y - margin) * sy));
  const x2 = Math.min(image.width, Math.ceil((frame.x + frame.width + margin) * sx));
  const y2 = Math.min(image.height, Math.ceil((frame.y + frame.height + margin) * sy));
  return { x: x1, y: y1, width: Math.max(1, x2 - x1), height: Math.max(1, y2 - y1) };
}

// ── Images ───────────────────────────────────────────────────────────────────

export function pngSize(png: Buffer): { width: number; height: number } | null {
  if (png.length < 24 || png.readUInt32BE(0) !== 0x89504e47 || png.toString("ascii", 12, 16) !== "IHDR") return null;
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

// The size in a JPEG's SOFn header, so a frame says its own size even after a rotation.
export function jpegSize(jpg: Uint8Array): { width: number; height: number } | null {
  if (jpg[0] !== 0xff || jpg[1] !== 0xd8) return null;
  let i = 2;
  while (i + 9 < jpg.length) {
    if (jpg[i] !== 0xff) return null;
    const marker = jpg[i + 1]!;
    if (marker === 0xff) {
      i++;
      continue;
    }
    const len = (jpg[i + 2]! << 8) | jpg[i + 3]!;
    // SOF0..SOF15 except DHT (C4), JPG (C8) and DAC (CC).
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: (jpg[i + 5]! << 8) | jpg[i + 6]!, width: (jpg[i + 7]! << 8) | jpg[i + 8]! };
    }
    i += 2 + len;
  }
  return null;
}

// serve-sim's `/stream.mjpeg`: `multipart/x-mixed-replace` parts of
// `--frame\r\nContent-Type: image/jpeg\r\nContent-Length: N\r\n\r\n<N bytes>\r\n`. Chunks split
// anywhere, so the parser keeps the unfinished tail. A part without Content-Length ends at the
// next boundary.
export class MjpegParser {
  private buf: Buffer = Buffer.alloc(0);
  private static readonly HEADERS_END = Buffer.from("\r\n\r\n");

  constructor(private readonly boundary = "--frame") {}

  push(chunk: Buffer): Buffer[] {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    const frames: Buffer[] = [];
    for (;;) {
      const start = this.buf.indexOf(this.boundary);
      if (start < 0) {
        // Keep only what could still be the start of a boundary.
        if (this.buf.length > this.boundary.length) this.buf = this.buf.subarray(this.buf.length - this.boundary.length);
        break;
      }
      const headEnd = this.buf.indexOf(MjpegParser.HEADERS_END, start);
      if (headEnd < 0) {
        this.buf = this.buf.subarray(start);
        break;
      }
      const head = this.buf.toString("latin1", start, headEnd);
      const bodyStart = headEnd + 4;
      const len = /content-length:\s*(\d+)/i.exec(head);
      let bodyEnd: number;
      if (len) {
        bodyEnd = bodyStart + Number(len[1]);
        if (bodyEnd > this.buf.length) {
          this.buf = this.buf.subarray(start);
          break;
        }
      } else {
        const next = this.buf.indexOf(this.boundary, bodyStart);
        if (next < 0) {
          this.buf = this.buf.subarray(start);
          break;
        }
        bodyEnd = next;
        while (bodyEnd > bodyStart && (this.buf[bodyEnd - 1] === 0x0a || this.buf[bodyEnd - 1] === 0x0d)) bodyEnd--;
      }
      // A copy: the frame outlives the buffer it was cut from.
      frames.push(Buffer.from(this.buf.subarray(bodyStart, bodyEnd)));
      this.buf = this.buf.subarray(bodyEnd);
    }
    return frames;
  }
}

// ── Clones ───────────────────────────────────────────────────────────────────

// `running`: the clone is booted right now (by this api or one that died).
export type CloneOnDisk = { platform: DevicePlatform; id: string; name: string; running?: boolean };

// The orphan sweep (decision 4): a `kermanych-<sessionId>` clone whose session is gone, or whose
// session records another clone (a re-clone or a clone cut short before it was recorded).
export function selectOrphans(clones: CloneOnDisk[], sessions: Map<string, SessionDevice | null>): CloneOnDisk[] {
  return clones.filter((c) => {
    if (!c.name.startsWith(DEVICE_CLONE_PREFIX)) return false;
    const sessionId = c.name.slice(DEVICE_CLONE_PREFIX.length);
    if (!sessions.has(sessionId)) return true;
    const rec = sessions.get(sessionId);
    return !rec || rec.platform !== c.platform || rec.id !== c.id;
  });
}

export function cloneName(sessionId: string): string {
  return `${DEVICE_CLONE_PREFIX}${sessionId}`;
}

// ── Keyboard ─────────────────────────────────────────────────────────────────

// US-layout HID usages (USB HID usage table, page 7) for the printable ASCII serve-sim's keyboard
// types, as serve-sim's own `type` command does. Anything else goes through the clipboard.
const HID_PLAIN: Record<string, number> = {
  " ": 44, "-": 45, "=": 46, "[": 47, "]": 48, "\\": 49, ";": 51, "'": 52, "`": 53, ",": 54, ".": 55, "/": 56, "\n": 40, "\t": 43,
};
const HID_SHIFTED: Record<string, string> = {
  "!": "1", "@": "2", "#": "3", $: "4", "%": "5", "^": "6", "&": "7", "*": "8", "(": "9", ")": "0",
  _: "-", "+": "=", "{": "[", "}": "]", "|": "\\", ":": ";", '"': "'", "~": "`", "<": ",", ">": ".", "?": "/",
};
export const HID_SHIFT = 225;
export const HID_GUI = 227;

export function hidForChar(ch: string): { usage: number; shift: boolean } | null {
  if (/^[a-z]$/.test(ch)) return { usage: 4 + ch.charCodeAt(0) - 97, shift: false };
  if (/^[A-Z]$/.test(ch)) return { usage: 4 + ch.charCodeAt(0) - 65, shift: true };
  if (/^[1-9]$/.test(ch)) return { usage: 30 + ch.charCodeAt(0) - 49, shift: false };
  if (ch === "0") return { usage: 39, shift: false };
  if (ch in HID_PLAIN) return { usage: HID_PLAIN[ch]!, shift: false };
  if (ch in HID_SHIFTED) return { usage: hidForChar(HID_SHIFTED[ch]!)!.usage, shift: true };
  return null;
}

// The non-text keys of DeviceInput `key`.
export const HID_KEYS: Record<string, number> = {
  Enter: 40, Escape: 41, Backspace: 42, Tab: 43, ArrowRight: 79, ArrowLeft: 80, ArrowDown: 81, ArrowUp: 82, Delete: 76,
};

// Text split into runs the keyboard can type and runs that must be pasted (decision 9).
export function splitTyping(text: string, typable: (ch: string) => boolean): { kind: "keys" | "paste"; text: string }[] {
  const out: { kind: "keys" | "paste"; text: string }[] = [];
  for (const ch of text) {
    const kind = typable(ch) ? "keys" : "paste";
    const last = out.at(-1);
    if (last?.kind === kind) last.text += ch;
    else out.push({ kind, text: ch });
  }
  return out;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
