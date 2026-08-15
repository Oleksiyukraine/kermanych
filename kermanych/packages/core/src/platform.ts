// The build target a task/agent works on. Pure metadata: it labels the session
// (shown as a board tag, editable in the launcher) and never influences the omp
// launch. Optional — a cross-cutting task may carry no platform.
export const PLATFORMS = ["backend", "web", "mobile"] as const;
export type Platform = (typeof PLATFORMS)[number];
