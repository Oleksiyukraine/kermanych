// apps/ui/src/lib/tool-commands.ts
// The row for omp's «Tool commands» notices (`tool_commands_added` / `_removed`, built by
// apps/api/src/supervisor/transcript-reducer.ts and coalesced by `buildChatBlocks`): which
// servers' tools were mounted or unmounted, and the tool names under each.
//
// omp names an MCP tool `mcp__<server>_<tool>`, and both halves may contain `_`, so the server
// cannot be split off one name reliably. omp announces each server as it connects, so one
// notice is one server's batch: the longest prefix its names share, cut at a `_`, is the
// server. It is only ever a literal shared prefix: server + `_` + tool is the real name.
import type { NoticeEntry } from '@kermanych/core';

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

export type ToolCommandServer = { server: string; tools: string[]; state: 'added' | 'removed' };

// One entry per server, in the order the servers first appeared. A lone tool joins a server
// another notice in the run already named when it starts with `<server>_`; otherwise its
// whole name stands as the server, with no tool list under it. A server that is mounted and
// later unmounted in the same run ends `removed`: the row reports where things stand.
export function toolCommandServers(notices: NoticeEntry[]): ToolCommandServer[] {
  const out = new Map<string, ToolCommandServer>();
  const batches = notices.map((n) => ({
    state: n.code === 'tool_commands_removed' ? ('removed' as const) : ('added' as const),
    group: toolCommandGroup(String(n.params?.names ?? '')),
  }));
  const known = batches.map((b) => b.group.prefix).filter(Boolean);
  const put = (server: string, tools: string[], state: ToolCommandServer['state']) => {
    const prev = out.get(server);
    if (prev && prev.state === state) prev.tools = [...new Set([...prev.tools, ...tools])];
    else out.set(server, { server, tools, state });
  };
  for (const { state, group } of batches) {
    if (group.prefix) {
      put(group.prefix, group.items, state);
      continue;
    }
    // No shared prefix: a lone tool, or a batch of unrelated ones — each finds its own server.
    for (const name of group.items) {
      const owner = known.find((k) => name.startsWith(`${k}_`));
      if (owner) put(owner, [name.slice(owner.length + 1)], state);
      else put(name, [], state);
    }
  }
  return [...out.values()];
}
