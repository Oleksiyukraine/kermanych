import type { TranscriptEntry, ToolStatus } from "@kermanych/core";
import { toolCallSummary } from "@kermanych/core";

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
export type OmpMessage = { role?: string; content?: OmpPart[]; toolName?: string; isError?: boolean };

// Map omp's converted message history into transcript entries, mirroring the live
// event reduction: user text/images, assistant reasoning then text, and tool
// invocations. Each toolCall becomes one `pending` entry; the following toolResult
// message pairs to the oldest pending entry of the same tool name (FIFO — correct
// for interchangeable parallel calls), flips its status, and appends any result
// text to the summary so bash-style output survives. Reasoning parts
// ({ type:"thinking" }) map to assistant_thinking and render as a collapsed block.
export function messagesToTranscript(messages: unknown[]): TranscriptEntry[] {
  const out: TranscriptEntry[] = [];
  let seq = 0;
  for (const raw of messages) {
    const m = raw as OmpMessage;
    const parts = m.content ?? [];
    if (m.role === "user") {
      const text = parts.filter((p) => p.type === "text").map((p) => p.text ?? "").join("");
      const images = parts
        .filter((p) => p.type === "image" && p.data)
        .map((p) => `data:${p.mimeType ?? "image/png"};base64,${p.data}`);
      if (text.trim() || images.length) out.push({ kind: "user_text", text, images: images.length ? images : undefined });
    } else if (m.role === "assistant") {
      for (const p of parts) {
        if (p.type === "thinking" && p.thinking?.trim()) out.push({ kind: "assistant_thinking", text: p.thinking });
        else if (p.type === "text" && p.text?.trim()) out.push({ kind: "assistant_text", text: p.text });
        else if (p.type === "toolCall")
          out.push({ kind: "tool", id: `h${++seq}`, tool: p.name ?? "?", status: "pending", summary: toolCallSummary(p.arguments, p.intent) });
      }
    } else if (m.role === "toolResult") {
      const text = parts.filter((p) => p.type === "text").map((p) => p.text ?? "").join("\n");
      const tool = m.toolName ?? "?";
      const status: ToolStatus = m.isError ? "error" : "ok";
      const entry = out.find((x) => x.kind === "tool" && x.status === "pending" && x.tool === tool);
      if (entry && entry.kind === "tool") {
        entry.status = status;
        if (text.trim()) entry.summary = entry.summary ? `${entry.summary}\n${text}` : text;
      } else {
        out.push({ kind: "tool", id: `h${++seq}`, tool, status, summary: text.trim() ? text : undefined });
      }
    }
  }
  return out;
}
