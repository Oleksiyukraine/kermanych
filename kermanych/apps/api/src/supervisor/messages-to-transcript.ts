import type { TranscriptEntry } from "@kermanych/core";

// Shape of omp's converted history messages (get_messages / get_messages_page) we map from.
export type OmpPart = {
  type: string;
  text?: string;
  thinking?: string;
  name?: string;
  arguments?: { command?: string; path?: string };
  intent?: string;
  data?: string;
  mimeType?: string;
};
export type OmpMessage = { role?: string; content?: OmpPart[]; toolName?: string; isError?: boolean };

// Map omp's converted message history into transcript entries, mirroring the live
// event reduction: user text/images, assistant reasoning then text, tool calls, and
// tool results. Reasoning parts ({ type:"thinking" }) map to assistant_thinking and
// render as a collapsed block in the UI.
export function messagesToTranscript(messages: unknown[]): TranscriptEntry[] {
  const out: TranscriptEntry[] = [];
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
        else if (p.type === "toolCall") out.push({ kind: "tool_call", tool: p.name ?? "?", summary: p.arguments?.command ?? p.arguments?.path ?? p.intent });
      }
    } else if (m.role === "toolResult") {
      const summary = parts.filter((p) => p.type === "text").map((p) => p.text ?? "").join("\n");
      out.push({ kind: "tool_result", tool: m.toolName ?? "?", ok: !m.isError, summary });
    }
  }
  return out;
}
