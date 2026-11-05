// apps/api/test/device-parse.spec.ts
// The pure parts of the device drivers (docs/specs/2026-11-03-mobile-device-preview.md), fed the
// real shapes of what simctl, the emulator, uiautomator and serve-sim print on this kind of Mac.
import { describe, expect, test } from "vitest";
import type { DeviceBase, DeviceElement, SessionDevice } from "@kermanych/core";
import {
  MjpegParser,
  avdOs,
  avdRunning,
  avdTopIni,
  axToElements,
  cropRect,
  defaultBase,
  displayToPanel,
  hidForChar,
  jpegSize,
  nextDevice,
  parseListAvds,
  parseSimctlBases,
  parseSimctlClones,
  parseUiautomator,
  parseDisplayRotation,
  parseWmSize,
  pickElement,
  pngSize,
  rewriteAvdText,
  selectOrphans,
  splitTyping,
  type SimctlList,
} from "../src/device/device-parse";
import { RegistryService } from "../src/registry/registry.service";

const RT = "com.apple.CoreSimulator.SimRuntime.";
const simctl: SimctlList = {
  devices: {
    [`${RT}iOS-18-3`]: [
      { udid: "A759", name: "iPhone 16", state: "Shutdown", isAvailable: true },
      { udid: "D47F", name: "iPad Pro 11-inch (M4)", state: "Shutdown", isAvailable: true },
    ],
    [`${RT}watchOS-11-2`]: [{ udid: "W1", name: "Apple Watch Series 10 (46mm)", state: "Shutdown", isAvailable: true }],
    [`${RT}iOS-26-0`]: [
      { udid: "93AF", name: "iPad Pro 13-inch (M5)", state: "Shutdown", isAvailable: true },
      { udid: "F1A1", name: "iPhone 17 Pro", state: "Shutdown", isAvailable: true },
      { udid: "C10E", name: "kermanych-s1", state: "Booted", isAvailable: true },
      { udid: "DEAD", name: "iPhone 17", state: "Shutdown", isAvailable: false },
    ],
    [`${RT}iOS-26-0-1`]: [{ udid: "93AE", name: "iPad Air 11-inch (M3)", state: "Shutdown", isAvailable: true }],
  },
};

describe("iOS bases", () => {
  test("newest runtime first, iOS only, clones and unavailable devices excluded", () => {
    expect(parseSimctlBases(simctl).map((b) => `${b.id} ${b.os}`)).toEqual(["93AE iOS 26.0.1", "93AF iOS 26.0", "F1A1 iOS 26.0", "A759 iOS 18.3", "D47F iOS 18.3"]);
  });

  test("the default is the first iPhone of the newest runtime that has one", () => {
    // iOS 26.0.1 has only an iPad: the iPhone of 26.0 wins over the iPad listed first.
    expect(defaultBase("ios", parseSimctlBases(simctl))?.id).toBe("F1A1");
    const ipadsOnly = parseSimctlBases({ devices: { [`${RT}iOS-18-3`]: [{ udid: "D47F", name: "iPad (A16)" }] } });
    expect(defaultBase("ios", ipadsOnly)?.id).toBe("D47F");
    expect(defaultBase("ios", [])).toBeNull();
  });

  test("clones are found on every runtime with their booted state", () => {
    expect(parseSimctlClones(simctl)).toEqual([{ id: "C10E", name: "kermanych-s1", booted: true }]);
  });
});

describe("Android AVDs", () => {
  test("list-avds noise lines are not AVD names", () => {
    const out = "INFO    | Storing crashdata in: /tmp/android-x/emu-crash-35.1.21.db, detection is enabled for process: 88300\nTinyApp\nPixel_4_XL_API_31\nWA-courier\n\nWARNING | something\n";
    expect(parseListAvds(out)).toEqual(["TinyApp", "Pixel_4_XL_API_31", "WA-courier"]);
  });

  test("the default is the first AVD by name, not by list order", () => {
    const bases: DeviceBase[] = ["Vanil", "TinyApp", "WD-client"].map((id) => ({ platform: "android", id, name: id, os: "" }));
    expect(defaultBase("android", bases)?.id).toBe("TinyApp");
  });

  test("os comes from the system image, else the ini target", () => {
    expect(avdOs("image.sysdir.1 = system-images/android-32/google_apis_playstore/arm64-v8a/\n", "target=android-30")).toBe("Android API 32");
    expect(avdOs("", "path=/x\ntarget=android-34\n")).toBe("Android API 34");
    expect(avdOs("", "")).toBe("Android");
  });

  test("the copy's files are pointed at the clone, and only the base's own name is replaced", () => {
    const config = "AvdId = TinyApp\navd.ini.displayname = TinyApp\nhw.device.name = medium_phone\nskin.name = TinyApp\n";
    expect(rewriteAvdText(config, "TinyApp", "kermanych-s1")).toBe("AvdId = kermanych-s1\navd.ini.displayname = kermanych-s1\nhw.device.name = medium_phone\nskin.name = TinyApp\n");
    const hw = [
      "disk.dataPartition.path = /Users/me/.android/avd/../avd/TinyApp.avd/userdata-qemu.img",
      "disk.cachePartition.path = /Users/me/.android/avd/TinyApp.avd",
      "kernel.path = /sdk/TinyApp.avd.bak/kernel",
      "other = /Users/me/.android/avd/TinyApp2.avd/x",
      "avd.name = TinyApp",
      "avd.id = TinyApp",
    ].join("\r\n");
    expect(rewriteAvdText(hw, "TinyApp", "kermanych-s1").split("\r\n")).toEqual([
      "disk.dataPartition.path = /Users/me/.android/avd/../avd/kermanych-s1.avd/userdata-qemu.img",
      "disk.cachePartition.path = /Users/me/.android/avd/kermanych-s1.avd",
      "kernel.path = /sdk/TinyApp.avd.bak/kernel",
      "other = /Users/me/.android/avd/TinyApp2.avd/x",
      "avd.name = kermanych-s1",
      "avd.id = kermanych-s1",
    ]);
  });

  test("the top-level ini has path.rel only in the default layout", () => {
    expect(avdTopIni("/u/.android/avd/k.avd", "/u/.android/avd", "android-32")).toBe("avd.ini.encoding=UTF-8\npath=/u/.android/avd/k.avd\npath.rel=avd/k.avd\ntarget=android-32\n");
    expect(avdTopIni("/data/avds/k.avd", "/data/avds", undefined)).toBe("avd.ini.encoding=UTF-8\npath=/data/avds/k.avd\n");
  });

  test("a running AVD is told by the emulator's command line", () => {
    const ps = [
      "97447 /sdk/emulator/qemu/darwin-aarch64/qemu-system-aarch64-headless -avd TinyApp -no-window -grpc 8611",
      "123 /Applications/Android Studio.app/Contents/MacOS/studio @TinyAppX",
      "124 /sdk/emulator/emulator @Vanil -netdelay none",
      "125 vim -avd TinyApp2",
    ].join("\n");
    expect(avdRunning(ps, "TinyApp")).toBe(true);
    expect(avdRunning(ps, "Vanil")).toBe(true);
    expect(avdRunning(ps, "TinyAppX")).toBe(false);
    expect(avdRunning(ps, "TinyApp2")).toBe(false);
  });

  test("wm size: the override wins", () => {
    expect(parseWmSize("Physical size: 1080x2400\n")).toEqual({ width: 1080, height: 2400 });
    expect(parseWmSize("Physical size: 1080x2400\nOverride size: 720x1600\n")).toEqual({ width: 720, height: 1600 });
    expect(parseWmSize("error: device offline")).toBeNull();
  });
});

describe("trees", () => {
  test("uiautomator XML maps class, text / content-desc, resource-id and bounds, nesting kept", () => {
    const xml =
      `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?><hierarchy rotation="0">` +
      `<node index="0" text="" resource-id="" class="android.widget.FrameLayout" content-desc="" enabled="true" bounds="[0,0][1080,2358]">` +
      `<node index="0" text="Привіт &amp; &quot;wifi&quot;" resource-id="com.android.settings:id/search_src_text" class="android.widget.EditText" content-desc="" enabled="true" bounds="[42,63][1038,210]" />` +
      `<node index="1" text="" resource-id="" class="android.widget.ImageButton" content-desc="Navigate up" enabled="false" bounds="[0,63][147,210]"><node index="0" text="x" class="android.view.View" bounds="[1,2][3,4]" /></node>` +
      `</node></hierarchy>`;
    const tree = parseUiautomator(xml);
    expect(tree).toHaveLength(1);
    expect(tree[0]!.type).toBe("FrameLayout");
    expect(tree[0]!.label).toBeNull();
    const [edit, up] = tree[0]!.children;
    expect(edit).toMatchObject({ type: "EditText", label: 'Привіт & "wifi"', id: "com.android.settings:id/search_src_text", frame: { x: 42, y: 63, width: 996, height: 147 }, enabled: true, children: [] });
    expect(up).toMatchObject({ type: "ImageButton", label: "Navigate up", id: null, enabled: false });
    expect(up!.children[0]).toMatchObject({ type: "View", label: "x", frame: { x: 1, y: 2, width: 2, height: 2 } });
  });

  test("serve-sim's AX tree keeps its nesting and blanks become null", () => {
    const els = axToElements([
      {
        type: "Application",
        AXLabel: " ",
        frame: { x: 0, y: 0, width: 393, height: 852 },
        children: [{ type: "Button", AXLabel: "General", AXUniqueId: "com.apple.settings.general", AXValue: null, enabled: false, frame: { x: 16, y: 337, width: 361, height: 52 } }],
      },
    ]);
    expect(els[0]).toMatchObject({ type: "Application", label: null, id: null, frame: { width: 393, height: 852 }, enabled: true });
    expect(els[0]!.children[0]).toMatchObject({ type: "Button", label: "General", id: "com.apple.settings.general", value: null, enabled: false, children: [] });
  });
});

const el = (type: string, frame: [number, number, number, number], children: DeviceElement[] = []): DeviceElement => ({
  type,
  label: type,
  id: null,
  value: null,
  frame: { x: frame[0], y: frame[1], width: frame[2], height: frame[3] },
  enabled: true,
  children,
});

describe("pick", () => {
  const screen = { width: 400, height: 800 };
  const tree = [
    el("App", [0, 0, 400, 800], [
      el("Window", [0, 0, 400, 800], [
        el("Cell", [0, 100, 400, 60], [el("Label", [16, 110, 200, 40]), el("Switch", [330, 115, 50, 30])]),
        el("Overlay", [300, 100, 100, 100]),
        el("Wrapper", [16, 300, 100, 40], [el("Inner", [16, 300, 100, 40])]),
      ]),
    ]),
  ];

  test("the smallest element under the point", () => {
    expect(pickElement(tree, { x: 50, y: 120 }, screen)?.type).toBe("Label");
    // The Switch (1500) is smaller than the Overlay (10000) lying over the same point.
    expect(pickElement(tree, { x: 340, y: 120 }, screen)?.type).toBe("Switch");
  });

  test("on equal frames the deeper element", () => {
    expect(pickElement(tree, { x: 20, y: 310 }, screen)?.type).toBe("Inner");
  });

  test("screen-sized nodes are no answer, and frames are half-open", () => {
    expect(pickElement(tree, { x: 200, y: 600 }, screen)).toBeNull();
    expect(pickElement(tree, { x: 216, y: 120 }, screen)?.type).toBe("Cell");
  });

  test("the crop is the frame plus the margin, in screenshot pixels, clamped", () => {
    expect(cropRect({ x: 16, y: 110, width: 200, height: 40 }, screen, { width: 1200, height: 2400 }, 8)).toEqual({ x: 24, y: 306, width: 648, height: 168 });
    expect(cropRect({ x: 390, y: 790, width: 20, height: 20 }, screen, { width: 400, height: 800 }, 8)).toEqual({ x: 382, y: 782, width: 18, height: 18 });
  });
});

describe("next device (DeviceInfo.next)", () => {
  const ios: DeviceBase = { platform: "ios", id: "A759", name: "iPhone 16", os: "iOS 18.3" };
  const ios26: DeviceBase = { platform: "ios", id: "F1A1", name: "iPhone 17 Pro", os: "iOS 26.0" };
  const tiny: DeviceBase = { platform: "android", id: "TinyApp", name: "TinyApp", os: "Android API 32" };
  const bases = [ios26, ios, tiny];
  const ok = { ios: { ok: true as const }, android: { ok: true as const } };
  const noXcode = { ios: { ok: false as const, reason: "x" }, android: { ok: true as const } };
  const clone: SessionDevice = { platform: "ios", base: "A759", baseName: "iPhone 16", id: "C10E" };

  test("the clone's base wins while its platform is configured and available", () => {
    expect(nextDevice(["ios", "android"], ok, bases, { platform: "android" }, clone)).toEqual({ platform: "ios", base: ios });
    // A base deleted since the clone was made does not matter.
    expect(nextDevice(["ios"], ok, [tiny], {}, clone)).toEqual({ platform: "ios", base: { platform: "ios", id: "A759", name: "iPhone 16", os: "" } });
    // The file no longer configures iOS: the clone's base is not what a start would use.
    expect(nextDevice(["android"], ok, bases, {}, clone)).toEqual({ platform: "android", base: tiny });
    expect(nextDevice(["ios", "android"], noXcode, bases, {}, clone)).toEqual({ platform: "android", base: tiny });
  });

  test("the project's choice, else the default, of the chosen platform first", () => {
    expect(nextDevice(["ios", "android"], ok, bases, { platform: "android" }, null)).toEqual({ platform: "android", base: tiny });
    expect(nextDevice(["ios", "android"], ok, bases, { ios: "A759" }, null)).toEqual({ platform: "ios", base: ios });
    // A chosen base that is gone falls back to the default.
    expect(nextDevice(["ios"], ok, bases, { ios: "GONE" }, null)).toEqual({ platform: "ios", base: ios26 });
    // The chosen platform has no device: another configured one does.
    expect(nextDevice(["ios", "android"], ok, [tiny], { platform: "ios" }, null)).toEqual({ platform: "android", base: tiny });
    expect(nextDevice(["ios"], noXcode, bases, {}, null)).toBeNull();
    expect(nextDevice([], ok, bases, {}, null)).toBeNull();
  });
});

describe("MJPEG", () => {
  const jpeg = (w: number, h: number, pad: number) =>
    Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0, 0, 0xff, 0xc0, 0x00, 0x11, 0x08, h >> 8, h & 255, w >> 8, w & 255]), Buffer.alloc(pad, 7), Buffer.from([0xff, 0xd9])]);
  const part = (body: Buffer, len = true) =>
    Buffer.concat([Buffer.from(`--frame\r\nContent-Type: image/jpeg\r\n${len ? `Content-Length: ${body.length}\r\n` : ""}\r\n`), body, Buffer.from("\r\n")]);

  test("frames split at every byte come out whole and in order", () => {
    const a = jpeg(1179, 2556, 300);
    const b = jpeg(2556, 1179, 5);
    const stream = Buffer.concat([part(a), part(b)]);
    const p = new MjpegParser();
    const out: Buffer[] = [];
    for (let i = 0; i < stream.length; i++) out.push(...p.push(stream.subarray(i, i + 1)));
    expect(out.map((f) => f.equals(a) || f.equals(b))).toEqual([true, true]);
    expect(out.map((f) => jpegSize(f))).toEqual([{ width: 1179, height: 2556 }, { width: 2556, height: 1179 }]);
  });

  test("several frames in one chunk; a body containing the boundary text is not cut", () => {
    const tricky = Buffer.concat([jpeg(10, 20, 2), Buffer.from("--frame"), Buffer.from([0xff, 0xd9])]);
    const p = new MjpegParser();
    const out = p.push(Buffer.concat([part(tricky), part(jpeg(1, 1, 0)), part(jpeg(2, 2, 0)).subarray(0, 30)]));
    expect(out).toHaveLength(2);
    expect(out[0]!.equals(tricky)).toBe(true);
  });

  test("a part without Content-Length ends at the next boundary", () => {
    const a = jpeg(3, 4, 10);
    const p = new MjpegParser();
    expect(p.push(Buffer.concat([part(a, false), part(a, false)])).map((f) => f.equals(a))).toEqual([true]);
  });

  test("image sizes", () => {
    const png = Buffer.alloc(24);
    png.writeUInt32BE(0x89504e47, 0);
    png.write("IHDR", 12, "ascii");
    png.writeUInt32BE(1080, 16);
    png.writeUInt32BE(2400, 20);
    expect(pngSize(png)).toEqual({ width: 1080, height: 2400 });
    expect(pngSize(Buffer.from("not a png at all, really"))).toBeNull();
    expect(jpegSize(Buffer.from([0x00, 0x01]))).toBeNull();
  });
});

describe("orphans", () => {
  const rec = (id: string, platform: "ios" | "android" = "ios"): SessionDevice => ({ platform, base: "b", baseName: "b", id });
  test("a clone whose session is gone, unrecorded or recording another clone", () => {
    const clones = [
      { platform: "ios" as const, id: "U1", name: "kermanych-live" },
      { platform: "ios" as const, id: "U2", name: "kermanych-live" },
      { platform: "ios" as const, id: "U3", name: "kermanych-gone" },
      { platform: "android" as const, id: "kermanych-norec", name: "kermanych-norec" },
      { platform: "android" as const, id: "kermanych-live", name: "kermanych-live" },
      { platform: "ios" as const, id: "U9", name: "My iPhone" },
    ];
    const sessions = new Map<string, SessionDevice | null>([
      ["live", rec("U1")],
      ["norec", null],
    ]);
    expect(selectOrphans(clones, sessions).map((c) => c.id)).toEqual(["U2", "U3", "kermanych-norec", "kermanych-live"]);
  });
});

describe("Android rotation", () => {
  test("the display rotation of dumpsys window displays", () => {
    expect(parseDisplayRotation("  mDisplayId=0\n    mRotation=3 mAltRotation=false\n  mCurrentRotation=ROTATION_270\n")).toBe(3);
    expect(parseDisplayRotation("mCurrentRotation=ROTATION_0")).toBe(0);
    expect(parseDisplayRotation("mCurrentRotation=ROTATION_90")).toBe(1);
    expect(parseDisplayRotation("no display")).toBeNull();
  });

  test("a display point lands on the panel under it, whatever the rotation", () => {
    const panel = { width: 1080, height: 2400 };
    expect(displayToPanel(412, 988, 0, panel)).toEqual({ x: 412, y: 988 });
    // Measured on TinyApp: in ROTATION_270, Settings' «Connected devices» at display (412, 988)
    // took the tap sent to panel (988, 1988).
    expect(displayToPanel(412, 988, 3, panel)).toEqual({ x: 988, y: 1988 });
    expect(displayToPanel(412, 988, 1, panel)).toEqual({ x: 92, y: 412 });
    expect(displayToPanel(412, 988, 2, panel)).toEqual({ x: 668, y: 1412 });
    // The corners of the rotated display stay on the panel.
    expect(displayToPanel(2400, 1080, 3, panel)).toEqual({ x: 1079, y: 0 });
    expect(displayToPanel(-5, 0, 1, panel)).toEqual({ x: 1079, y: 0 });
  });
});

describe("keyboard", () => {
  test("US-layout HID usages with shift", () => {
    expect(hidForChar("a")).toEqual({ usage: 4, shift: false });
    expect(hidForChar("Z")).toEqual({ usage: 29, shift: true });
    expect(hidForChar("1")).toEqual({ usage: 30, shift: false });
    expect(hidForChar("0")).toEqual({ usage: 39, shift: false });
    expect(hidForChar("@")).toEqual({ usage: 31, shift: true });
    expect(hidForChar("?")).toEqual({ usage: 56, shift: true });
    expect(hidForChar(" ")).toEqual({ usage: 44, shift: false });
    expect(hidForChar("п")).toBeNull();
    expect(hidForChar("😀")).toBeNull();
  });

  test("text splits into typed and pasted runs, emoji kept whole", () => {
    const typable = (ch: string) => hidForChar(ch) !== null;
    expect(splitTyping("wifi Привіт!😀ok", typable)).toEqual([
      { kind: "keys", text: "wifi " },
      { kind: "paste", text: "Привіт" },
      { kind: "keys", text: "!" },
      { kind: "paste", text: "😀" },
      { kind: "keys", text: "ok" },
    ]);
  });
});

describe("registry: local device columns", () => {
  test("round trip, a cloud refresh keeps the choice, malformed blobs read as nothing", () => {
    const reg = new RegistryService(":memory:");
    reg.upsertProject({ id: "P", name: "p", platform: "mobile" });
    const s = reg.createSession({ projectId: "P", name: "s", task: "t", worktreePath: "", branch: "b" });
    expect(reg.getDeviceChoice("P")).toEqual({});
    expect(reg.getSessionDevice(s.id)).toBeNull();
    reg.setDeviceChoice("P", { platform: "android", android: "TinyApp" });
    reg.setSessionDevice(s.id, { platform: "ios", base: "A759", baseName: "iPhone 16", id: "C10E" });
    // The cloud mirror upserts the project without the column: the machine's choice stays.
    reg.upsertProject({ id: "P", name: "renamed", platform: "mobile" });
    expect(reg.getDeviceChoice("P")).toEqual({ platform: "android", android: "TinyApp" });
    expect(reg.getSessionDevice(s.id)).toEqual({ platform: "ios", base: "A759", baseName: "iPhone 16", id: "C10E" });
    reg.setSessionDevice(s.id, null);
    expect(reg.getSessionDevice(s.id)).toBeNull();
    expect(reg.getDeviceChoice("unknown")).toEqual({});
    // A row another version wrote.
    (reg as unknown as { db: { prepare(sql: string): { run(...a: unknown[]): void } } }).db.prepare(`UPDATE projects SET device_choice = ? WHERE id = ?`).run('{"platform":"windows","ios":7,"android":"Vanil"}', "P");
    expect(reg.getDeviceChoice("P")).toEqual({ android: "Vanil" });
  });
});
