// apps/api/test/android-sdk.spec.ts
// Where the Android driver finds the SDK without ANDROID_HOME (docs/specs/2026-11-03-mobile-device-preview.md,
// decision 3): the Android Studio default of the platform Kermanych runs on.
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "android-sdk-"));
  vi.stubEnv("HOME", home);
  vi.stubEnv("ANDROID_HOME", "");
  vi.stubEnv("ANDROID_SDK_ROOT", "");
  vi.resetModules();
});

afterEach(() => {
  Object.defineProperty(process, "platform", platform);
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
});

// Dynamic import: the default is fixed when the module loads, so each platform needs a fresh load.
async function androidSdkOn(os: NodeJS.Platform): Promise<string | null> {
  Object.defineProperty(process, "platform", { ...platform, value: os });
  const { androidSdk } = await import("../src/device/android.driver");
  return androidSdk();
}

test("on Linux the SDK Android Studio put in ~/Android/Sdk is found", async () => {
  mkdirSync(join(home, "Android", "Sdk"), { recursive: true });
  expect(await androidSdkOn("linux")).toBe(join(home, "Android", "Sdk"));
});

test("on macOS ~/Library/Android/sdk stays the default and ~/Android/Sdk is not looked at", async () => {
  mkdirSync(join(home, "Android", "Sdk"), { recursive: true });
  expect(await androidSdkOn("darwin")).toBeNull();
  mkdirSync(join(home, "Library", "Android", "sdk"), { recursive: true });
  expect(await androidSdkOn("darwin")).toBe(join(home, "Library", "Android", "sdk"));
});

test("ANDROID_HOME wins over the default", async () => {
  mkdirSync(join(home, "Android", "Sdk"), { recursive: true });
  const own = join(home, "sdk");
  mkdirSync(own);
  vi.stubEnv("ANDROID_HOME", own);
  expect(await androidSdkOn("linux")).toBe(own);
});
