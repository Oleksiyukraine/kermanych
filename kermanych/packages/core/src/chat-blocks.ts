import type { TranscriptEntry } from "./types";

export type ToolEntry = Extract<TranscriptEntry, { kind: "tool" }>;
export type UserEntry = Extract<TranscriptEntry, { kind: "user_text" }>;

export type ChatItem =
  | { kind: "entry"; entry: TranscriptEntry; muted: boolean }
  | { kind: "group"; tool: string; members: ToolEntry[]; stat: string };

export type BlockSummary = { ms: number; calls: number; files: number; thinkMs: number; cost: number };
export type ChatBlock = { id: string; request?: UserEntry; items: ChatItem[]; summary: BlockSummary };

// Reasoning shorter than this is technical latency, not a pause worth a row. It stays
// in the block (muted) so "розгорнути все" can reveal it, and its time is still summed.
export const THINK_MIN_MS = 8_000;

// Read-like tools whose consecutive runs collapse into one row, mirroring omp's
// #lastReadGroup behaviour. Anything that mutates the repo is never grouped.
export const COALESCE_TOOLS = ["read", "grep", "glob"] as const;

const TOUCHING = ["edit", "write"];
const UNIT: Record<string, string> = { read: "ln", grep: "збігів", glob: "файлів" };

function groupStat(tool: string, members: ToolEntry[]): string {
  const total = members.reduce((sum, m) => sum + (m.count ?? 0), 0);
  return `${total} ${UNIT[tool] ?? ""}`.trim();
}

export function buildChatBlocks(entries: TranscriptEntry[], opts?: { thinkMinMs?: number }): ChatBlock[] {
  const thinkMinMs = opts?.thinkMinMs ?? THINK_MIN_MS;
  const blocks: ChatBlock[] = [];
  let current: ChatBlock | undefined;

  const open = (id: string, request?: UserEntry) => {
    current = { id, ...(request ? { request } : {}), items: [], summary: { ms: 0, calls: 0, files: 0, thinkMs: 0, cost: 0 } };
    blocks.push(current);
  };

  const files = new Map<ChatBlock, Set<string>>();
  const bounds = new Map<ChatBlock, { first: number; last: number }>();

  for (const entry of entries) {
    if (entry.kind === "user_text") open(entry.id, entry);
    if (!current) open("pre");
    const block = current!;
    if (!files.has(block)) files.set(block, new Set());
    const span = bounds.get(block) ?? { first: entry.at, last: entry.at };
    span.last = entry.at;
    bounds.set(block, span);

    if (entry.kind === "turn") {
      block.summary.cost += entry.usage?.cost ?? 0;
      continue;
    }
    if (entry.kind === "user_text") continue;
    if (entry.kind === "assistant_thinking") {
      block.summary.thinkMs += entry.ms ?? 0;
      block.items.push({ kind: "entry", entry, muted: (entry.ms ?? 0) < thinkMinMs });
      continue;
    }
    if (entry.kind === "tool") {
      block.summary.calls += 1;
      if (TOUCHING.includes(entry.tool) && entry.target) files.get(block)!.add(entry.target);
      const last = block.items.at(-1);
      const groupable = (COALESCE_TOOLS as readonly string[]).includes(entry.tool);
      if (groupable && last?.kind === "group" && last.tool === entry.tool) {
        last.members.push(entry);
        last.stat = groupStat(entry.tool, last.members);
        continue;
      }
      if (groupable && last?.kind === "entry" && last.entry.kind === "tool" && last.entry.tool === entry.tool) {
        const members = [last.entry, entry];
        block.items[block.items.length - 1] = { kind: "group", tool: entry.tool, members, stat: groupStat(entry.tool, members) };
        continue;
      }
      block.items.push({ kind: "entry", entry, muted: false });
      continue;
    }
    block.items.push({ kind: "entry", entry, muted: false });
  }

  for (const block of blocks) {
    const span = bounds.get(block);
    block.summary.ms = span ? span.last - (block.request?.at ?? span.first) : 0;
    block.summary.files = files.get(block)?.size ?? 0;
  }
  return blocks;
}
