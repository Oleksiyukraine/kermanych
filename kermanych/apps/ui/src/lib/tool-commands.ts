// apps/ui/src/lib/tool-commands.ts
// The folded row for omp's «Tool commands» notice (`tool_commands_added` / `_removed`, built by
// apps/api/src/supervisor/transcript-reducer.ts): a summary line plus the name list it hides.
//
// omp names an MCP tool `mcp__<server>_<tool>`, and both halves may contain `_`, so the server
// cannot be split off one name reliably. One notice usually carries one server's batch, so the
// longest prefix the names share, cut at a `_`, is shown once as the group label and dropped
// from every item. It is only ever a literal shared prefix: label + `_` + item is the real name.

export type ToolCommandGroup = { prefix: string; items: string[] };

const MCP = 'mcp__';

export function toolCommandGroup(joined: string): ToolCommandGroup {
  const names = joined
    .split(',')
    .map((n) => n.trim())
    .filter(Boolean)
    .map((n) => (n.startsWith(MCP) ? n.slice(MCP.length) : n));
  if (names.length < 2) return { prefix: '', items: names };
  let common = names[0]!;
  for (const n of names) {
    let i = 0;
    while (i < common.length && i < n.length && common[i] === n[i]) i++;
    common = common.slice(0, i);
  }
  const cut = common.lastIndexOf('_');
  if (cut <= 0) return { prefix: '', items: names };
  return { prefix: common.slice(0, cut), items: names.map((n) => n.slice(cut + 1)) };
}
