// apps/api/src/runtime/claude-history.ts
import type { SessionMessage } from "@anthropic-ai/claude-agent-sdk";
import type { OmpMessage, OmpPart } from "../supervisor/messages-to-transcript";

// Anthropic Messages API content-block shapes we read out of a SessionMessage. Cast loosely,
// exactly as `claude-event-map.ts` does for the live stream — the SDK types the block union
// as `unknown` inside `SessionMessage.message`.
type Block = Record<string, unknown> & { type?: string };

// Join a tool_result block's `content` (string, or an array of text/other blocks) into the
// plain text the transcript reducer renders — the same rule the live path applies.
function resultText(raw: unknown): string {
  if (typeof raw === "string") return raw;
  if (Array.isArray(raw))
    return (raw as Array<{ type?: string; text?: string }>).filter((c) => c.type === "text").map((c) => c.text ?? "").join("\n");
  return "";
}

// Map the assistant `BetaMessage.usage` (Anthropic snake_case token counts) into the omp
// TurnMeta accounting shape. History carries no per-turn cost, so `cost` is omitted.
function usageOf(message: Record<string, unknown>): OmpMessage["usage"] | undefined {
  const u = message.usage as Record<string, unknown> | undefined;
  if (!u) return undefined;
  const num = (k: string) => (typeof u[k] === "number" ? (u[k] as number) : undefined);
  const input = num("input_tokens");
  const output = num("output_tokens");
  const cacheRead = num("cache_read_input_tokens");
  const cacheWrite = num("cache_creation_input_tokens");
  if (input === undefined && output === undefined && cacheRead === undefined && cacheWrite === undefined) return undefined;
  return {
    ...(input === undefined ? {} : { input }),
    ...(output === undefined ? {} : { output }),
    ...(cacheRead === undefined ? {} : { cacheRead }),
    ...(cacheWrite === undefined ? {} : { cacheWrite }),
  };
}

// Convert claude's historical session transcript (as returned by the SDK's
// `getSessionMessages`) into the omp `OmpMessage[]` seam `messagesToTranscript` consumes, so a
// resumed/forked claude session re-renders identically to the live stream. Mirrors the block
// handling in `claude-event-map.ts`: assistant text/thinking/tool_use parts on one `assistant`
// message; each user `tool_result` block becomes its own `toolResult` message paired on the
// tool_use id. `type:'system'` messages are skipped; `parent_agent_id`/`parent_tool_use_id`
// linkage is not surfaced this increment (nested-subagent panes are out of scope).
export function claudeHistoryToOmp(msgs: SessionMessage[]): OmpMessage[] {
  const out: OmpMessage[] = [];
  // tool_use id -> tool name, so a later tool_result (which repeats only the id) can name its
  // row for the FIFO fallback in `messagesToTranscript`.
  const toolNames = new Map<string, string>();
  for (const sm of msgs) {
    if (sm.type === "system") continue;
    const message = (sm.message ?? {}) as Record<string, unknown>;
    const rawContent = message.content;
    const blocks: Block[] = Array.isArray(rawContent)
      ? (rawContent as Block[])
      : typeof rawContent === "string"
        ? [{ type: "text", text: rawContent }]
        : [];

    if (sm.type === "assistant") {
      const parts: OmpPart[] = [];
      for (const b of blocks) {
        if (b.type === "thinking") parts.push({ type: "thinking", thinking: String(b.thinking ?? "") });
        else if (b.type === "text") parts.push({ type: "text", text: String(b.text ?? "") });
        else if (b.type === "tool_use") {
          const id = String(b.id ?? "");
          const name = String(b.name ?? "");
          toolNames.set(id, name);
          parts.push({ type: "toolCall", id, name, arguments: (b.input ?? {}) as Record<string, unknown> });
        }
      }
      const usage = usageOf(message);
      if (parts.length || usage) out.push({ role: "assistant", content: parts, ...(usage ? { usage } : {}) });
      continue;
    }

    // sm.type === "user": a plain prompt (text) and/or a batch of tool_result blocks. Text
    // becomes one user message; each tool_result becomes its own toolResult message so the
    // reducer pairs it to the matching pending row by tool_use id.
    const textParts = blocks.filter((b) => b.type === "text").map((b) => ({ type: "text", text: String(b.text ?? "") }));
    if (textParts.length) out.push({ role: "user", content: textParts });
    for (const b of blocks) {
      if (b.type !== "tool_result") continue;
      const toolCallId = String(b.tool_use_id ?? "");
      out.push({
        role: "toolResult",
        toolCallId,
        ...(toolNames.get(toolCallId) ? { toolName: toolNames.get(toolCallId) } : {}),
        isError: b.is_error === true,
        content: [{ type: "text", text: resultText(b.content) }],
      });
    }
  }
  return out;
}
