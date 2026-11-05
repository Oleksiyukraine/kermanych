import { describe, expect, it } from "vitest";
import { parsePreviewConfig, previewPlatforms } from "../src/preview";

// The `device` block of docs/specs/2026-11-03-mobile-device-preview.md, decision 5.
const parse = (v: unknown) => parsePreviewConfig(JSON.stringify(v));
const err = (v: unknown) => {
  const r = parse(v);
  if (r.ok) throw new Error("expected an invalid file");
  return r.error;
};

describe("parsePreviewConfig: device block", () => {
  it("accepts a native app with no services: setup + install", () => {
    const r = parse({ setup: "make", device: { ios: { app: "com.acme.app", install: "make install" } } });
    expect(r).toEqual({
      ok: true,
      config: { setup: "make", services: [], device: { ios: { app: "com.acme.app", install: "make install" } } },
    });
  });

  it("accepts a device service that installs the app itself, with no open service", () => {
    const r = parse({
      services: [{ name: "app", device: true, command: "flutter run -d $DEVICE_ID" }],
      device: { ios: { app: "grano.app.com" }, android: { app: "grano.app.com" } },
    });
    expect(r.ok && r.config.services[0]!.device).toBe(true);
    expect(r.ok && previewPlatforms(r.config)).toEqual(["ios", "android"]);
  });

  it("refuses an open service next to a device block: a Mobile project has no page", () => {
    expect(
      err({ services: [{ name: "web", open: true, command: "vite" }], device: { android: { app: "com.acme.app" } } }),
    ).toMatch(/^services: "open" is for a web page/);
  });

  it("refuses a device service together with an install command", () => {
    expect(
      err({
        services: [{ name: "app", device: true, command: "flutter run" }],
        device: { ios: { app: "com.acme.app" }, android: { app: "com.acme.app", install: "./gradlew installDebug" } },
      }),
    ).toMatch(/device\.android\.install must go/);
  });

  it("refuses two device services", () => {
    expect(
      err({
        services: [
          { name: "a", device: true, command: "x" },
          { name: "b", device: true, command: "y" },
        ],
        device: { ios: { app: "com.acme.app" } },
      }),
    ).toMatch(/at most one service/);
  });

  it("refuses a device service without a device block", () => {
    expect(err({ services: [{ name: "web", open: true, command: "vite" }, { name: "app", device: true, command: "x" }] })).toBe(
      'services[1].device: needs a "device" block naming the app',
    );
  });

  it("names the bad field of the block", () => {
    expect(err({ device: {} })).toBe("device: needs ios and/or android");
    expect(err({ device: { web: { app: "a.b" } } })).toBe("device.web: unknown platform (ios or android)");
    expect(err({ device: { ios: { app: "noDots" } } })).toMatch(/^device\.ios\.app: must be the bundle id/);
    expect(err({ device: { ios: { app: "a.b", launch: true } } })).toBe("device.ios.launch: unknown field");
    expect(err({ device: { android: { app: "a.b", install: " " } } })).toBe("device.android.install: must be a non-empty string");
  });

  it("reserves the device and install step names", () => {
    expect(err({ services: [{ name: "install", command: "x" }], device: { ios: { app: "a.b" } } })).toMatch(/Kermanych's own step/);
    expect(err({ services: [{ name: "device", command: "x" }], device: { ios: { app: "a.b" } } })).toMatch(/Kermanych's own step/);
  });

  it("knows the device variables only when there is a device block, and reserves them", () => {
    const svc = (env: Record<string, string>) => ({ name: "metro", command: "x", env });
    expect(parse({ services: [svc({ SERIAL: "${ANDROID_SERIAL}" })], device: { android: { app: "a.b" } } }).ok).toBe(true);
    expect(err({ services: [svc({ DEVICE_ID: "x" })], device: { android: { app: "a.b" } } })).toMatch(/set by Kermanych/);
    expect(err({ services: [{ ...svc({ ID: "${DEVICE_ID}" }), open: true }] })).toMatch(/unknown variable \$\{DEVICE_ID\}/);
  });

  it("still requires services and one open service without a device block", () => {
    expect(err({ setup: "x" })).toBe("services: must be a non-empty array");
    expect(err({ services: [{ name: "web", command: "vite" }] })).toMatch(/exactly one service needs "open": true \(found 0\)/);
  });
});
