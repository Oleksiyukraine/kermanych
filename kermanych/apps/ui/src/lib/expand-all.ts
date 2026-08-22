// One press of the chat panel's detail toolbar.
//
// A plain boolean cannot express this. The toolbar's two buttons promise an action, but a
// boolean only ever *changes* — so with the flag already `false`, pressing «згорнути все»
// assigns `false` over `false`, no watcher fires, and every card the operator opened by
// hand stays open. `seq` increments on every press, so each press is a distinct command
// that the rows can react to even when the mode it asks for is the one already set.
export type ExpandAllCommand = { on: boolean; seq: number };

export const EXPAND_ALL_NONE: ExpandAllCommand = { on: false, seq: 0 };

export function nextExpandAll(prev: ExpandAllCommand, on: boolean): ExpandAllCommand {
  return { on, seq: prev.seq + 1 };
}
