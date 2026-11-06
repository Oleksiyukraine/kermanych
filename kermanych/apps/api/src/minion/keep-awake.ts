// apps/api/src/minion/keep-awake.ts
// While a «Посіпака» run is in progress the machine must not go to idle sleep
// (docs/specs/2026-10-23-minion-auto-run.md, decision 13), nor while a scheduled agent run is
// (docs/specs/2026-11-06-scheduled-tasks.md, «Keep-awake»). The api imports nothing from
// electron, so the desktop app hands its implementation in through `bootstrap({ keepAwake })`
// (Electron's powerSaveBlocker), the way it hands in the session browser (browser-host.ts); a
// standalone api has none, and the machine sleeps as usual.

// `hold(true)` while at least one holder needs the machine awake, `hold(false)` once none does.
export type KeepAwake = (hold: boolean) => void;

// Who asks: each service tells only its own need, so one service's «done» never releases the
// other's run.
export type AwakeHolder = "minion" | "schedule";

let hook: KeepAwake | undefined;
const holders = new Set<AwakeHolder>();

// A new hook starts from nobody holding: the desktop app sets it once, a spec once per test.
export function setKeepAwake(fn: KeepAwake | undefined): void {
  hook = fn;
  holders.clear();
}

// The hook hears only changes of the combined need.
export function holdAwake(holder: AwakeHolder, hold: boolean): void {
  const before = holders.size > 0;
  if (hold) holders.add(holder);
  else holders.delete(holder);
  const after = holders.size > 0;
  if (before !== after) hook?.(after);
}
