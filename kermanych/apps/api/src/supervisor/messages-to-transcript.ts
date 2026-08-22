import type { TranscriptEntry } from "@kermanych/core";
import { applyToolResult, joinResultText, pendingToolEntry } from "./transcript-reducer";

// Shape of omp's converted history messages (get_messages / get_messages_page) we map from.
export type OmpPart = {
  type: string;
  text?: string;
  thinking?: string;
  name?: string;
  arguments?: Record<string, unknown>;
  intent?: string;
  data?: string;
  mimeType?: string;
};
export type OmpMessage = {
  role?: string;
  content?: OmpPart[];
  toolName?: string;
  isError?: boolean;
  details?: Record<string, unknown>;
  timestamp?: number;
};

// Map omp's converted message history into transcript entries through the same reducers
// the live stream uses (`pendingToolEntry` / `applyToolResult`), so a session that streamed
// and the same session after a reload render identically. Each toolCall becomes one
// `pending` entry; the following toolResult message pairs to the oldest pending entry of
// the same tool name (FIFO — correct for interchangeable parallel calls) and fills in its
// stat, count and clamped detail. Reasoning parts ({ type:"thinking" }) map to
// assistant_thinking and render as a collapsed block.
export function messagesToTranscript(messages: unknown[]): TranscriptEntry[] {
  const out: TranscriptEntry[] = [];
  let seq = 0;
  let clock = 0;
  // Call args per pending entry id, so the result reduction sees exactly what the live path
  // sees from `ReduceOpts.pendingArgs` — omp's history repeats them no more than its stream does.
  const pendingArgs = new Map<string, Record<string, unknown>>();
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
      if (text.trim() || images.length) out.push({ kind: "user_text", id: `h${++seq}`, at, text, ...(images.length ? { images } : {}) });
    } else if (m.role === "assistant") {
      for (const p of parts) {
        if (p.type === "thinking" && p.thinking?.trim()) out.push({ kind: "assistant_thinking", id: `h${++seq}`, at, text: p.thinking });
        else if (p.type === "text" && p.text?.trim()) out.push({ kind: "assistant_text", id: `h${++seq}`, at, text: p.text });
        else if (p.type === "toolCall") {
          const id = `h${++seq}`;
          if (p.arguments) pendingArgs.set(id, p.arguments);
          out.push(pendingToolEntry(id, at, p.name ?? "?", p.arguments, p.intent));
        }
      }
    } else if (m.role === "toolResult") {
      const tool = m.toolName ?? "?";
      const found = out.find((x) => x.kind === "tool" && x.status === "pending" && x.tool === tool);
      // An unmatched result (history paged mid-call) still earns its own completed row.
      const entry = found?.kind === "tool" ? found : pendingToolEntry(`h${++seq}`, at, tool, undefined);
      const args = pendingArgs.get(entry.id);
      pendingArgs.delete(entry.id);
      applyToolResult(entry, args, m.details, joinResultText(parts.filter((p) => p.type === "text")), m.isError === true);
      if (found?.kind !== "tool") out.push(entry);
    }
  }
  return out;
}
