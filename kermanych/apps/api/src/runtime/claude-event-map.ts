import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { RpcEvent } from "@kermanych/core";

// Carried across messages within one query() lifetime: whether an assistant turn has been
// opened (so a single message_start precedes the first delta), and the tool name recorded
// per tool_use id (claude's tool_result repeats only the id).
export interface ClaudeMapState {
  turnOpen: boolean;
  toolNames: Map<string, string>;
}
export function initClaudeMapState(): ClaudeMapState {
  return { turnOpen: false, toolNames: new Map() };
}

// Sum a result's per-model usage into the single accounting shape message_end carries.
function sumUsage(modelUsage: Record<string, {
  inputTokens?: number; outputTokens?: number; cacheReadInputTokens?: number; cacheCreationInputTokens?: number; costUSD?: number;
}>): { input: number; output: number; cacheRead: number; cacheWrite: number; cost: { total: number } } {
  let input = 0, output = 0, cacheRead = 0, cacheWrite = 0, cost = 0;
  for (const u of Object.values(modelUsage ?? {})) {
    input += u.inputTokens ?? 0;
    output += u.outputTokens ?? 0;
    cacheRead += u.cacheReadInputTokens ?? 0;
    cacheWrite += u.cacheCreationInputTokens ?? 0;
    cost += u.costUSD ?? 0;
  }
  return { input, output, cacheRead, cacheWrite, cost: { total: cost } };
}

function openTurn(st: ClaudeMapState, out: RpcEvent[]): void {
  if (!st.turnOpen) { st.turnOpen = true; out.push({ type: "message_start" }); }
}

export function mapSdkMessage(msg: SDKMessage, st: ClaudeMapState): RpcEvent[] {
  const out: RpcEvent[] = [];
  const m = msg as Record<string, unknown> & { type: string };

  if (m.type === "system") {
    if ((m as { subtype?: string }).subtype === "init") out.push({ type: "ready", protocolVersion: 2 });
    return out;
  }

  if (m.type === "stream_event") {
    const ev = (m as { event?: { type?: string; delta?: { type?: string; text?: string } } }).event;
    if (ev?.type === "content_block_delta" && ev.delta?.type === "text_delta" && typeof ev.delta.text === "string") {
      openTurn(st, out);
      out.push({ type: "message_update", assistantMessageEvent: { type: "text", delta: ev.delta.text } });
    }
    return out;
  }

  if (m.type === "assistant") {
    const content = ((m as { message?: { content?: unknown } }).message?.content ?? []) as Array<Record<string, unknown>>;
    openTurn(st, out);
    for (const block of Array.isArray(content) ? content : []) {
      if (block.type === "tool_use") {
        const id = String(block.id ?? "");
        const name = String(block.name ?? "");
        st.toolNames.set(id, name);
        out.push({ type: "tool_execution_start", toolName: name, toolCallId: id, args: (block.input ?? {}) as Record<string, unknown> });
      }
    }
    return out;
  }

  if (m.type === "user") {
    const content = ((m as { message?: { content?: unknown } }).message?.content ?? []) as Array<Record<string, unknown>>;
    for (const block of Array.isArray(content) ? content : []) {
      if (block.type === "tool_result") {
        const id = String(block.tool_use_id ?? "");
        const text = typeof block.content === "string" ? block.content : JSON.stringify(block.content ?? "");
        out.push({
          type: "tool_execution_end",
          toolName: st.toolNames.get(id) ?? "",
          toolCallId: id,
          isError: block.is_error === true,
          result: { content: [{ type: "text", text }] },
        });
      }
    }
    return out;
  }

  if (m.type === "result") {
    const r = m as { model?: string; duration_ms?: number; modelUsage?: Record<string, never> };
    const model = r.model ?? Object.keys(r.modelUsage ?? {})[0];
    out.push({ type: "message_end", message: {
      ...(model ? { model } : {}),
      ...(typeof r.duration_ms === "number" ? { duration: r.duration_ms } : {}),
      usage: sumUsage(r.modelUsage ?? {}),
    } });
    out.push({ type: "agent_end", isTerminal: true });
    st.turnOpen = false;
    return out;
  }

  return out; // other SDK message kinds are not surfaced this increment
}
