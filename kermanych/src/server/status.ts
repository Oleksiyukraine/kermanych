// src/server/status.ts
import type { RpcEvent, SessionStatus } from "./types";

export type StatusState = { status: SessionStatus; currentTool?: string; prior?: SessionStatus };
export const INITIAL_STATUS: StatusState = { status: "queued" };
const INTERACTIVE_UI_METHODS: Record<string, true> = { select: true, confirm: true, input: true, editor: true };

export function reduceStatus(s: StatusState, e: RpcEvent): StatusState {
  switch (e.type) {
    case "agent_start":
    case "turn_start":
    case "message_start":
    case "message_update":
    case "message_end":
      return { status: "thinking" };
    case "tool_execution_start": {
      const toolName = "toolName" in e && typeof e.toolName === "string" ? e.toolName : undefined;
      return { status: "tool", currentTool: toolName };
    }
    case "tool_execution_end":
      return { status: "thinking" };
    case "extension_ui_request": {
      const method = "method" in e && typeof e.method === "string" ? e.method : undefined;
      return method !== undefined && INTERACTIVE_UI_METHODS[method] === true
        ? { status: "waiting_input", prior: s.status === "waiting_input" ? s.prior : s.status }
        : s;
    }
    case "agent_end": {
      const isTerminal = "isTerminal" in e ? e.isTerminal : undefined;
      return isTerminal === false ? s : { status: "done" };
    }
    default:
      return s;
  }
}
