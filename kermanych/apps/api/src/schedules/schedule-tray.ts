// apps/api/src/schedules/schedule-tray.ts
// The desktop app's menu-bar icon (docs/specs/2026-11-06-scheduled-tasks.md, decision 4) needs
// two facts from the api: whether any scheduled task is enabled (closing the window then hides
// it instead of quitting) and the next firing for the menu. The api imports nothing from
// electron, so the app hands its listener in through `bootstrap({ schedules })`, the way it hands
// in keep-awake (minion/keep-awake.ts); a standalone api has none.
import type { ScheduleTrayState } from "@kermanych/core";

export type ScheduleTrayListener = (s: ScheduleTrayState) => void;

let hook: ScheduleTrayListener | undefined;

export function setScheduleTray(fn: ScheduleTrayListener | undefined): void {
  hook = fn;
}

export function scheduleTray(): ScheduleTrayListener | undefined {
  return hook;
}
