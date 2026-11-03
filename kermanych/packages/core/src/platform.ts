// What a project ships (docs/specs/2026-11-03-session-browser-preview.md, decision 9). Set on
// the project — at creation or in its settings — never on a task. It gates the session browser
// and the live preview: a back-end or a mobile project has neither. Absent (NULL in the cloud)
// is «Не визначено» and keeps both, which is how every project that predates the setting reads.
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
