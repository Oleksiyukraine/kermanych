// What the phone knows about itself. Pure functions of the user agent (and touch points, for the
// iPad that calls itself a Mac) so test/device.spec.ts can pin them; `here()` reads the live values.

/** The device's name at pairing, as the desktop lists it under «Підключені телефони» (decision 5). */
export function deviceName(ua: string, maxTouchPoints = 0): string {
  const os = osOf(ua, maxTouchPoints);
  const browser = browserOf(ua);
  return browser ? `${os} · ${browser}` : os;
}

function osOf(ua: string, maxTouchPoints: number): string {
  if (/iPhone|iPod/.test(ua)) return "iPhone";
  if (/iPad/.test(ua) || (/Macintosh/.test(ua) && maxTouchPoints > 1)) return "iPad";
  if (/Android/.test(ua)) return "Android";
  if (/Windows/.test(ua)) return "Windows";
  if (/Mac OS X|Macintosh/.test(ua)) return "Mac";
  if (/CrOS/.test(ua)) return "ChromeOS";
  if (/Linux/.test(ua)) return "Linux";
  return "Browser";
}

function browserOf(ua: string): string | undefined {
  // Order matters: every Chromium browser also says «Chrome» and «Safari», and iOS ones say «Safari».
  if (/EdgiOS|EdgA|Edg\//.test(ua)) return "Edge";
  if (/OPR\/|OPiOS|Opera/.test(ua)) return "Opera";
  if (/SamsungBrowser/.test(ua)) return "Samsung Internet";
  if (/YaBrowser/.test(ua)) return "Yandex";
  if (/FxiOS|Firefox\//.test(ua)) return "Firefox";
  if (/CriOS|Chrome\//.test(ua)) return "Chrome";
  if (/Safari\//.test(ua)) return "Safari";
  return undefined;
}

export function isIosUa(ua: string, maxTouchPoints = 0): boolean {
  return /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && maxTouchPoints > 1);
}

/** Running as a home-screen app: iOS's own flag, or the standard display-mode query. */
export function isStandalone(): boolean {
  if (navigator.standalone === true) return true;
  return typeof matchMedia === "function" && matchMedia("(display-mode: standalone)").matches;
}

export function isIos(): boolean {
  return isIosUa(navigator.userAgent, navigator.maxTouchPoints ?? 0);
}

export function thisDeviceName(): string {
  return deviceName(navigator.userAgent, navigator.maxTouchPoints ?? 0);
}
