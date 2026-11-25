import { describe, expect, it } from "vitest";
import { deviceName, isIosUa } from "../src/lib/device";

const UA = {
  iphoneSafari:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
  iphoneChrome:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/126.0.6478.54 Mobile/15E148 Safari/604.1",
  iphoneFirefox:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/127.0 Mobile/15E148 Safari/605.1.15",
  ipadDesktop: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15",
  androidChrome:
    "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36",
  androidSamsung:
    "Mozilla/5.0 (Linux; Android 14; SM-S911B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/25.0 Chrome/121.0.0.0 Mobile Safari/537.36",
  androidFirefox: "Mozilla/5.0 (Android 14; Mobile; rv:127.0) Gecko/127.0 Firefox/127.0",
  androidEdge:
    "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36 EdgA/126.0.0.0",
  linuxChrome: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
};

describe("deviceName", () => {
  it.each([
    [UA.iphoneSafari, 5, "iPhone · Safari"],
    [UA.iphoneChrome, 5, "iPhone · Chrome"],
    [UA.iphoneFirefox, 5, "iPhone · Firefox"],
    [UA.ipadDesktop, 5, "iPad · Safari"],
    [UA.ipadDesktop, 0, "Mac · Safari"],
    [UA.androidChrome, 5, "Android · Chrome"],
    [UA.androidSamsung, 5, "Android · Samsung Internet"],
    [UA.androidFirefox, 5, "Android · Firefox"],
    [UA.androidEdge, 5, "Android · Edge"],
    [UA.linuxChrome, 0, "Linux · Chrome"],
  ])("%s (%i touch points) → %s", (ua, touch, name) => {
    expect(deviceName(ua, touch)).toBe(name);
  });

  it("names an unknown agent without a browser", () => {
    expect(deviceName("curl/8.0")).toBe("Browser");
  });
});

describe("isIosUa", () => {
  it("knows an iPhone, and an iPad that calls itself a Mac by its touch points", () => {
    expect(isIosUa(UA.iphoneSafari)).toBe(true);
    expect(isIosUa(UA.iphoneChrome)).toBe(true);
    expect(isIosUa(UA.ipadDesktop, 5)).toBe(true);
    expect(isIosUa(UA.ipadDesktop, 0)).toBe(false);
    expect(isIosUa(UA.androidChrome, 5)).toBe(false);
  });
});
