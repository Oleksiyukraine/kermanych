// What a project ships (docs/specs/2026-11-03-session-browser-preview.md, decision 9). Set on
// the project — at creation or in its settings — never on a task. It gates the session browser,
// the device and the live preview (docs/specs/2026-11-03-mobile-device-preview.md, decision 8):
// web has the browser, mobile the device, back-end neither. Absent (NULL in the cloud) is «Не
// визначено» and keeps the browser, which is how every project that predates the setting reads.
export const PLATFORMS = ["web", "backend", "mobile"] as const;
export type Platform = (typeof PLATFORMS)[number];

export function isPlatform(v: unknown): v is Platform {
  return typeof v === "string" && (PLATFORMS as readonly string[]).includes(v);
}

// Whether the sessions of a project on this platform get the «Браузер» tab, the browser tools
// and the live preview. An unknown value never reaches here: readers map it to undefined.
export function platformHasBrowser(platform: Platform | null | undefined): boolean {
  return platform !== "backend" && platform !== "mobile";
}

// Whether the sessions of a project on this platform get the «Пристрій» tab and the device tools.
export function platformHasDevice(platform: Platform | null | undefined): boolean {
  return platform === "mobile";
}

// Whether they get the live preview and its tools: the browser's or the device's.
export function platformHasPreview(platform: Platform | null | undefined): boolean {
  return platformHasBrowser(platform) || platformHasDevice(platform);
}
