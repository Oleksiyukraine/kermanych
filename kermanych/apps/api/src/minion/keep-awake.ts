// apps/api/src/minion/keep-awake.ts
// While a «Посіпака» run is in progress the machine must not go to idle sleep
// (docs/specs/2026-10-23-minion-auto-run.md, decision 13). The api imports nothing from
// electron, so the desktop app hands its implementation in through `bootstrap({ keepAwake })`
// (Electron's powerSaveBlocker), the way it hands in the session browser (browser-host.ts); a
// standalone api has none, and the machine sleeps as usual.

// `hold(true)` while at least one minion run is in progress, `hold(false)` once none is.
export type KeepAwake = (hold: boolean) => void;

let hook: KeepAwake | undefined;

export function setKeepAwake(fn: KeepAwake | undefined): void {
  hook = fn;
}

export function keepAwake(): KeepAwake | undefined {
  return hook;
}
