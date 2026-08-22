import type { ToolLine, TranscriptEntry } from "@kermanych/core";
import { applyToolResult, hasTurnMeta, joinResultText, pendingToolEntry, turnEntry, type TurnMeta } from "./transcript-reducer";

// Shape of omp's converted history messages (get_messages / get_messages_page) we map from.
export type OmpPart = {
  type: string;
  // omp's own id for a `toolCall` part; the matching `toolResult` message repeats it.
  id?: string;
  text?: string;
  thinking?: string;
  name?: string;
  arguments?: Record<string, unknown>;
  intent?: string;
  data?: string;
  mimeType?: string;
};
export type OmpMessage = TurnMeta & {
  role?: string;
  content?: OmpPart[];
  toolName?: string;
  toolCallId?: string;
  isError?: boolean;
  details?: Record<string, unknown>;
  timestamp?: number;
};

// Entries plus the unclamped tool lines behind them, mirroring `reduceRpcEvents`: the caller
// feeds `full` into the detail cache so a rehydrated row can still be expanded.
export type Rehydrated = { entries: TranscriptEntry[]; full: Map<string, ToolLine[]> };

// Map omp's converted message history into transcript entries through the same reducers the
// live stream uses (`pendingToolEntry` / `applyToolResult` / `turnEntry`), so a session that
// streamed and the same session after a reload render identically. Each toolCall becomes one
// `pending` entry; the following toolResult message pairs to the oldest pending entry of the
// same tool name (FIFO — correct for interchangeable parallel calls) and fills in its stat,
// count and clamped detail. Reasoning parts ({ type:"thinking" }) map to assistant_thinking
// and render as a collapsed block.
export function messagesToTranscript(messages: unknown[]): Rehydrated {
  const entries: TranscriptEntry[] = [];
  const full = new Map<string, ToolLine[]>();
  let seq = 0;
  let clock = 0;
  // Call args per pending entry id, so the result reduction sees exactly what the live path
  // sees from `ReduceOpts.pendingArgs` — omp's history repeats them no more than its stream does.
  const pendingArgs = new Map<string, Record<string, unknown>>();
  // omp's own toolCall id -> the entry id we minted for it. Real history issues 2-4 parallel
  // calls per assistant message, and their results come back in whatever order they finished:
  // pairing on the id is the only way a row keeps its own stat, count and detail.
  const rowByCallId = new Map<string, string>();
  for (const raw of messages) {
    const m = raw as OmpMessage;
    const parts = m.content ?? [];
    // Not every omp build stamps history messages; `at` only has to keep entries ordered.
    const at = typeof m.timestamp === "number" ? m.timestamp : ++clock;
    if (m.role === "user") {
      const text = parts.filter((p) => p.type === "text").map((p) => p.text ?? "").join("");
      const images = parts
        .filter((p) => p.type === "image" && p.data)
        .map((p) => `data:${p.mimeType ?? "image/png"};base64,${p.data}`);
      if (text.trim() || images.length) entries.push({ kind: "user_text", id: `h${++seq}`, at, text, ...(images.length ? { images } : {}) });
    } else if (m.role === "assistant") {
      for (const p of parts) {
        if (p.type === "thinking" && p.thinking?.trim())
          entries.push({
            kind: "assistant_thinking", id: `h${++seq}`, at, text: p.thinking,
            // Mirrors the live path, which stamps reasoning with the closing message's duration.
            // Absent in history from an omp build that does not preserve it: then no chip time.
            ...(m.duration === undefined ? {} : { ms: m.duration }),
            ...(m.usage?.output === undefined ? {} : { tokens: m.usage.output }),
          });
        else if (p.type === "text" && p.text?.trim()) entries.push({ kind: "assistant_text", id: `h${++seq}`, at, text: p.text });
        else if (p.type === "toolCall") {
          const id = `h${++seq}`;
          if (p.arguments) pendingArgs.set(id, p.arguments);
          if (p.id) rowByCallId.set(p.id, id);
          entries.push(pendingToolEntry(id, at, p.name ?? "?", p.arguments, p.intent));
        }
      }
      // A no-op when omp's converted history carries no accounting — better a missing footer
      // number than a fabricated zero-cost turn.
      if (hasTurnMeta(m)) entries.push(turnEntry(`h${++seq}`, at, m));
    } else if (m.role === "toolResult") {
      const tool = m.toolName ?? "?";
      const rowId = m.toolCallId === undefined ? undefined : rowByCallId.get(m.toolCallId);
      // FIFO by tool name is only the fallback, for history that predates the ids.
      const found =
        (rowId === undefined ? undefined : entries.find((x) => x.kind === "tool" && x.id === rowId)) ??
        entries.find((x) => x.kind === "tool" && x.status === "pending" && x.tool === tool);
      // An unmatched result (history paged mid-call) still earns its own completed row.
      const entry = found?.kind === "tool" ? found : pendingToolEntry(`h${++seq}`, at, tool, undefined);
      const args = pendingArgs.get(entry.id);
      pendingArgs.delete(entry.id);
      const lines = applyToolResult(entry, args, m.details, joinResultText(parts), m.isError === true);
      // Keyed by the id that lands on the entry, which is what GET /sessions/:id/tools/:callId asks for.
      if (lines.length) full.set(entry.id, lines);
      if (found?.kind !== "tool") entries.push(entry);
    }
  }
  return { entries, full };
}
